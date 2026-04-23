/**
 * /api/site-map-from-scout.js
 *
 * Materializes (or retrieves) a site_map for a CORE existing client, seeding
 * it from their most recent completed sitemap_scouts row.
 *
 * Idempotent: if a site_map already exists for this contact_id AND is still
 * in 'draft' status, returns the existing one. If one exists but is already
 * locked (mvp_locked / fully_locked / launched), returns it unchanged. The
 * configurator UI should bail to read-only mode in that case.
 *
 * If no scout has completed yet, returns 409 — the caller should retry once
 * the scout callback lands.
 *
 * POST body: { contact_id }
 * Auth: admin JWT or CRON_SECRET (for auto-adoption hooks later)
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

// Category -> source_type context mapping.
// All scout categories are copied into site_map_pages as status='discovered'.
// Client decides keep/update/remove/new from there.
//
// We exclude meta categories that don't belong in the configurator (excluded
// paths are already stripped by the scout; excluded-from-configurator is a
// smaller additional filter here for things like thank_you pages which aren't
// user-navigable).
var EXCLUDED_CATEGORIES_FROM_CONFIGURATOR = ['thank_you'];

function deriveNameFromUrl(u) {
  try {
    var pathname = new URL(u).pathname || '';
    var segs = pathname.split('/').filter(Boolean);
    if (!segs.length) return null;
    var last = segs[segs.length - 1];
    var spaced = last.replace(/[-_]+/g, ' ').trim();
    if (!spaced) return null;
    return spaced.split(/\s+/).map(function(w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ').slice(0, 200);
  } catch (_) { return null; }
}

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};
  if (!body.contact_id) {
    return res.status(400).json({ error: 'contact_id required' });
  }

  try {
    // Fetch contact
    var contact = await sb.one('contacts?id=eq.' + encodeURIComponent(body.contact_id) + '&select=id,slug,website_url,status');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Idempotency: return existing site_map if one already exists for this contact.
    // Only one active site_map per contact_id — we surface all non-abandoned ones.
    var existing = await sb.one(
      'site_maps?contact_id=eq.' + encodeURIComponent(contact.id)
      + '&status=neq.abandoned'
      + '&select=id,status,source_type,root_url,created_at,mvp_locked_at,fully_locked_at,launched_at'
      + '&order=created_at.desc&limit=1'
    );
    if (existing) {
      return res.json({
        success: true,
        site_map_id: existing.id,
        status: existing.status,
        reused: true,
        message: 'Existing site_map returned (idempotent)'
      });
    }

    // No site_map yet — look for a completed scout to seed from.
    var scout = await sb.one(
      'sitemap_scouts?contact_id=eq.' + contact.id
      + '&status=eq.complete'
      + '&select=id,root_url,report,total_pages,sitemap_source,scanned_at'
      + '&order=scanned_at.desc&limit=1'
    );
    if (!scout) {
      return res.status(409).json({
        error: 'No completed sitemap scout found for this contact',
        hint: 'Trigger /api/trigger-sitemap-scout first, or wait for the in-flight scout to complete'
      });
    }

    // Create the site_map as a draft. source_type='core_existing' since this
    // flow only covers existing clients adopting their current sitemap.
    // (core_new and standalone flows create their site_map via a different
    // route since there's no scout to adopt.)
    var createResp = await sb.mutate('site_maps', 'POST', {
      contact_id: contact.id,
      source_type: 'core_existing',
      status: 'draft',
      sitemap_scout_id: scout.id,
      root_url: scout.root_url || contact.website_url
    }, 'return=representation');

    var siteMap = Array.isArray(createResp) ? createResp[0] : createResp;
    if (!siteMap || !siteMap.id) {
      throw new Error('site_maps insert did not return row');
    }

    // Seed site_map_pages from the scout report.
    // report.pages_by_category is { category: [{url}] } — the post-collapse
    // representation. For collapsed categories (blog_post etc.), we seed from
    // collapsed_categories.all_urls instead to avoid losing pages.
    var pbc = (scout.report && scout.report.pages_by_category) || {};
    var collapsed = (scout.report && scout.report.collapsed_categories) || {};

    // Pre-pass: bio category needs one bio_materials placeholder per page so
    // the configurator can link pages -> existing-intake content. We collect
    // bio URLs first, match against existing bio_materials by page_url,
    // create placeholders for any unmatched URLs, then seed pages with
    // bio_material_id set.
    //
    // Idempotency note: bio_materials may already contain rows for this
    // contact (existing clients who filled in onboarding step 6 before the
    // configurator existed). We link by page_url first, only creating a new
    // row when the scout found a bio URL that has no bio_materials counterpart.
    var bioUrls = [];
    if (collapsed['bio'] && Array.isArray(collapsed['bio'].all_urls)) {
      bioUrls = collapsed['bio'].all_urls.slice(0);
    } else if (pbc['bio']) {
      bioUrls = (pbc['bio'] || []).map(function(p) { return typeof p === 'string' ? p : p.url; }).filter(Boolean);
    }
    // Enforce the 10-bio cap at adoption time. Any bio URLs beyond 10 get
    // dropped (not imported as discovered pages) — admin/client can add them
    // back manually from the configurator later if desired.
    if (bioUrls.length > 10) bioUrls = bioUrls.slice(0, 10);

    var bioMaterialIdByUrl = {};

    // Load any pre-existing bio_materials rows for this contact.
    var existingBios = await sb.query(
      'bio_materials?contact_id=eq.' + contact.id
      + '&select=id,page_url,sort_order&order=sort_order'
    );
    existingBios = existingBios || [];
    // Map existing rows by page_url for fast lookup.
    var existingByUrl = {};
    var maxSort = -1;
    for (var eb = 0; eb < existingBios.length; eb++) {
      var row = existingBios[eb];
      if (row.page_url) existingByUrl[row.page_url] = row.id;
      if (typeof row.sort_order === 'number' && row.sort_order > maxSort) maxSort = row.sort_order;
    }

    // Split scout-discovered bios into already-linked vs needs-new-row.
    var newBioUrls = [];
    for (var bu = 0; bu < bioUrls.length; bu++) {
      var u = bioUrls[bu];
      if (existingByUrl[u]) {
        bioMaterialIdByUrl[u] = existingByUrl[u];
      } else {
        newBioUrls.push(u);
      }
    }

    // If the contact has some existing bio_materials without page_url (filled
    // in before this linking existed), leave them alone — they'll show up in
    // the configurator as bios not linked to any scout-discovered URL, which
    // the admin can resolve manually later.

    if (newBioUrls.length) {
      // Respect the global 10-bio cap: existing + new cannot exceed 10.
      var capacity = Math.max(0, 10 - existingBios.length);
      if (newBioUrls.length > capacity) newBioUrls = newBioUrls.slice(0, capacity);
    }

    if (newBioUrls.length) {
      var bioRows = newBioUrls.map(function(u, idx) {
        return {
          contact_id: contact.id,
          therapist_name: deriveNameFromUrl(u) || 'New Therapist',
          // Primary flag: only if no existing bio is already primary AND this
          // is the first newly-created row.
          is_primary: (existingBios.length === 0 && idx === 0),
          page_url: u,
          sort_order: maxSort + 1 + idx,
          status: 'pending'
        };
      });
      var bioResp = await sb.mutate('bio_materials', 'POST', bioRows, 'return=representation');
      var bioResults = Array.isArray(bioResp) ? bioResp : [bioResp];
      for (var bi = 0; bi < bioResults.length; bi++) {
        var br = bioResults[bi];
        if (br && br.page_url && br.id) bioMaterialIdByUrl[br.page_url] = br.id;
      }
    }

    var rows = [];
    for (var cat in pbc) {
      if (!Object.prototype.hasOwnProperty.call(pbc, cat)) continue;
      if (EXCLUDED_CATEGORIES_FROM_CONFIGURATOR.indexOf(cat) !== -1) continue;

      // Choose full list if collapsed, otherwise the visible subset.
      var urls;
      if (collapsed[cat] && Array.isArray(collapsed[cat].all_urls)) {
        urls = collapsed[cat].all_urls;
      } else {
        urls = (pbc[cat] || []).map(function(p) { return typeof p === 'string' ? p : p.url; }).filter(Boolean);
      }

      // Enforce bio cap on seeded pages too — if scout found 15 bios we only
      // take the first 10 (same slice as the bio_materials creation above).
      if (cat === 'bio' && urls.length > 10) urls = urls.slice(0, 10);

      for (var i = 0; i < urls.length; i++) {
        var u = urls[i];
        if (!u) continue;
        // All rows must share the same key set for PostgREST bulk insert.
        var row = {
          site_map_id: siteMap.id,
          category: cat,
          status: 'discovered',
          url: u,
          display_order: i,
          intake_status: (cat === 'bio') ? 'intake_pending' : null,
          bio_material_id: (cat === 'bio') ? (bioMaterialIdByUrl[u] || null) : null
        };
        rows.push(row);
      }
    }

    // Batch insert (if anything to insert)
    if (rows.length) {
      try {
        await sb.mutate('site_map_pages', 'POST', rows, 'return=minimal');
      } catch (seedErr) {
        // Rollback: delete the empty site_map so the next call re-tries cleanly
        // instead of short-circuiting on the idempotency check.
        try {
          await sb.mutate('site_maps?id=eq.' + siteMap.id, 'DELETE', null, 'return=minimal');
        } catch (_) { /* swallow; seedErr is the real story */ }
        throw seedErr;
      }
    }

    return res.json({
      success: true,
      site_map_id: siteMap.id,
      status: siteMap.status,
      reused: false,
      pages_seeded: rows.length,
      sitemap_scout_id: scout.id,
      message: 'site_map created and seeded from scout'
    });

  } catch (err) {
    console.error('site-map-from-scout error:', err);
    monitor.logError('site-map-from-scout', err, {
      detail: { stage: 'handler', contact_id: body.contact_id }
    });
    return res.status(500).json({ error: 'Failed to materialize site_map' });
  }
};
