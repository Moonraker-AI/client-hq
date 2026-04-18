// api/backfill-gbp-warehouse.js
// Bulk-backfills the gbp_daily warehouse table for one or many clients.
// CRON_SECRET- or admin-JWT-gated.
//
// The Performance API caps at ~18 months from today, and the window slides
// forward in real time — if we delay the capture for an existing client we
// permanently lose history. So this endpoint is safe to run repeatedly
// (last-write-wins upsert) and should be fired at client onboarding.
//
// Usage:
//   POST /api/backfill-gbp-warehouse
//   Authorization: Bearer <CRON_SECRET>   (or admin JWT)
//   Body:
//     { "slug": "daniel-arteaga" }             # single client
//     { "all": true }                          # every active client with gbp_location_id
//     { "all": true, "months": 12 }            # custom window (default 18)
//     { "slug": "erika-frieze", "dry_run": true }  # no writes, just report counts
//
// Behavior:
//   - Per client, issues one Performance API call covering the requested
//     window, parses per-day rows via _lib/gbp.parseDaily, upserts each
//     into gbp_daily.
//   - Dates with zero activity are NOT emitted by Google — warehouse rows
//     only exist for days with at least one measurable signal. Readers
//     should treat missing dates as zero.
//   - Skips clients without a gbp_location_id (reports as 'skipped_no_id').

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var sb = require('./_lib/supabase');
var gbp = require('./_lib/gbp');

// Google's hard cap is 18 months; we request 550 days (~18.1mo) so we
// edge right up to the boundary without going over.
var DEFAULT_MONTHS = 18;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};
  var targetSlug = body.slug ? String(body.slug) : null;
  var allClients = !!body.all;
  var dryRun = !!body.dry_run;
  var months = Math.max(1, Math.min(18, Number(body.months || DEFAULT_MONTHS)));

  if (!targetSlug && !allClients) {
    res.status(400).json({ error: 'Either "slug" or "all:true" is required' });
    return;
  }

  // Date range: [today - months, yesterday]. Yesterday is the latest
  // day Google will return data for; today is not yet complete.
  var now = new Date();
  var end = new Date(now.getTime() - 86400000);              // yesterday
  var start = new Date(end.getTime() - months * 30.44 * 86400000);
  var endISO   = end.toISOString().slice(0, 10);
  var startISO = start.toISOString().slice(0, 10);

  var t0 = Date.now();

  try {
    // 1. Resolve target clients (from report_configs + contacts)
    var filter = 'select=client_slug,gbp_location_id'
               + '&gbp_location_id=not.is.null'
               + '&order=client_slug.asc';
    if (targetSlug) {
      filter += '&client_slug=eq.' + encodeURIComponent(targetSlug);
    }
    var configs = await sb.query('report_configs?' + filter);

    if (configs.length === 0) {
      res.status(404).json({
        error: targetSlug
          ? 'No report_configs row with gbp_location_id for slug=' + targetSlug
          : 'No clients with gbp_location_id configured'
      });
      return;
    }

    var results = [];
    var totalRowsFetched = 0;
    var totalRowsUpserted = 0;
    var totalApiCalls = 0;
    var totalSkipped = 0;
    var totalFailed = 0;

    for (var i = 0; i < configs.length; i++) {
      var c = configs[i];
      var slug = c.client_slug;
      var locId = c.gbp_location_id;

      if (!locId) {
        totalSkipped++;
        results.push({ slug: slug, status: 'skipped_no_id' });
        continue;
      }

      try {
        var fetched = await gbp.fetchPerformanceDaily(locId, startISO, endISO);
        totalApiCalls++;

        if (!fetched.available) {
          totalFailed++;
          results.push({
            slug: slug,
            status: 'fetch_failed',
            error: fetched.error,
            http_status: fetched.http_status
          });
          continue;
        }

        var days = fetched.days || [];
        totalRowsFetched += days.length;

        if (dryRun) {
          results.push({
            slug: slug,
            status: 'would_upsert',
            rows: days.length,
            first_date: days[0] && days[0].date,
            last_date:  days.length ? days[days.length - 1].date : null
          });
          continue;
        }

        // Upsert in chunks to keep PostgREST payloads small and the row
        // count auditable per chunk. on_conflict uses the composite PK.
        var upserted = 0;
        var CHUNK = 200;
        for (var k = 0; k < days.length; k += CHUNK) {
          var chunk = days.slice(k, k + CHUNK).map(function(d) {
            return {
              client_slug:                slug,
              date:                       d.date,
              gbp_location_id:            locId,
              calls:                      d.calls,
              website_clicks:             d.website_clicks,
              direction_requests:         d.direction_requests,
              impressions_desktop_maps:   d.impressions_desktop_maps,
              impressions_desktop_search: d.impressions_desktop_search,
              impressions_mobile_maps:    d.impressions_mobile_maps,
              impressions_mobile_search:  d.impressions_mobile_search
            };
          });
          await sb.mutate(
            'gbp_daily?on_conflict=client_slug,date',
            'POST',
            chunk,
            'resolution=merge-duplicates,return=representation'
          );
          upserted += chunk.length;
        }

        totalRowsUpserted += upserted;
        results.push({
          slug: slug,
          status: 'upserted',
          rows: upserted,
          first_date: days[0] && days[0].date,
          last_date:  days.length ? days[days.length - 1].date : null
        });

        // Gentle pacing between clients to avoid both Google quota and
        // Supabase write bursts
        await new Promise(function(r) { setTimeout(r, 300); });
      } catch (clientErr) {
        totalFailed++;
        monitor.logError('backfill-gbp-warehouse', clientErr, {
          client_slug: slug,
          detail: { stage: 'per_client_upsert' }
        });
        results.push({
          slug: slug,
          status: 'error',
          error: clientErr.message || String(clientErr)
        });
      }
    }

    res.status(200).json({
      clients_processed: configs.length,
      api_calls: totalApiCalls,
      rows_fetched: totalRowsFetched,
      rows_upserted: totalRowsUpserted,
      skipped: totalSkipped,
      failed: totalFailed,
      date_range: { start: startISO, end: endISO, months: months },
      dry_run: dryRun,
      duration_ms: Date.now() - t0,
      results: results
    });
  } catch (e) {
    monitor.logError('backfill-gbp-warehouse', e, {
      detail: { stage: 'handler', targetSlug: targetSlug, allClients: allClients }
    });
    res.status(500).json({
      error: 'Warehouse backfill failed',
      detail: e.message || String(e),
      duration_ms: Date.now() - t0
    });
  }
};
