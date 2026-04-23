// /api/cron/process-queue.js - Process next pending report from queue
// Called every 5 minutes by Vercel Cron, or manually.
// Picks ONE eligible item via claim_next_report_queue RPC:
//   - status='pending' AND scheduled_for <= now  (new work)
//   - status='failed' AND report_retriable=true AND report_attempt_count<MAX_ATTEMPTS
//       AND report_next_attempt_at <= now         (retry)
//
// Retry policy (cron audit CR-H3) — mirrors process-scheduled-sends:
//   - MAX_ATTEMPTS=3. Backoff 15min -> 60min -> 240min.
//   - Transient (408/429/5xx, network, timeout, non-JSON): bump attempt,
//     extend report_next_attempt_at. report_retriable stays true.
//   - Permanent (400/401/403/404 from compile-report): short-circuit to
//     report_retriable=false immediately.
//   - After MAX_ATTEMPTS on a transient path: report_retriable=false and
//     monitor.critical fires.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

var MAX_ATTEMPTS = 3;
var BACKOFF_MINUTES = [15, 60, 240]; // applied after attempt 1, 2, 3 respectively

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;


  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    // CR-M3: Queue snapshot for cron_runs telemetry is fire-and-forget now.
    // Previously blocked the claim path on the sb.query; a degraded Supabase
    // read could eat the maxDuration budget before we even attempted to
    // claim a row. withTracking.finish() records the terminal counts on its
    // own, so losing a snapshot is harmless.
    if (req._cronRunId) {
      (async function snapshotAsync() {
        try {
          var nowIso = new Date().toISOString();
          var qRows = await sb.query(
            'report_queue?status=eq.pending&scheduled_for=lte.' + nowIso +
            '&select=scheduled_for&order=scheduled_for.asc&limit=1000'
          );
          if (!Array.isArray(qRows)) return;
          var oldestAge = qRows.length > 0
            ? Math.max(0, Math.floor((Date.now() - new Date(qRows[0].scheduled_for).getTime()) / 1000))
            : 0;
          await cronRuns.snapshot(req._cronRunId, {
            queue_depth: qRows.length,
            oldest_item_age_sec: oldestAge
          });
        } catch (snapErr) { /* telemetry failure never blocks the cron */ }
      })();
    }

    // Atomic claim via RPC (see migrations/2026-04-23-claim-next-report-queue-v2.sql).
    // Returns 0 or 1 rows. FOR UPDATE SKIP LOCKED prevents two overlapping
    // cron invocations from claiming the same row and compiling twice.
    // Claims pending OR retry-eligible failed rows.
    var claimed = await sb.mutate('rpc/claim_next_report_queue', 'POST', {});

    if (!claimed || !Array.isArray(claimed) || claimed.length === 0) {
      return res.status(200).json({ success: true, message: 'No pending items ready to process', processed: 0 });
    }

    var item = claimed[0];
    var attempt = (item.report_attempt_count || 0) + 1;

    // Call compile-report via custom domain (VERCEL_URL is behind deployment protection)
    var baseUrl = 'https://clients.moonraker.ai';

    var compileResp;
    try {
      compileResp = await fetch(baseUrl + '/api/compile-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
        body: JSON.stringify({
          client_slug: item.client_slug,
          report_month: item.report_month
        }),
        signal: AbortSignal.timeout(280000) // 280s timeout (under Vercel's 300s limit)
      });
    } catch (fetchErr) {
      // Network error, timeout, AbortError. Treat as transient.
      var fetchMsg = fetchErr && fetchErr.message ? fetchErr.message : 'Compile fetch failed';
      await recordFailure(item, attempt, fetchMsg, false);
      return res.status(200).json({
        success: false,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        error: fetchMsg,
        attempt: attempt,
        status: attempt >= MAX_ATTEMPTS ? 'exhausted' : 'retrying'
      });
    }

    var compileText = await compileResp.text();
    var compileResult;
    try {
      compileResult = JSON.parse(compileText);
    } catch (parseErr) {
      // Non-JSON response (HTML error page, edge timeout, etc.). HTTP status
      // determines classification: 5xx/408/429 = transient, 4xx = permanent.
      var errorMsg = 'Compile returned non-JSON (HTTP ' + compileResp.status + '): ' + compileText.substring(0, 200);
      var permNonJson = isPermanentHttpStatus(compileResp.status);
      await recordFailure(item, attempt, errorMsg, permNonJson);
      return res.status(200).json({
        success: false,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        error: errorMsg,
        attempt: attempt,
        status: permNonJson ? 'terminal' : (attempt >= MAX_ATTEMPTS ? 'exhausted' : 'retrying')
      });
    }

    if (compileResult.success) {
      // Mark complete; clear retry columns so this row is truly terminal.
      await sb.mutate('report_queue?id=eq.' + item.id, 'PATCH', {
        status: 'complete',
        completed_at: new Date().toISOString(),
        snapshot_id: compileResult.snapshot_id || null,
        error_message: null,
        last_report_error: null,
        report_retriable: false,
        report_next_attempt_at: null
      });

      return res.status(200).json({
        success: true,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        snapshot_id: compileResult.snapshot_id,
        compile_time: compileResult.compile_time || null,
        warnings: compileResult.warnings || [],
        attempt: attempt
      });
    } else {
      // compile-report returned JSON with success:false. Use HTTP status for
      // classification; a 200 with success:false (compile-level validation
      // error) is permanent.
      var errorMsg = compileResult.error || (Array.isArray(compileResult.errors) ? compileResult.errors.join('; ') : null) || 'Unknown compile error';
      var permanent = compileResp.status === 200 ? true : isPermanentHttpStatus(compileResp.status);
      await recordFailure(item, attempt, errorMsg, permanent);

      return res.status(200).json({
        success: false,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        error: errorMsg,
        attempt: attempt,
        status: permanent ? 'terminal' : (attempt >= MAX_ATTEMPTS ? 'exhausted' : 'retrying'),
        warnings: compileResult.warnings || []
      });
    }

  } catch (err) {
    // Outer-catch is a last-resort safety net. The per-row recordFailure
    // path above has already persisted retry state for known failure modes,
    // so returning 500 here would trigger Vercel retry and double-compile
    // on any handler-level bug. Keep 200 + log to monitor.
    monitor.logError('cron/process-queue', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(200).json({ success: false, error: 'Queue processing failed: ' + (err && err.message ? err.message : 'unknown') });
  }
}

module.exports = cronRuns.withTracking('process-queue', handler);

// 4xx (other than 408/429) are bad-request / auth / not-found style errors.
// No point retrying — compile-report will fail the same way on the next tick.
function isPermanentHttpStatus(status) {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// Persists a failed attempt + bumps retry columns. Fires monitor.critical
// once, at exhaustion (either a permanent error or MAX_ATTEMPTS reached).
async function recordFailure(item, attempt, errMsg, permanent) {
  var nowIso = new Date().toISOString();
  var retriable = !permanent && attempt < MAX_ATTEMPTS;
  var backoffMin = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)];
  var nextAttempt = retriable
    ? new Date(Date.now() + backoffMin * 60 * 1000).toISOString()
    : null;
  var shortErr = (errMsg || 'Unknown').substring(0, 1000);

  await sb.mutate('report_queue?id=eq.' + item.id, 'PATCH', {
    status: 'failed',
    completed_at: nowIso,
    error_message: shortErr,
    last_report_error: shortErr,
    report_attempt_count: attempt,
    report_retriable: retriable,
    report_next_attempt_at: nextAttempt
  });

  if (!retriable) {
    await monitor.critical('cron/process-queue', new Error(
      'Report compile exhausted (' + item.client_slug + ' / ' + item.report_month + '): ' + shortErr
    ), {
      client_slug: item.client_slug,
      detail: {
        queue_id: item.id,
        client_slug: item.client_slug,
        report_month: item.report_month,
        attempts: attempt,
        permanent: permanent,
        last_error: shortErr
      }
    });
  }
}
