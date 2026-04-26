// /api/render-page-preview.js
// Renders a content_page to full HTML using the v2 template + content_jsonb pipeline.
// Single source of truth for: admin preview, client review page, and R2/CMS deploy.
//
// GET  /api/render-page-preview?page_id=<uuid>           — admin (requires admin auth)
// GET  /api/render-page-preview?slug=<slug>&path=<path>  — public (page-token auth, scope=content_preview)
//
// v1 fallback: pages with template_version='v1' return their generated_html as-is.
// v2: load template file, load content_jsonb + design_spec + partials → render.
//
// Output: text/html. No streaming (templates are fast, ~10-50ms render).

var fs = require('fs');
var path = require('path');
var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');
var pageTypes = require('./_lib/page-types');
var tplRender = require('./_lib/template-render');

// Templates and partials live in /_templates/page-types/ and /_templates/partials/
// In Vercel serverless, files are bundled — we read from the deployed file path.
var TEMPLATE_DIR = path.join(process.cwd(), '_templates', 'page-types');
var PARTIAL_DIR = path.join(process.cwd(), '_templates', 'partials');

// Cache template + partial reads in module scope. Vercel functions stay warm
// for ~minutes, so this avoids re-reading from disk on every request.
var templateCache = {};
var partialsCache = null;

function loadTemplate(typeName) {
  if (templateCache[typeName]) return templateCache[typeName];
  var spec = pageTypes.get(typeName);
  if (!spec) throw new Error('Unknown page type: ' + typeName);
  var fp = path.join(TEMPLATE_DIR, spec.template + '.html');
  if (!fs.existsSync(fp)) throw new Error('Template file not found: ' + spec.template);
  var contents = fs.readFileSync(fp, 'utf8');
  templateCache[typeName] = contents;
  return contents;
}

function loadPartials() {
  if (partialsCache) return partialsCache;
  var partials = {};
  if (fs.existsSync(PARTIAL_DIR)) {
    var files = fs.readdirSync(PARTIAL_DIR);
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.endsWith('.html')) {
        var name = f.replace(/\.html$/, '');
        partials[name] = fs.readFileSync(path.join(PARTIAL_DIR, f), 'utf8');
      }
    }
  }
  partialsCache = partials;
  return partials;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var q = req.query || {};
  var pageId = q.page_id;
  var slug = q.slug;
  var pagePath = q.path;
  var asJson = q.format === 'json';  // for admin preview to fetch render output as data

  try {
    var page = null;
    var authMode = null;

    if (pageId) {
      // Admin path: requireAdmin gate
      var user = await auth.requireAdmin(req, res);
      if (!user) return;  // requireAdmin already wrote response
      authMode = 'admin';
      // UUID guard before PostgREST concat
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
        return res.status(400).json({ error: 'Invalid page_id' });
      }
      page = await sb.one('content_pages?id=eq.' + encodeURIComponent(pageId) + '&limit=1');
    } else if (slug && pagePath) {
      // Public path: page token gate
      var tokenData = pageToken.getTokenFromRequest(req, 'content_preview');
      if (!tokenData) return res.status(401).json({ error: 'Token required' });
      authMode = 'public';
      // Slug + path lookup
      var encSlug = encodeURIComponent(slug);
      var encPath = encodeURIComponent(pagePath);
      page = await sb.one(
        'content_pages?client_slug=eq.' + encSlug +
        '&page_slug=eq.' + encPath +
        '&limit=1'
      );
      // Token must match the contact who owns the page
      if (page && tokenData.contact_id !== page.contact_id) {
        return res.status(403).json({ error: 'Token scope mismatch' });
      }
    } else {
      return res.status(400).json({ error: 'page_id or (slug + path) required' });
    }

    if (!page) return res.status(404).json({ error: 'Page not found' });

    // v1 fallback: just return generated_html
    if (page.template_version === 'v1' || !page.template_version) {
      if (!page.generated_html) {
        return res.status(404).send('<h1>Page not yet generated</h1>');
      }
      if (asJson) {
        return res.status(200).json({
          template_version: 'v1',
          html: page.generated_html,
          page: { id: page.id, page_type: page.page_type, page_name: page.page_name },
        });
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(page.generated_html);
    }

    // v2 path: load template, content_jsonb, design_spec, contact, neo_image
    var encContactId = encodeURIComponent(page.contact_id);
    var deps = await Promise.all([
      sb.query('contacts?id=eq.' + encContactId + '&limit=1'),
      sb.query('design_specs?contact_id=eq.' + encContactId + '&limit=1'),
      sb.query('practice_details?contact_id=eq.' + encContactId + '&limit=1'),
      page.neo_image_id
        ? sb.query('neo_images?id=eq.' + encodeURIComponent(page.neo_image_id) + '&limit=1')
        : Promise.resolve([]),
      page.bio_material_id
        ? sb.query('bio_materials?id=eq.' + encodeURIComponent(page.bio_material_id) + '&limit=1')
        : Promise.resolve([]),
      // Nav + footer source: all of this contact's nav-visible / footer-visible pages.
      // target_keyword is pulled so the homepage template can build a "Services
      // we offer" section without an extra query. Per-service summaries live
      // inside content_jsonb and would require a heavier select; the template
      // falls back to page_name as the card label and target_keyword as a
      // simple sub-label.
      sb.query(
        'content_pages?contact_id=eq.' + encContactId +
        '&select=id,page_type,page_name,page_slug,target_keyword,nav_visible,nav_label,nav_section,nav_order,footer_visible,footer_section' +
        '&order=nav_order.asc.nullslast,page_name.asc'
      ),
      // Bio materials list — used for nav (Our Team / individual bios sub-items)
      // and the homepage team grid. Extra fields are cheap; render uses what
      // it needs.
      sb.query(
        'bio_materials?contact_id=eq.' + encContactId +
        '&order=is_primary.desc,sort_order.asc.nullslast,therapist_name.asc' +
        '&select=id,therapist_name,therapist_credentials,headshot_url,slug,professional_bio,sort_order,is_primary,page_url'
      ),
      // Endorsements — loaded for bio + homepage pages.
      //   bio:      filter to this clinician's where scope is bio_only/both
      //   homepage: filter to scope homepage_only/both
      // Done in buildRenderData so we don't double-query.
      (page.page_type === 'bio' || page.page_type === 'homepage')
        ? sb.query(
            'endorsements?contact_id=eq.' + encContactId +
            '&status=eq.approved' +
            '&order=sort_order.asc.nullslast,submitted_at.desc'
          )
        : Promise.resolve([]),
    ]);

    var contact = (deps[0] && deps[0][0]) || null;
    var spec = (deps[1] && deps[1][0]) || null;
    var practice = (deps[2] && deps[2][0]) || null;
    var neoImage = (deps[3] && deps[3][0]) || null;
    var bioMaterial = (deps[4] && deps[4][0]) || null;
    var allPages = deps[5] || [];
    var bioList = deps[6] || [];
    var endorsementsAll = deps[7] || [];

    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost === true || contact.status === 'lost') {
      return res.status(404).json({ error: 'Page not available' });
    }

    // Build the data object passed to the template
    var data = buildRenderData({
      page: page,
      contact: contact,
      spec: spec,
      practice: practice,
      neoImage: neoImage,
      bioMaterial: bioMaterial,
      allPages: allPages,
      bioList: bioList,
      endorsements: endorsementsAll,
    });

    // Render
    var template = loadTemplate(page.page_type);
    var partials = loadPartials();
    var html;
    try {
      html = tplRender.render(template, data, partials);
    } catch (renderErr) {
      monitor.logError('render-page-preview', renderErr, {
        client_slug: page.client_slug,
        detail: { stage: 'template_render', page_id: page.id, page_type: page.page_type },
      });
      return res.status(500).send('<h1>Render error</h1><p>The page could not be rendered.</p>');
    }

    if (asJson) {
      return res.status(200).json({
        template_version: 'v2',
        html: html,
        page: { id: page.id, page_type: page.page_type, page_name: page.page_name, page_slug: page.page_slug },
        data: data,  // useful for admin UI debug
      });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(html);

  } catch (err) {
    monitor.logError('render-page-preview', err, {
      detail: { stage: 'render_handler', page_id: pageId, slug: slug, path: pagePath },
    });
    return res.status(500).json({ error: 'Render failed' });
  }
};

// Compose the data shape that templates consume.
// This is the contract between content_jsonb shape and template variables.
function buildRenderData(args) {
  var page = args.page;
  var contact = args.contact;
  var spec = args.spec || {};
  var practice = args.practice || {};
  var neoImage = args.neoImage;
  var bioMaterial = args.bioMaterial;
  var allPages = args.allPages || [];
  var bioList = args.bioList || [];
  var endorsementsAll = args.endorsements || [];

  var content = page.content_jsonb || {};
  decorateContent(content);
  var nav = buildNav(allPages, bioList, contact);
  var footer = buildFooter(allPages, contact);

  // Bio-page endorsements: only this clinician's, where display_scope
  // includes the bio (bio_only or both). Practice-wide endorsements with
  // display_scope='homepage_only' are explicitly excluded — they belong on
  // the homepage, not bios.
  var pageEndorsements = [];
  if (page.page_type === 'bio' && page.bio_material_id) {
    pageEndorsements = endorsementsAll
      .filter(function (e) {
        if (e.bio_material_id !== page.bio_material_id) return false;
        var scope = e.display_scope || 'bio_only';
        return scope === 'bio_only' || scope === 'both';
      })
      .map(normalizeEndorsement);
  } else if (page.page_type === 'homepage') {
    // Homepage endorsements: scope homepage_only or both, ordered by
    // homepage_sort_order then submitted_at desc as a tiebreaker.
    pageEndorsements = endorsementsAll
      .filter(function (e) {
        var scope = e.display_scope || 'bio_only';
        return scope === 'homepage_only' || scope === 'both';
      })
      .sort(function (a, b) {
        var aOrder = a.homepage_sort_order;
        var bOrder = b.homepage_sort_order;
        if (aOrder == null && bOrder == null) return 0;
        if (aOrder == null) return 1;
        if (bOrder == null) return -1;
        return aOrder - bOrder;
      })
      .map(normalizeEndorsement);
  }

  // Homepage-specific context: services list, team grid, location summary.
  // For non-home pages this just isn't used; the lookup is cheap.
  var homeContext = null;
  if (page.page_type === 'homepage') {
    var services = (allPages || [])
      .filter(function (p) { return p.page_type === 'service' && p.nav_visible; })
      .map(function (p) {
        return {
          name: p.page_name || p.target_keyword || '',
          slug: p.page_slug || '',
          keyword: p.target_keyword || '',
          url: p.page_slug ? ('/' + contact.slug + '/' + p.page_slug) : '#',
        };
      });

    var team = (bioList || []).map(function (b) {
      var nm = b.therapist_name || '';
      var parts = nm.trim().split(/\s+/).filter(Boolean);
      var initials = '?';
      if (parts.length >= 2) {
        initials = (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
      } else if (parts.length === 1) {
        initials = parts[0].charAt(0).toUpperCase();
      }
      return {
        id: b.id,
        name: nm,
        initial: initials,    // 1-2 char fallback for headshot-less team cards
        credentials: b.therapist_credentials || '',
        headshot_url: b.headshot_url || '',
        slug: b.slug || '',
        url: b.page_url || (b.slug ? ('/' + contact.slug + '/' + b.slug) : '#'),
        // Bio snippet — first ~180 chars of professional_bio, clipped at a
        // word boundary. The home grid is teaser-only; clicking goes to bio.
        snippet: clipText(b.professional_bio || '', 180),
        is_primary: !!b.is_primary,
      };
    });

    homeContext = {
      services: services,
      services_count: services.length,
      has_services: services.length > 0,
      team: team,
      team_count: team.length,
      has_team: team.length > 0,
      // Practice address as a single coherent location object — the template
      // can render this as the only location, or as the "headquarters" if
      // multi-location is added later via a locations table.
      primary_location: {
        line1: contact.practice_address_line1 || '',
        line2: contact.practice_address_line2 || '',
        city: contact.city || '',
        state: contact.state_province || '',
        postal_code: contact.postal_code || '',
        country: contact.country || '',
        full: [
          contact.practice_address_line1,
          contact.practice_address_line2,
          [contact.city, contact.state_province].filter(Boolean).join(', '),
          contact.postal_code,
        ].filter(Boolean).join(', '),
        has_address: !!(contact.practice_address_line1 || contact.city),
      },
    };
  }

  // then a plain URL CTA. Template renders embed when has_embed, otherwise
  // a button to url when has_url.
  var bioEmbed = bioMaterial && bioMaterial.booking_embed;
  var practiceEmbed = practice && practice.ehr_booking_embed;
  var practiceUrl = practice && practice.booking_url;
  var booking = {
    has_embed: !!(bioEmbed || practiceEmbed),
    embed: bioEmbed || practiceEmbed || '',
    has_url: !!practiceUrl,
    url: practiceUrl || '',
  };

  return {
    // Page metadata
    page: {
      id: page.id,
      type: page.page_type,
      name: page.page_name,
      slug: page.page_slug,
      target_keyword: page.target_keyword || '',
    },

    // SEO + meta
    seo: {
      title: content.seo_title || (content.hero && content.hero.heading) || page.page_name,
      description: content.seo_description || '',
      canonical: content.canonical || '',
    },

    // Practice context
    practice: {
      name: contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim(),
      legal_name: contact.legal_business_name || '',
      slug: contact.slug,
      phone: contact.phone || practice.phone || '',
      email: contact.email || '',
      city: contact.city || '',
      state: contact.state_province || '',
      address_line1: contact.practice_address_line1 || '',
      address_line2: contact.practice_address_line2 || '',
      postal_code: contact.postal_code || '',
      country: contact.country || 'USA',
      website_url: contact.website_url || '',
      gbp_url: contact.gbp_url || '',
      gbp_share_link: contact.gbp_share_link || '',
      logo_url: contact.logo_url || '',
    },

    // Design tokens (escaped — used in <style> blocks via {{{...}}})
    design: {
      colors: spec.color_palette || {},
      typography: spec.typography || {},
      buttons: spec.button_styles || {},
      voice: spec.voice_dna || {},
      // Pre-compute the inline CSS variables block for the template
      css_variables: buildCssVariables(spec),
    },

    // Page content (whatever the template type expects under content_jsonb)
    content: content,
    // Common content sections, hoisted for convenience in templates.
    //
    // Hero image fallback for solo practices: if no hero.image_url is set
    // AND the practice has exactly one bio AND that bio has a headshot, use
    // the headshot as the hero image. The clinician *is* the practice for
    // solo, so showing their face makes the hero feel real instead of
    // half-built. Multi-clinician practices skip this — no single "face"
    // captures the whole team, and a headshot would be misleading.
    hero: (function () {
      var h = Object.assign({}, content.hero || {});
      if (!h.image_url && (bioList || []).length === 1) {
        var primary = bioList[0];
        if (primary && primary.headshot_url) {
          h.image_url = primary.headshot_url;
          h.image_alt = primary.therapist_name || '';
          h.image_is_clinician = true;
        }
      }
      h.has_image = !!h.image_url;
      return h;
    })(),
    sections: content.sections || [],
    body_html: content.body_html || '',  // rich text, rendered via {{{body_html}}}
    cta: content.cta || {},

    // FAQs (per-page, separate from general FAQ page)
    faqs: page.faqs || [],

    // NEO image (service pages only)
    neo_image: neoImage ? {
      id: neoImage.id,
      hosted_url: neoImage.composite_url || neoImage.hosted_url,
      alt_text: (page.page_name + ' — ' + (contact.practice_name || '')).trim(),
      keyword: neoImage.keyword || page.target_keyword || '',
    } : null,

    // Bio material (bio pages only)
    bio: bioMaterial ? buildBioContext(bioMaterial) : null,

    // Booking (bio pages — embed vs CTA fallback)
    booking: booking,

    // Endorsements (bio pages — filtered to this clinician + practice-level;
    // homepage — filtered to scope homepage_only/both, sorted by homepage_sort_order)
    endorsements: pageEndorsements,
    has_endorsements: pageEndorsements.length > 0,

    // Homepage-specific context (services, team, primary location).
    // null on non-home pages so templates can defensively check truthy.
    home: homeContext,

    // JSON-LD schema (rendered raw inside <script type="application/ld+json">)
    schema_jsonb: page.schema_jsonb || null,
    schema_json: page.schema_jsonb ? JSON.stringify(page.schema_jsonb, null, 2) : '',

    // Nav + footer for partials
    nav: nav,
    footer: footer,
  };
}

// Build navigation structure from this contact's nav-visible pages, applying
// the rules engine we agreed in the nav discussion:
//   - 1 location: footer only, no nav item
//   - 2+ locations: Locations dropdown
//   - Solo (1 bio): About flat link → that bio
//   - 2-5 bios: About dropdown with About Us + each bio
//   - 6+ bios: About dropdown with About Us + Our Team grid (link)
//   - 1 custom page: flat resource link
//   - 2+ custom pages: Resources dropdown
//   - FAQ: flat top-level
//   - Contact: far right
function buildNav(allPages, bioList, contact) {
  var pages = (allPages || []).filter(function(p) { return p.nav_visible !== false; });

  // Bucket by section
  var byType = {};
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i];
    if (!byType[p.page_type]) byType[p.page_type] = [];
    byType[p.page_type].push(p);
  }

  var services = byType.service || [];
  var locations = byType.location || [];
  var customs = byType.custom || [];
  var aboutUs = (byType.about_us || [])[0] || null;
  var faq = (byType.faq_general || byType.faq || [])[0] || null;
  var contactPage = (byType.contact || [])[0] || null;

  var bios = bioList || [];
  var teamSize = bios.length;

  var items = [];

  // Services dropdown (always show if 1+, individual link if 1, dropdown if 2+)
  if (services.length === 1) {
    items.push({ kind: 'link', label: navLabel(services[0]), href: '/' + services[0].page_slug });
  } else if (services.length > 1) {
    items.push({
      kind: 'dropdown',
      label: 'Services',
      children: services.map(function(s) {
        return { label: navLabel(s), href: '/' + s.page_slug };
      }),
    });
  }

  // About / bios
  if (teamSize === 1 && bios[0]) {
    // Solo practice: flat About link → bio page
    items.push({
      kind: 'link',
      label: bios[0].therapist_name ? 'About ' + firstName(bios[0].therapist_name) : 'About',
      href: bios[0].page_url || ('/about'),
    });
  } else if (teamSize >= 2 && teamSize <= 5) {
    // Group: About dropdown with About Us + each bio
    var aboutChildren = [];
    if (aboutUs) aboutChildren.push({ label: 'About Us', href: '/' + aboutUs.page_slug });
    for (var b = 0; b < bios.length; b++) {
      aboutChildren.push({
        label: bios[b].therapist_name || 'Clinician',
        href: bios[b].page_url || ('/' + slugify(bios[b].therapist_name || 'clinician')),
      });
    }
    items.push({ kind: 'dropdown', label: 'About', children: aboutChildren });
  } else if (teamSize >= 6) {
    // Large group: About dropdown with About Us + Our Team grid
    var bigChildren = [];
    if (aboutUs) bigChildren.push({ label: 'About Us', href: '/' + aboutUs.page_slug });
    bigChildren.push({ label: 'Our Team', href: '/team' });
    items.push({ kind: 'dropdown', label: 'About', children: bigChildren });
  }

  // Locations
  if (locations.length >= 2) {
    items.push({
      kind: 'dropdown',
      label: 'Locations',
      children: locations.map(function(l) {
        return { label: navLabel(l), href: '/' + l.page_slug };
      }),
    });
  }

  // Resources / custom pages
  if (customs.length === 1) {
    items.push({ kind: 'link', label: navLabel(customs[0]), href: '/' + customs[0].page_slug });
  } else if (customs.length >= 2) {
    items.push({
      kind: 'dropdown',
      label: 'Resources',
      children: customs.map(function(c) {
        return { label: navLabel(c), href: '/' + c.page_slug };
      }),
    });
  }

  // FAQ flat link
  if (faq) items.push({ kind: 'link', label: 'FAQ', href: '/' + faq.page_slug });

  // Contact (always far right)
  var ctaItem = null;
  if (contactPage) {
    ctaItem = { label: 'Contact', href: '/' + contactPage.page_slug };
  }

  return {
    practice_name: contact.practice_name || '',
    logo_url: contact.logo_url || '',
    items: items,
    cta: ctaItem,
  };
}

// Build footer from same pages (footer_visible) + legal section
function buildFooter(allPages, contact) {
  var pages = (allPages || []).filter(function(p) { return p.footer_visible !== false; });
  var main = [];
  var legal = [];
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i];
    var entry = { label: navLabel(p), href: '/' + p.page_slug };
    if (p.footer_section === 'legal') legal.push(entry);
    else main.push(entry);
  }
  return {
    main: main,
    legal: legal,
    practice_name: contact.practice_name || '',
    address: [
      contact.practice_address_line1,
      contact.city + (contact.state_province ? ', ' + contact.state_province : ''),
      contact.postal_code,
    ].filter(Boolean).join(' • '),
    phone: contact.phone || '',
    email: contact.email || '',
    year: new Date().getFullYear(),
    powered_by: true,
  };
}

function navLabel(p) {
  return p.nav_label || p.page_name || '';
}

function firstName(full) {
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0];
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Generate a CSS :root block from design_spec tokens.
// Returned as raw HTML — template uses {{{design.css_variables}}}.
function buildCssVariables(spec) {
  if (!spec) return '';
  var c = spec.color_palette || {};
  var t = spec.typography || {};
  var b = spec.button_styles || {};
  var lines = [':root {'];
  // Colors
  Object.keys(c).forEach(function(k) {
    if (typeof c[k] === 'string') {
      lines.push('  --color-' + k.replace(/_/g, '-') + ': ' + c[k] + ';');
    }
  });
  // Typography
  if (t.body_font)    lines.push('  --font-body: ' + t.body_font + ', system-ui, sans-serif;');
  if (t.heading_font) lines.push('  --font-heading: ' + t.heading_font + ', system-ui, sans-serif;');
  if (t.body_size)    lines.push('  --font-body-size: ' + t.body_size + ';');
  if (t.line_height)  lines.push('  --line-height: ' + t.line_height + ';');
  if (t.heading_sizes) {
    Object.keys(t.heading_sizes).forEach(function(h) {
      lines.push('  --font-' + h + ': ' + t.heading_sizes[h] + ';');
    });
  }
  // Buttons
  if (b.radius)  lines.push('  --btn-radius: ' + b.radius + ';');
  if (b.padding) lines.push('  --btn-padding: ' + b.padding + ';');
  if (b.font_weight) lines.push('  --btn-font-weight: ' + b.font_weight + ';');
  lines.push('}');
  return lines.join('\n');
}

module.exports.buildRenderData = buildRenderData;
module.exports.buildCssVariables = buildCssVariables;

// Bio-specific precomputation. Templates have no helpers, so we shape the
// data here: initials for fallback hero, presence flags for conditional
// blocks, normalized arrays for {{#each}} iteration.
function buildBioContext(bio) {
  if (!bio) return null;

  var name = bio.therapist_name || '';
  var parts = name.trim().split(/\s+/);
  var initials = '';
  if (parts.length >= 2) {
    initials = (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  } else if (parts.length === 1 && parts[0]) {
    initials = parts[0].charAt(0).toUpperCase();
  }

  // Normalize jsonb arrays — they come back as arrays of strings from PostgREST
  // for license/education/cert/association/awards. Wrap each in { value } so
  // {{#each}} can render them as <li>{{value}}</li>.
  function asList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (s) { return s && typeof s === 'string'; })
            .map(function (s) { return { value: s }; });
  }

  var licenses = asList(bio.license_details);
  var education = asList(bio.education_details);
  var certifications = asList(bio.certification_details);
  var associations = asList(bio.association_details);
  var media = asList(bio.media_publications);

  return {
    id: bio.id,
    name: name,
    credentials: bio.therapist_credentials || '',
    initials: initials,
    is_primary: !!bio.is_primary,
    headshot_url: bio.headshot_url || '',
    has_headshot: !!bio.headshot_url,
    professional_bio: bio.professional_bio || '',
    has_bio: !!bio.professional_bio,
    clinical_approach: bio.clinical_approach || '',
    has_approach: !!bio.clinical_approach,
    awards: bio.awards || '',
    has_awards: !!bio.awards,
    licenses: licenses,
    education: education,
    certifications: certifications,
    associations: associations,
    media: media,
    has_credentials: licenses.length + education.length + certifications.length + associations.length > 0,
    has_media: media.length > 0,
  };
}

module.exports.buildBioContext = buildBioContext;

// Normalize an endorsement record for template rendering. The endorser_links
// jsonb is expected as an ordered array of { kind, url, label? } objects.
// Recognized kinds: practice, psychology_today, linkedin, google_scholar,
// personal_site, other. Each gets a precomputed display label and a flag
// the template uses to pick the right icon.
var LINK_KINDS = {
  practice:         { label: 'Practice website', icon: 'globe' },
  psychology_today: { label: 'Psychology Today', icon: 'pt' },
  linkedin:         { label: 'LinkedIn',         icon: 'linkedin' },
  google_scholar:   { label: 'Google Scholar',   icon: 'scholar' },
  personal_site:    { label: 'Personal site',    icon: 'globe' },
  other:            { label: 'Profile',          icon: 'link' },
};

function normalizeEndorsement(e) {
  var rawLinks = Array.isArray(e.endorser_links) ? e.endorser_links : [];
  var links = rawLinks
    .filter(function (l) { return l && typeof l === 'object' && l.url; })
    .map(function (l) {
      var kind = LINK_KINDS[l.kind] ? l.kind : 'other';
      var spec = LINK_KINDS[kind];
      return {
        kind: kind,
        url: l.url,
        label: l.label || spec.label,
        icon: spec.icon,
        is_linkedin: kind === 'linkedin',
        is_psychology_today: kind === 'psychology_today',
        is_practice: kind === 'practice' || kind === 'personal_site',
        is_scholar: kind === 'google_scholar',
        is_other: kind === 'other',
      };
    });

  return {
    id: e.id,
    content: e.content || '',
    endorser_name: e.endorser_name || '',
    endorser_credentials: e.endorser_credentials || '',
    endorser_title: e.endorser_title || '',
    endorser_org: e.endorser_org || '',
    endorser_headshot_url: e.endorser_headshot_url || '',
    has_headshot: !!e.endorser_headshot_url,
    has_credentials: !!e.endorser_credentials,
    has_title: !!e.endorser_title,
    has_org: !!e.endorser_org,
    has_meta: !!(e.endorser_title || e.endorser_org),
    links: links,
    has_links: links.length > 0,
    is_verified: !!e.verified_at,
  };
}

module.exports.normalizeEndorsement = normalizeEndorsement;

// Word-boundary clip for teaser snippets (homepage team grid, service cards).
// Avoids cutting words mid-syllable. Returns a plain string with trailing
// ellipsis if the source was longer than maxLen.
function clipText(text, maxLen) {
  var s = String(text || '').replace(/<[^>]*>/g, '').trim();
  if (s.length <= maxLen) return s;
  var clipped = s.slice(0, maxLen);
  var lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) clipped = clipped.slice(0, lastSpace);
  return clipped.replace(/[.,;:\s]+$/, '') + '\u2026';
}

module.exports.clipText = clipText;

// Allowed icon names for value-section items. Anything not in this set is
// rendered as the generic check icon. Keep this list aligned with the
// homepage.html template's {{#if icon_X}}…{{/if}} branches.
var VALUE_ICONS = ['heart', 'shield', 'users', 'clock', 'book', 'compass'];

// Walk content_jsonb and normalize structures that the template can't
// derive on its own. Keeps the renderer a pure string substitutor and
// concentrates "shape" logic in one place.
//
// Today this handles:
//   content.process.steps[].number      – '01', '02' style display number
//   content.values.items[].icon_<name>  – truthy flag per icon name
//
// Mutates `content` in place. Safe on undefined sections.
function decorateContent(content) {
  if (!content || typeof content !== 'object') return;

  // Process steps: pad index to two digits for the numeric badge.
  if (content.process && Array.isArray(content.process.steps)) {
    content.process.steps.forEach(function (step, i) {
      if (!step || typeof step !== 'object') return;
      var n = i + 1;
      step.number = (n < 10 ? '0' : '') + n;
    });
  }

  // Value items: precompute icon_<name> flags. Falls back to icon_default
  // when the icon name is missing or unrecognized so the SVG slot is never
  // empty.
  if (content.values && Array.isArray(content.values.items)) {
    content.values.items.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var name = (item.icon || '').toLowerCase();
      if (VALUE_ICONS.indexOf(name) !== -1) {
        item['icon_' + name] = true;
      } else {
        item.icon_default = true;
      }
    });
  }
}

module.exports.decorateContent = decorateContent;
