/**
 * /api/site-map-get.js
 *
 * Read-only endpoint to fetch a site_map with its pages, grouped by category.
 * Used by the configurator UI on load.
 *
 * GET query params: ?site_map_id=<uuid>
 * Auth: admin JWT (phase 2). Phase 3 will add page-token scope for the
 * client-facing configurator embed.
 *
 * Returns:
 *   {
 *     site_map: { id, source_type, status, root_url, ... },
 *     plan_limits: { home: 1, service: 5, ... },
 *     pages_by_category: {
 *       home:    [ { id, status, title, url, notes, display_order, ... } ],
 *       service: [ ... ],
 *       bio:     [ { ..., bio_material_id, bio_material: { therapist_name, professional_bio, ... } } ]
 *     },
 *     counts: {
 *       home:    { active: 1, removed: 0, cap: 1 },
 *       service: { active: 3, removed: 1, cap: 5 },
 *       ...
 *     }
 *   }
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');

var PLAN_LIMITS = {
  core_existing: { home: 1, service: 5, location: 2, faq: 1, bio: 10, contact: 1 },
  core_new:      { home: 1, service: 5, location: 1, faq: 1, bio: 10, contact: 1 },
  standalone:    { home: 1, service: 5, location: 1, faq: 1, bio: 10, contact: 1 }
};

var REMOVED_STATUSES = ['existing_remove'];
// Pages that count toward the plan cap. Discovered pages are inventory awaiting
// triage and don't count; once the admin/client commits to keep/update/draft/new
// they enter the highlighted set.
var HIGHLIGHTED_STATUSES = ['existing_keep', 'existing_update', 'new', 'drafting'];

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth: admin JWT OR onboarding page-token ─────────────────────
  // Request shape determines which path we take:
  //  - If an onboarding page-token cookie is present, treat as client call.
  //  - Otherwise, require admin JWT.
  // Page-token callers are constrained to their own contact_id; they cannot
  // read another client's site_map by passing its id in the query.
  var isAdmin = false;
  var verifiedContactId = null;

  var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
  if (tokenStr) {
    var tokenData;
    try { tokenData = pageToken.verify(tokenStr, 'onboarding'); }
    catch (e) {
      console.error('[site-map-get] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
    verifiedContactId = tokenData.contact_id;
  } else {
    // No page-token — this must be an admin request. requireAdmin writes
    // the response on failure, so just return.
    var user = await auth.requireAdmin(req, res);
    if (!user) return;
    isAdmin = true;
  }

  var siteMapId = req.query && req.query.site_map_id;
  var slug = req.query && req.query.slug;

  try {
    // Resolve site_map_id from slug when provided. Returns the most recent
    // non-abandoned site_map for that contact.
    if (!siteMapId && slug && /^[a-z0-9-]+$/.test(slug)) {
      var contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id&limit=1');
      if (!contact) return res.status(404).json({ error: 'Contact not found for slug' });
      // Page-token callers may only resolve to their own contact's site_map.
      if (!isAdmin && contact.id !== verifiedContactId) {
        return res.status(403).json({ error: 'Not authorized for this client' });
      }
      var sm = await sb.one(
        'site_maps?contact_id=eq.' + contact.id
        + '&status=neq.abandoned&select=id&order=created_at.desc&limit=1'
      );
      if (!sm) return res.status(404).json({ error: 'No site_map for this client yet', code: 'no_site_map' });
      siteMapId = sm.id;
    }

    if (!isUuid(siteMapId)) {
      return res.status(400).json({ error: 'site_map_id or slug query param required' });
    }
    var siteMap = await sb.one(
      'site_maps?id=eq.' + siteMapId
      + '&select=id,contact_id,anonymous_session_id,source_type,status,root_url,'
      + 'mvp_locked_at,fully_locked_at,launched_at,addon_count,addon_total_cents,'
      + 'addon_invoice_status,sitemap_scout_id,created_at,updated_at'
    );
    if (!siteMap) return res.status(404).json({ error: 'site_map not found' });

    // Page-token: enforce binding to own contact_id.
    if (!isAdmin && siteMap.contact_id !== verifiedContactId) {
      return res.status(403).json({ error: 'Not authorized for this site_map' });
    }

    var pages = await sb.query(
      'site_map_pages?site_map_id=eq.' + siteMapId
      + '&select=id,category,status,title,notes,url,display_order,intake_status,'
      + 'bio_material_id,addon_price_cents,created_at,updated_at'
      + '&order=category,display_order'
    );
    pages = pages || [];

    // If any pages have bio_material_id set, hydrate those rows in one call.
    var bioIds = pages
      .filter(function(p) { return p.bio_material_id; })
      .map(function(p) { return p.bio_material_id; });
    var bioById = {};
    if (bioIds.length) {
      // PostgREST in=(...) with UUIDs
      var inList = bioIds.map(encodeURIComponent).join(',');
      var bios = await sb.query(
        'bio_materials?id=in.(' + inList + ')'
        + '&select=id,therapist_name,therapist_credentials,is_primary,status,professional_bio,sort_order'
      );
      (bios || []).forEach(function(b) { bioById[b.id] = b; });
    }

    // Group by category, hydrate bio material
    var pagesByCategory = {};
    var counts = {};
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      var cat = p.category;
      if (!pagesByCategory[cat]) pagesByCategory[cat] = [];

      var enriched = {
        id: p.id,
        status: p.status,
        title: p.title,
        notes: p.notes,
        url: p.url,
        display_order: p.display_order,
        intake_status: p.intake_status,
        bio_material_id: p.bio_material_id,
        addon_price_cents: p.addon_price_cents
      };
      if (p.bio_material_id && bioById[p.bio_material_id]) {
        var bm = bioById[p.bio_material_id];
        enriched.bio_material = {
          therapist_name: bm.therapist_name,
          therapist_credentials: bm.therapist_credentials,
          is_primary: bm.is_primary,
          status: bm.status,
          has_bio: !!bm.professional_bio
        };
      }
      pagesByCategory[cat].push(enriched);

      if (!counts[cat]) counts[cat] = { active: 0, removed: 0, highlighted: 0, discovered: 0, cap: null };
      if (REMOVED_STATUSES.indexOf(p.status) !== -1) counts[cat].removed += 1;
      else counts[cat].active += 1;
      if (HIGHLIGHTED_STATUSES.indexOf(p.status) !== -1) counts[cat].highlighted += 1;
      if (p.status === 'discovered') counts[cat].discovered += 1;
    }

    // Decorate counts with the plan cap
    var limits = PLAN_LIMITS[siteMap.source_type] || {};
    Object.keys(counts).forEach(function(cat) {
      if (limits[cat] !== undefined) counts[cat].cap = limits[cat];
    });

    return res.json({
      site_map: siteMap,
      plan_limits: limits,
      pages_by_category: pagesByCategory,
      counts: counts
    });

  } catch (err) {
    console.error('site-map-get error:', err);
    monitor.logError('site-map-get', err, {
      detail: { stage: 'handler', site_map_id: siteMapId }
    });
    return res.status(500).json({ error: 'Failed to load site_map' });
  }
};
