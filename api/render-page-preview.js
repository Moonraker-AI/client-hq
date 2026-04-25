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
      // Nav + footer source: all of this contact's nav-visible / footer-visible pages
      sb.query(
        'content_pages?contact_id=eq.' + encContactId +
        '&select=id,page_type,page_name,page_slug,nav_visible,nav_label,nav_section,nav_order,footer_visible,footer_section' +
        '&order=nav_order.asc.nullslast,page_name.asc'
      ),
      // Bio materials list — used for nav (Our Team / individual bios sub-items)
      sb.query(
        'bio_materials?contact_id=eq.' + encContactId +
        '&order=is_primary.desc,sort_order.asc.nullslast,therapist_name.asc' +
        '&select=id,therapist_name,page_url,sort_order,is_primary'
      ),
      // Endorsements — only loaded for bio pages, filtered to this clinician
      // (bio_material_id matches) plus practice-level (bio_material_id is null).
      page.page_type === 'bio'
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
  }

  // Booking: prefer per-clinician embed, fall back to practice-level embed,
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
    // Common content sections, hoisted for convenience in templates
    hero: content.hero || {},
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

    // Endorsements (bio pages — filtered to this clinician + practice-level)
    endorsements: pageEndorsements,
    has_endorsements: pageEndorsements.length > 0,

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
