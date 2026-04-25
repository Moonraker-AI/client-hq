/**
 * /api/ingest-sitemap-scout.js
 *
 * Callback from the Moonraker Agent after a sitemap scout completes.
 * Stores the full report in sitemap_scouts for the configurator to consume.
 *
 * POST body: { task_id, report }
 * Auth: Agent API key (Bearer token) or admin JWT.
 *
 * Always returns 200 on recoverable failures — the agent shouldn't retry,
 * a retry would just resend the same payload with the same error.
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body;
  if (!body || !body.task_id || !body.report) {
    return res.status(400).json({ error: 'task_id and report required' });
  }

  try {
    var report = body.report;
    var taskId = body.task_id;

    // Find the scout record by agent_task_id
    var scout = await sb.one('sitemap_scouts?agent_task_id=eq.' + encodeURIComponent(taskId)
      + '&select=id,contact_id,client_slug');
    if (!scout) {
      console.warn('ingest-sitemap-scout: no scout record for task_id=' + taskId);
      // 200 to avoid retry loop — the agent has no way to resolve this
      return res.json({ success: false, reason: 'Scout record not found for task_id: ' + taskId });
    }

    // Build summary line
    var summary = _buildSummary(report);

    // Did the scout succeed? Consider it failed if no pages were found AND
    // the report has errors.
    var hasErrors = Array.isArray(report.errors) && report.errors.length > 0;
    var totalPages = report.total_pages || 0;
    var status = (totalPages === 0 && hasErrors) ? 'failed' : 'complete';

    var patch = {
      status: status,
      report: report,
      summary: summary,
      sitemap_source: report.sitemap_source || '',
      total_pages: totalPages,
      scanned_at: report.scanned_at || new Date().toISOString(),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (status === 'failed') {
      patch.error_message = hasErrors ? report.errors.join('; ').substring(0, 500) : 'No URLs discovered';
    }

    await sb.mutate('sitemap_scouts?id=eq.' + scout.id, 'PATCH', patch, 'return=minimal');

    // Refresh nav flags on any existing site_map for this contact. New clients
    // (no site_map yet) get nav state seeded by site-map-from-scout when the
    // configurator first materializes; this branch handles re-scouts where
    // the configurator already exists and the badge state should refresh.
    if (status === 'complete' && scout.contact_id) {
      try {
        await _refreshNavState(scout.contact_id, report);
      } catch (navErr) {
        // Non-fatal: scout itself ingested fine, nav refresh is a presentation
        // layer concern. Log and move on.
        console.error('ingest-sitemap-scout nav refresh failed:', navErr.message);
        monitor.logError('ingest-sitemap-scout', navErr, {
          client_slug: scout.client_slug,
          detail: { stage: 'nav_refresh' }
        });
      }
    }

    console.log('Sitemap scout ingested: ' + scout.client_slug + ' - ' + summary);

    return res.json({ success: true, scout_id: scout.id, summary: summary });

  } catch (err) {
    console.error('ingest-sitemap-scout error:', err);
    monitor.logError('ingest-sitemap-scout', err, {
      detail: { stage: 'ingest_handler', task_id: body && body.task_id }
    });
    // 200 so the agent doesn't retry — the error is on our side and retry won't help
    return res.json({ success: false, error: 'Failed to ingest sitemap scout data' });
  }
};


function _buildSummary(report) {
  var parts = [];
  parts.push((report.total_pages || 0) + ' pages');
  parts.push('via ' + (report.sitemap_source || '?'));

  var pbc = report.pages_by_category || {};
  var catsInOrder = ['service', 'location', 'bio', 'blog_post', 'blog_index', 'home', 'faq', 'contact', 'about'];
  var catParts = [];
  for (var i = 0; i < catsInOrder.length; i++) {
    var cat = catsInOrder[i];
    if (pbc[cat] && pbc[cat].length) {
      var count = pbc[cat].length;
      var collapsed = report.collapsed_categories && report.collapsed_categories[cat];
      if (collapsed && collapsed.count) count = collapsed.count;
      catParts.push(cat + '=' + count);
    }
  }
  if (catParts.length) parts.push(catParts.join(', '));

  if (report.duration_seconds) parts.push(report.duration_seconds + 's');

  return parts.join(' | ');
}

// Mirror of sitemap_scout.py's _normalize_nav_url — produces
// 'scheme://lowercase-host/path' with no trailing slash, no query, no fragment.
function _normalizeForNav(rawUrl) {
  if (!rawUrl) return null;
  try {
    var u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    var path = (u.pathname || '/').replace(/\/+$/, '');
    return (u.protocol + '//' + u.hostname.toLowerCase() + path).toLowerCase();
  } catch (_) {
    return null;
  }
}

// Refresh in_nav flags on an existing site_map after a re-scout. If there's
// no live site_map for this contact yet, we just record nav metadata on
// nothing (no-op) — the seeder (site-map-from-scout) will pick up nav state
// from the latest scout when the configurator is first materialized.
async function _refreshNavState(contactId, report) {
  var navUrls = Array.isArray(report.nav_urls) ? report.nav_urls : [];
  var navMethod = report.nav_extraction_method || null;

  // Find the live site_map (not abandoned, status not locked-down).
  var siteMap = await sb.one(
    'site_maps?contact_id=eq.' + encodeURIComponent(contactId)
    + '&status=neq.abandoned'
    + '&select=id,status'
    + '&order=created_at.desc&limit=1'
  );
  if (!siteMap) return;  // no configurator yet — seeder will handle it

  // Always update nav metadata on the parent site_map row, even when nav
  // extraction returned nothing — admin needs to see "we tried, got 0" vs
  // "we never tried" (null timestamp).
  await sb.mutate('site_maps?id=eq.' + siteMap.id, 'PATCH', {
    nav_extracted_at: new Date().toISOString(),
    nav_extraction_method: navMethod
  }, 'return=minimal');

  // Pull all pages, decide which should flip.
  var pages = await sb.query(
    'site_map_pages?site_map_id=eq.' + siteMap.id
    + '&select=id,url,in_nav'
  );
  if (!Array.isArray(pages) || pages.length === 0) return;

  var navSet = {};
  for (var i = 0; i < navUrls.length; i++) navSet[navUrls[i]] = true;

  var setTrue = [];   // ids whose in_nav should be true and currently isn't
  var setFalse = [];  // ids whose in_nav should be false and currently isn't
  for (var p = 0; p < pages.length; p++) {
    var page = pages[p];
    var shouldBeInNav = !!navSet[_normalizeForNav(page.url)];
    if (shouldBeInNav && !page.in_nav) setTrue.push(page.id);
    else if (!shouldBeInNav && page.in_nav) setFalse.push(page.id);
  }

  // PostgREST in.() filter: flip the deltas only. Two batched PATCHes.
  if (setTrue.length) {
    await sb.mutate(
      'site_map_pages?id=in.(' + setTrue.join(',') + ')',
      'PATCH', { in_nav: true }, 'return=minimal'
    );
  }
  if (setFalse.length) {
    await sb.mutate(
      'site_map_pages?id=in.(' + setFalse.join(',') + ')',
      'PATCH', { in_nav: false }, 'return=minimal'
    );
  }

  console.log('nav refresh for site_map ' + siteMap.id + ': +' + setTrue.length + ' / -' + setFalse.length + ' (method=' + navMethod + ')');
}

