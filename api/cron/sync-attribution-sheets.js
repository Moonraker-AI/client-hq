// api/cron/sync-attribution-sheets.js
// Monthly cron that runs through all report_configs with
// attribution_sync.enabled = true, reads their sheets, and syncs.
//
// Scheduled at 0 9 1 * * (09:00 UTC on the 1st of every month) — one hour
// before the monthly report cron so fresh attribution data is available
// when reports compile.
//
// Errors on individual clients are logged but do not fail the whole run;
// sync status (ok / error) is persisted per client for admin visibility.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var sheets = require('../_lib/google-sheets');
var syncLib = require('../admin/attribution-sync');

module.exports = async function handler(req, res) {
  // Auth normalized to requireAdminOrInternal for consistency with the other
  // 10 cron routes (cron audit M5). Previous requireCronSecret is reserved
  // for routes with DDL / bulk-push superpowers (run-migration, backfill-
  // campaign-summary-pages); sync-attribution-sheets just reads Google
  // Sheets and updates report_configs, safe for admins to invoke manually.
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var startedAt = Date.now();
  var summary = {
    eligible: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    per_client: []
  };

  try {
    // Pull all configs where attribution_sync.enabled = true
    // PostgREST JSONB filter via ->>
    var configs = await sb.query(
      'report_configs?select=client_slug,attribution_sync'
      + '&attribution_sync->>enabled=eq.true'
    );
    summary.eligible = (configs || []).length;

    for (var i = 0; i < configs.length; i++) {
      var cfg = configs[i];
      var slug = cfg.client_slug;
      var sync = cfg.attribution_sync || {};

      if (!sync.sheet_id || !sync.tab_name) {
        summary.skipped += 1;
        summary.per_client.push({ slug: slug, status: 'skipped', reason: 'incomplete config' });
        continue;
      }

      try {
        // Load contact separately to get contact_id
        var contact = await sb.one(
          'contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id&limit=1'
        );
        if (!contact) {
          summary.skipped += 1;
          summary.per_client.push({ slug: slug, status: 'skipped', reason: 'contact not found' });
          continue;
        }

        var range = "'" + sync.tab_name.replace(/'/g, "''") + "'!A:Z";
        var rows = await sheets.fetchSheetValues(sync.sheet_id, range);
        var result = await syncLib.runLeadTrackerSync({
          contactId: contact.id,
          sheetId: sync.sheet_id,
          tabName: sync.tab_name,
          rows: rows
        });

        // Stamp success on config
        var nowIso = new Date().toISOString();
        var updated = Object.assign({}, sync, {
          last_synced_at: nowIso,
          last_sync_status: 'ok',
          last_sync_error: null,
          last_sync_rows_touched: result.rows_processed
        });
        await sb.mutate(
          'report_configs?client_slug=eq.' + encodeURIComponent(slug),
          'PATCH',
          { attribution_sync: updated },
          'return=representation'
        );

        summary.synced += 1;
        summary.per_client.push({
          slug: slug,
          status: 'ok',
          rows_processed: result.rows_processed,
          periods_created: result.periods_created,
          periods_updated: result.periods_updated,
          sources_written: result.sources_written
        });
      } catch (clientErr) {
        summary.failed += 1;
        var errMsg = clientErr.message || String(clientErr);
        monitor.logError('cron-sync-attribution-sheets', clientErr, {
          client_slug: slug,
          detail: { sheet_id: sync.sheet_id, tab: sync.tab_name }
        });
        // Best-effort stamp error on the config so the admin sees it
        try {
          var failedCfg = Object.assign({}, sync, {
            last_synced_at: new Date().toISOString(),
            last_sync_status: 'error',
            last_sync_error: errMsg.slice(0, 500)
          });
          await sb.mutate(
            'report_configs?client_slug=eq.' + encodeURIComponent(slug),
            'PATCH',
            { attribution_sync: failedCfg },
            'return=representation'
          );
        } catch (stampErr) { /* swallow */ }
        summary.per_client.push({ slug: slug, status: 'error', error: errMsg });
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    res.status(200).json({ ok: true, summary: summary });
  } catch (e) {
    monitor.critical('cron-sync-attribution-sheets', e, {
      detail: { summary_so_far: summary }
    });
    res.status(500).json({ error: 'Cron run failed', detail: e.message, summary: summary });
  }
};
