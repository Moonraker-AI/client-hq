// api/admin/cron-health.js
// Returns cron health summary for the /admin/system page.
//
// Per-cron: latest successful run, latest run of any status, run count over
// the last 24h, and whether the cron is stale per its expected interval.
// Also returns currently-running rows (useful for spotting hung crons).

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

// Expected interval + slack per cron. Mirrors cron-heartbeat-check so the
// stale flag here matches what the heartbeat cron would alert on. If you
// change one, change the other.
var EXPECTED = {
  'enqueue-reports':         { intervalSec: 30 * 86400, toleranceSec: 5 * 86400 },
  'process-queue':           { intervalSec: 300,         toleranceSec: 60 * 60 },
  'process-followups':       { intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'trigger-quarterly-audits':{ intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'process-audit-queue':     { intervalSec: 1800,        toleranceSec: 3 * 3600 },
  'check-surge-blocks':      { intervalSec: 3600,        toleranceSec: 3 * 3600 },
  'process-scheduled-sends': { intervalSec: 300,         toleranceSec: 60 * 60 },
  'process-batch-pages':     { intervalSec: 300,         toleranceSec: 60 * 60 },
  'cleanup-rate-limits':     { intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'sync-attribution-sheets': { intervalSec: 30 * 86400,  toleranceSec: 5 * 86400 },
  'backfill-gbp-daily':      { intervalSec: 86400,       toleranceSec: 12 * 3600 },
  'cron-heartbeat-check':    { intervalSec: 86400,       toleranceSec: 12 * 3600 }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  try {
    var since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    var results = await Promise.all([
      // Last successful completion per cron. One row per cron; ordered desc
      // so client code can walk until it sees each name once.
      sb.query(
        'cron_runs?status=eq.success&order=cron_name.asc,completed_at.desc' +
        '&select=cron_name,completed_at,started_at,queue_depth,oldest_item_age_sec&limit=500'
      ),
      // All runs in the last 24h (for counts + error rates)
      sb.query(
        'cron_runs?started_at=gte.' + since24h +
        '&select=cron_name,status,started_at,completed_at,error,queue_depth,oldest_item_age_sec' +
        '&order=started_at.desc&limit=1000'
      ),
      // Currently running (status='running') — helps spot hangs
      sb.query(
        'cron_runs?status=eq.running&order=started_at.asc' +
        '&select=id,cron_name,started_at,queue_depth,oldest_item_age_sec&limit=50'
      )
    ]);

    var lastSuccessByName = {};
    (results[0] || []).forEach(function(r) {
      if (!lastSuccessByName[r.cron_name]) lastSuccessByName[r.cron_name] = r;
    });

    var runs24h = results[1] || [];
    var running = results[2] || [];

    var countsByName = {};
    var errorsByName = {};
    var lastRunByName = {};
    for (var i = 0; i < runs24h.length; i++) {
      var r = runs24h[i];
      countsByName[r.cron_name] = (countsByName[r.cron_name] || 0) + 1;
      if (r.status === 'error') errorsByName[r.cron_name] = (errorsByName[r.cron_name] || 0) + 1;
      if (!lastRunByName[r.cron_name]) lastRunByName[r.cron_name] = r;
    }

    var now = Date.now();
    var cronNames = Object.keys(EXPECTED);
    var summary = cronNames.map(function(name) {
      var cfg = EXPECTED[name];
      var lastSuccess = lastSuccessByName[name] || null;
      var lastRun = lastRunByName[name] || null;
      var gapSec = null;
      var stale = null;
      if (lastSuccess) {
        gapSec = Math.floor((now - new Date(lastSuccess.completed_at).getTime()) / 1000);
        stale = gapSec > (cfg.intervalSec + cfg.toleranceSec);
      } else {
        stale = true; // never completed successfully
      }
      return {
        cron_name: name,
        expected_interval_sec: cfg.intervalSec,
        tolerance_sec: cfg.toleranceSec,
        last_success_completed_at: lastSuccess ? lastSuccess.completed_at : null,
        last_success_queue_depth: lastSuccess ? lastSuccess.queue_depth : null,
        last_success_oldest_age_sec: lastSuccess ? lastSuccess.oldest_item_age_sec : null,
        last_run_at: lastRun ? lastRun.started_at : null,
        last_run_status: lastRun ? lastRun.status : null,
        last_run_error: lastRun ? lastRun.error : null,
        gap_since_success_sec: gapSec,
        stale: stale,
        runs_24h: countsByName[name] || 0,
        errors_24h: errorsByName[name] || 0
      };
    });

    res.status(200).json({
      summary: summary,
      running: running,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[cron-health] Error:', e.message);
    res.status(500).json({ error: 'Failed to load cron health' });
  }
};
