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

var PLAN_LIMITS = {
  core_existing: { home: 1, service: 5, location: 2, faq: 1, bio: 10, contact: 1 },
  core_new:      { home: 1, service: 5, location: 1, faq: 1, bio: 10, contact: 1 },
  standalone:    { home: 1, service: 5, location: 1, faq: 1, bio: 10, contact: 1 }
};

var REMOVED_STATUSES = ['existing_remove'];

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var siteMapId = req.query && req.query.site_map_id;
  if (!isUuid(siteMapId)) {
    return res.status(400).json({ error: 'site_map_id query param required (uuid)' });
  }

  try {
    var siteMap = await sb.one(
      'site_maps?id=eq.' + siteMapId
      + '&select=id,contact_id,anonymous_session_id,source_type,status,root_url,'
      + 'mvp_locked_at,fully_locked_at,launched_at,addon_count,addon_total_cents,'
      + 'addon_invoice_status,sitemap_scout_id,created_at,updated_at'
    );
    if (!siteMap) return res.status(404).json({ error: 'site_map not found' });

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

      if (!counts[cat]) counts[cat] = { active: 0, removed: 0, cap: null };
      if (REMOVED_STATUSES.indexOf(p.status) !== -1) counts[cat].removed += 1;
      else counts[cat].active += 1;
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
