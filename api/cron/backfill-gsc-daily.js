// api/cron/backfill-gsc-daily.js
// Daily cron — tops up the gsc_daily warehouse for every client that has a
// gsc_property on report_configs.
//
// GSC's Search Analytics API caps at ~16 months from "today" and the
// window slides forward in real time. Skipped days fall off the edge
// permanently. Nightly run keeps the warehouse fresh; the parent
// endpoint's upsert on PK (client_slug, date) is idempotent.
//
// Vercel cron config (in vercel.json):
//   "path":     "/api/cron/backfill-gsc-daily"
//   "schedule": "30 9 * * *"    # 09:30 UTC daily, 30min after GBP cron
//
// Auth: Vercel adds Authorization: Bearer <CRON_SECRET> automatically.
// requireAdminOrInternal accepts CRON_SECRET as an internal caller.

var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');
var upstream = require('../backfill-gsc-warehouse');

async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  req.method = 'POST';
  req.body = Object.assign({}, req.body || {}, { all: true });

  try {
    return await upstream(req, res);
  } catch (err) {
    monitor.logError('cron/backfill-gsc-daily', err, {
      detail: { stage: 'delegate_to_backfill_gsc_warehouse' }
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'backfill-gsc-daily failed' });
    }
  }
}

module.exports = cronRuns.withTracking('backfill-gsc-daily', handler);
