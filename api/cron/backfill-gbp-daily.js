// api/cron/backfill-gbp-daily.js
// Daily cron — tops up the gbp_daily warehouse for every client that has a
// gbp_location_id on report_configs.
//
// Google's Performance API caps at ~18 months from "today" and the window
// slides forward in real time. If we skip a day we permanently lose that
// day's history once it falls off the 18-month edge. A nightly run keeps
// the warehouse fresh and is free to repeat (the parent endpoint's upsert
// on PK (client_slug, date) is idempotent).
//
// Vercel cron config (in vercel.json):
//   "path":     "/api/cron/backfill-gbp-daily"
//   "schedule": "0 9 * * *"    # 09:00 UTC every day (~1-4am Pacific)
//
// Auth: Vercel adds Authorization: Bearer <CRON_SECRET> automatically.
// requireAdminOrInternal accepts CRON_SECRET as an internal caller.
//
// Handler is a thin wrapper: it re-authorizes, then invokes the admin-facing
// backfill-gbp-warehouse handler with {all: true}. Keeping the business
// logic in one place (the non-cron file) avoids drift.

var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var upstream = require('../backfill-gbp-warehouse');

module.exports = async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  // The parent expects POST + {all: true}. Vercel cron invokes GET with an
  // empty body, so synthesize the shape the handler wants before delegating.
  req.method = 'POST';
  req.body = Object.assign({}, req.body || {}, { all: true });

  // Wrap the upstream call so any unhandled throw gets logged to the
  // error_log table (audit M7). Without this, the delegate pattern
  // surfaces errors only in ephemeral Vercel logs.
  try {
    return await upstream(req, res);
  } catch (err) {
    monitor.logError('cron/backfill-gbp-daily', err, {
      detail: { stage: 'delegate_to_backfill_gbp_warehouse' }
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'backfill-gbp-daily failed' });
    }
  }
};
