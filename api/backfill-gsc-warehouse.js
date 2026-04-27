// api/backfill-gsc-warehouse.js
// Bulk-backfills the gsc_daily warehouse for one or many clients.
// CRON_SECRET- or admin-JWT-gated.
//
// GSC's Search Analytics API caps at ~16 months from today and the window
// slides forward in real time. If we delay capture for an existing client
// we permanently lose history. This endpoint is safe to run repeatedly
// (last-write-wins upsert on (client_slug, date)) and is fired both at
// client onboarding (via the report_configs trigger) and nightly.
//
// Usage:
//   POST /api/backfill-gsc-warehouse
//   Authorization: Bearer <CRON_SECRET>   (or admin JWT)
//   Body:
//     { "slug": "amy-castongia" }              # single client
//     { "all": true }                          # every client with gsc_property
//     { "all": true, "months": 12 }            # custom window (default 16)
//     { "slug": "amy-castongia", "dry_run": true }
//
// Behavior mirrors backfill-gbp-warehouse.js: one API call per client,
// per-day parse, chunked upsert. Days with zero activity aren't emitted.

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var sb = require('./_lib/supabase');
var gsc = require('./_lib/gsc');

// GSC's hard cap is 16 months; request 480 days (~15.8mo) so we edge up to
// the boundary without going over.
var DEFAULT_MONTHS = 16;

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
  var months = Math.max(1, Math.min(16, Number(body.months || DEFAULT_MONTHS)));

  if (!targetSlug && !allClients) {
    res.status(400).json({ error: 'Either "slug" or "all:true" is required' });
    return;
  }

  // [today - months, yesterday]. GSC has a 2-3 day reporting lag but the
  // API will silently return whatever is available, so we cap at yesterday
  // and let later runs fill in late-arriving data via the upsert.
  var now = new Date();
  var end = new Date(now.getTime() - 86400000);
  var start = new Date(end.getTime() - months * 30.44 * 86400000);
  var endISO   = end.toISOString().slice(0, 10);
  var startISO = start.toISOString().slice(0, 10);

  var t0 = Date.now();

  try {
    var filter = 'select=client_slug,gsc_property'
               + '&gsc_property=not.is.null'
               + '&order=client_slug.asc';
    if (targetSlug) {
      filter += '&client_slug=eq.' + encodeURIComponent(targetSlug);
    }
    var configs = await sb.query('report_configs?' + filter);

    if (configs.length === 0) {
      res.status(404).json({
        error: targetSlug
          ? 'No report_configs row with gsc_property for slug=' + targetSlug
          : 'No clients with gsc_property configured'
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
      var property = c.gsc_property;

      if (!property) {
        totalSkipped++;
        results.push({ slug: slug, status: 'skipped_no_property' });
        continue;
      }

      try {
        var fetched = await gsc.fetchAnalyticsDaily(property, startISO, endISO);
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

        var upserted = 0;
        var CHUNK = 200;
        for (var k = 0; k < days.length; k += CHUNK) {
          var chunk = days.slice(k, k + CHUNK).map(function(d) {
            return {
              client_slug:  slug,
              date:         d.date,
              gsc_property: property,
              clicks:       d.clicks,
              impressions:  d.impressions,
              ctr:          d.ctr,
              position:     d.position
            };
          });
          await sb.mutate(
            'gsc_daily?on_conflict=client_slug,date',
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

        await new Promise(function(r) { setTimeout(r, 300); });
      } catch (clientErr) {
        totalFailed++;
        monitor.logError('backfill-gsc-warehouse', clientErr, {
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
    monitor.logError('backfill-gsc-warehouse', e, {
      detail: { stage: 'handler', targetSlug: targetSlug, allClients: allClients }
    });
    res.status(500).json({
      error: 'Warehouse backfill failed',
      detail: e.message || String(e),
      duration_ms: Date.now() - t0
    });
  }
};
