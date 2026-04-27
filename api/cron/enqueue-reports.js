// /api/cron/enqueue-reports.js - Enqueue monthly report compilations
// Called by Vercel Cron on 1st of month, or manually from admin
// Staggers compilations 3 minutes apart to avoid API rate limits

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;


  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    // Determine report month (default: PREVIOUS month since cron runs on the 1st)
    var now = new Date();
    var reportMonth;
    if (req.query && req.query.month) {
      reportMonth = req.query.month;
    } else {
      var prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      reportMonth = prev.getUTCFullYear() + '-' + String(prev.getUTCMonth() + 1).padStart(2, '0') + '-01';
    }

    var dryRun = req.query && req.query.dry_run === 'true';

    // Fetch all clients ready for monthly compilation.
    // Both flags must be set: active is the manual kill-switch the team
    // can flip to pause a client without breaking lock state, and
    // keywords_locked_at is the gate proving the client passed the
    // readiness check (GBP + GSC + LF + keywords). Without keywords_locked_at
    // we'd queue a half-configured client and produce a broken snapshot.
    var configs = await sb.query('report_configs?active=eq.true&keywords_locked_at=not.is.null&select=client_slug,gsc_property');

    if (!configs || configs.length === 0) {
      // Prune error logs older than 30 days (monthly housekeeping)
    try {
      await sb.mutate('rpc/prune_old_errors', 'POST', null);
    } catch (e) { /* non-critical */ }

    return res.status(200).json({ success: true, message: 'No active+locked report configs found', queued: 0 });
    }

    // Check which clients already have a queue entry for this month
    var existing = await sb.query('report_queue?report_month=eq.' + reportMonth + '&select=client_slug,status');
    var existingMap = {};
    if (existing && Array.isArray(existing)) {
      existing.forEach(function(e) { existingMap[e.client_slug] = e.status; });
    }

    // Build queue entries, staggered 3 minutes apart
    var baseTime = new Date();
    var queued = [];
    var skipped = [];
    var staggerMinutes = 3;

    configs.forEach(function(cfg, idx) {
      if (existingMap[cfg.client_slug]) {
        skipped.push({ slug: cfg.client_slug, reason: 'already queued (' + existingMap[cfg.client_slug] + ')' });
        return;
      }
      var scheduledFor = new Date(baseTime.getTime() + idx * staggerMinutes * 60 * 1000);
      queued.push({
        client_slug: cfg.client_slug,
        report_month: reportMonth,
        status: 'pending',
        scheduled_for: scheduledFor.toISOString(),
        attempt: 0
      });
    });

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dry_run: true,
        report_month: reportMonth,
        total_configs: configs.length,
        would_queue: queued.length,
        would_skip: skipped.length,
        queue_preview: queued.map(function(q) { return { slug: q.client_slug, scheduled_for: q.scheduled_for }; }),
        skipped: skipped
      });
    }

    // Insert queue entries. Prefer: resolution=ignore-duplicates handles the
    // race where two concurrent cron invocations both see an empty existingMap
    // and try to insert the same (client_slug, report_month) pairs. DB-level
    // UNIQUE constraint (report_queue_client_month_uq) makes the drop safe.
    var inserted = 0;
    if (queued.length > 0) {
      try {
        var result = await sb.mutate(
          'report_queue',
          'POST',
          queued,
          'return=representation,resolution=ignore-duplicates'
        );
        inserted = Array.isArray(result) ? result.length : queued.length;
        if (inserted < queued.length) {
          monitor.logError('cron/enqueue-reports', new Error('Duplicate queue insert detected'), {
            detail: {
              stage: 'insert_race',
              attempted: queued.length,
              inserted: inserted,
              dropped: queued.length - inserted,
              report_month: reportMonth
            }
          });
        }
      } catch (e) {
        return res.status(500).json({ error: 'Failed to insert queue entries', detail: e.message });
      }
    }

    return res.status(200).json({
      success: true,
      report_month: reportMonth,
      total_configs: configs.length,
      queued: inserted,
      skipped: skipped.length,
      skipped_details: skipped,
      first_scheduled: queued.length > 0 ? queued[0].scheduled_for : null,
      last_scheduled: queued.length > 0 ? queued[queued.length - 1].scheduled_for : null
    });

  } catch (err) {
    monitor.logError('cron/enqueue-reports', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Report enqueue failed' });
  }
}

module.exports = cronRuns.withTracking('enqueue-reports', handler);

