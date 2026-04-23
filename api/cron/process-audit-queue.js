// /api/cron/process-audit-queue.js
// Runs every 30 minutes. Picks the oldest queued entity audit and triggers the agent.
// Processes one at a time to avoid overwhelming the agent service.
// Also detects stale agent_running tasks and requeues them.
//
// Smart requeue logic:
//   1. Check agent /health — if active_tasks=0 but Supabase has agent_running rows,
//      requeue ALL immediately (container restart wiped them).
//   2. If agent is unreachable, requeue all running tasks so they retry later.
//   3. If agent is busy, only requeue tasks older than STALE_THRESHOLD_HOURS
//      after verifying their individual status via /task/:id.
//
// Vercel cron: every 30 minutes

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

// How long an audit can stay in agent_running before we consider it stale
// (only used when the agent IS actively processing something).
// Override via AUDIT_STALE_THRESHOLD_HOURS env var — useful if audit latency
// changes (e.g., Surge slowdown) without requiring a code deploy.
var STALE_THRESHOLD_HOURS = parseFloat(process.env.AUDIT_STALE_THRESHOLD_HOURS || '2');

// How long a 'dispatching' row can sit before we assume the cron crashed
// between the atomic claim and agent dispatch. 2 minutes comfortably covers
// network round-trip + agent accept latency. Override via env var for the
// same reason as STALE_THRESHOLD_HOURS.
var DISPATCHING_STALE_MS = parseFloat(process.env.AUDIT_DISPATCHING_STALE_MINUTES || '2') * 60 * 1000;

// Classify a non-2xx dispatch response into (retriable, code) + human detail.
//
// Behavior:
//   - 409, 429:        transient, keep retriable (agent busy/rate-limited)
//   - Other 4xx:       payload/auth/not-found. Retry won't help. Terminal.
//   - 5xx + unknown:   network or agent overload. Retry worth trying.
//   - dispatch_attempts >= MAX_DISPATCH_ATTEMPTS: force terminal regardless of
//     class. Operators who fix a root cause and release a capped row must reset
//     dispatch_attempts=0 in the same UPDATE.
//
// The code value feeds last_agent_error_code, which is what the alerter
// (api/cron/agent-error-alerter.js) groups on and what admin UI labels via
// api/admin/audit-blocks.js + api/cron/check-surge-blocks.js CODE_LABELS.
// None of the dispatch_* codes are in HEALABLE_CODES — these all require human
// review before re-dispatch.
var MAX_DISPATCH_ATTEMPTS = 5;

function classifyDispatchFailure(httpStatus, newAttempts) {
  var status = Number(httpStatus) || 0;

  if (newAttempts >= MAX_DISPATCH_ATTEMPTS) {
    return {
      retriable: false,
      code: 'dispatch_attempts_exceeded',
      detail: 'hit cap of ' + MAX_DISPATCH_ATTEMPTS + ' dispatch attempts'
    };
  }

  if (status === 409 || status === 429) {
    return {
      retriable: true,
      code: 'dispatch_' + status + '_transient',
      detail: 'transient ' + status + ', will retry (' + newAttempts + '/' + MAX_DISPATCH_ATTEMPTS + ')'
    };
  }

  if (status >= 400 && status < 500) {
    return {
      retriable: false,
      code: 'dispatch_4xx_' + status,
      detail: 'agent rejected with ' + status + '; payload/auth issue, not retriable'
    };
  }

  // 5xx and unknown / 0 (network failure treated as retriable)
  return {
    retriable: true,
    code: status ? ('dispatch_5xx_' + status) : 'dispatch_network_error',
    detail: (status ? ('agent ' + status) : 'network error') + '; will retry (' + newAttempts + '/' + MAX_DISPATCH_ATTEMPTS + ')'
  };
}

// Safety rail on Step 0 mass-requeue: if we ever flip more than this many
// rows back to queued in one tick, something is seriously wrong (agent wiped
// its task list mid-bulk-run?). Log a warning but still do the requeue —
// the data recovery is correct, we just want to be alerted.
var REQUEUE_RUNAWAY_THRESHOLD = parseInt(process.env.AUDIT_REQUEUE_RUNAWAY_THRESHOLD || '10', 10);

async function handler(req, res) {
  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: 'Agent service not configured' });
  }

  try {
    // Queue snapshot for cron_runs telemetry (queued rows + oldest age).
    try {
      var qRows = await sb.query(
        'entity_audits?status=eq.queued' +
        '&select=created_at&order=created_at.asc&limit=1000'
      );
      if (Array.isArray(qRows) && req._cronRunId) {
        var oldestAge = qRows.length > 0
          ? Math.max(0, Math.floor((Date.now() - new Date(qRows[0].created_at).getTime()) / 1000))
          : 0;
        await cronRuns.snapshot(req._cronRunId, {
          queue_depth: qRows.length,
          oldest_item_age_sec: oldestAge
        });
      }
    } catch (snapErr) { /* telemetry failure never blocks the cron */ }

    // ============================================================
    // STEP 0: Detect and requeue orphaned/stale agent_running tasks
    // ============================================================
    var staleRequeued = 0;
    var staleChecked = 0;
    var requeueReason = null;

    // First, check agent health to detect container restarts
    var agentHealthy = false;
    var agentActiveTasks = -1;
    try {
      var healthResp = await fetch(AGENT_URL + '/health', {
        headers: { 'Authorization': 'Bearer ' + AGENT_KEY },
        signal: AbortSignal.timeout(10000)
      });
      if (healthResp.ok) {
        var healthData = await healthResp.json();
        agentHealthy = true;
        agentActiveTasks = healthData.active_tasks || 0;
      }
    } catch (e) {
      // Agent unreachable
      agentHealthy = false;
    }

    // Requeue stale 'dispatching' rows — these result from a cron invocation
    // crashing between claim_next_audit() (which flipped queued → dispatching)
    // and the agent POST. Anything sitting in dispatching longer than 2 min
    // is stuck; flip it back to queued so the next cron picks it up.
    var dispatchingStaleCutoff = new Date(Date.now() - DISPATCHING_STALE_MS).toISOString();
    var staleDispatching = await sb.query(
      'entity_audits?status=eq.dispatching' +
      '&updated_at=lt.' + encodeURIComponent(dispatchingStaleCutoff) +
      '&select=id,client_slug,updated_at'
    );
    var dispatchingRequeued = 0;
    if (staleDispatching && staleDispatching.length > 0) {
      for (var di = 0; di < staleDispatching.length; di++) {
        await sb.mutate('entity_audits?id=eq.' + staleDispatching[di].id + '&status=eq.dispatching', 'PATCH', {
          status: 'queued',
          agent_task_id: null
        }, 'return=minimal');
        dispatchingRequeued++;
      }
    }

    // Get all agent_running audits from Supabase
    var runningAudits = await sb.query(
      'entity_audits?status=eq.agent_running' +
      '&select=id,agent_task_id,client_slug,updated_at' +
      '&order=updated_at.asc'
    );

    if (runningAudits && runningAudits.length > 0) {
      staleChecked = runningAudits.length;

      if (agentHealthy && agentActiveTasks === 0) {
        // FAST PATH: Agent is up with 0 active tasks, but Supabase shows running audits.
        // Container restart wiped all in-flight work. Requeue everything immediately.
        requeueReason = 'agent_idle_with_running_audits';
        for (var i = 0; i < runningAudits.length; i++) {
          await sb.mutate('entity_audits?id=eq.' + runningAudits[i].id + '&status=eq.agent_running', 'PATCH', {
            status: 'queued',
            agent_task_id: null
          }, 'return=minimal');
          staleRequeued++;
        }
      } else if (!agentHealthy) {
        // Agent unreachable. Requeue all so they retry once it comes back.
        requeueReason = 'agent_unreachable';
        for (var i = 0; i < runningAudits.length; i++) {
          await sb.mutate('entity_audits?id=eq.' + runningAudits[i].id + '&status=eq.agent_running', 'PATCH', {
            status: 'queued',
            agent_task_id: null
          }, 'return=minimal');
          staleRequeued++;
        }
      } else {
        // SLOW PATH: Agent is busy (active_tasks > 0). Only requeue tasks that have
        // exceeded the staleness threshold after confirming with the agent.
        var cutoff = new Date(Date.now() - STALE_THRESHOLD_HOURS * 60 * 60 * 1000);

        for (var i = 0; i < runningAudits.length; i++) {
          var a = runningAudits[i];
          var updatedAt = new Date(a.updated_at);
          if (updatedAt < cutoff) {
            // Check individual task status on the agent (singular /task/ path)
            var agentStatus = null;
            if (a.agent_task_id) {
              try {
                var taskResp = await fetch(AGENT_URL + '/task/' + a.agent_task_id, {
                  headers: { 'Authorization': 'Bearer ' + AGENT_KEY },
                  signal: AbortSignal.timeout(10000)
                });
                if (taskResp.ok) {
                  var taskData = await taskResp.json();
                  agentStatus = taskData.status;
                }
                // 404 = task not found on agent, leave agentStatus null
              } catch (e) {
                agentStatus = 'unreachable';
              }
            }

            // Requeue if agent says error, task not found (404), or unreachable
            if (!agentStatus || agentStatus === 'error' || agentStatus === 'unreachable') {
              requeueReason = requeueReason || 'stale_threshold';
              await sb.mutate('entity_audits?id=eq.' + a.id, 'PATCH', {
                status: 'queued',
                agent_task_id: null
              }, 'return=minimal');
              staleRequeued++;
            }
          }
        }
      }
    }

    // Runaway safety rail — if we just mass-requeued a lot of rows, surface
    // it via monitor so someone can investigate (e.g., agent health flakiness,
    // unexpected container restart loop). Still completes the work.
    var totalStep0Requeued = staleRequeued + dispatchingRequeued;
    if (totalStep0Requeued >= REQUEUE_RUNAWAY_THRESHOLD) {
      monitor.warn('cron/process-audit-queue', 'Step 0 mass-requeue', {
        detail: {
          stale_requeued: staleRequeued,
          dispatching_requeued: dispatchingRequeued,
          requeue_reason: requeueReason,
          agent_healthy: agentHealthy,
          agent_active_tasks: agentActiveTasks,
          threshold: REQUEUE_RUNAWAY_THRESHOLD
        }
      }).catch(function() {});
    }

    // ============================================================
    // STEP 0.5: Flip agent_error rows back to queued for retry (CR-H1).
    // ============================================================
    // Only rows with agent_error_retriable=true are requeued. Terminal
    // failures (credits_exhausted, surge_maintenance, surge_rejected) are
    // set retriable=false by the agent and require manual intervention.
    //
    // 5-min backoff is a safety rail against a submit-time failure being
    // immediately retried in the same cron tick that's about to dispatch.
    // last_agent_error / last_agent_error_at are NOT cleared — admins want
    // to see "errored N minutes ago, now retrying."
    //
    // 2026-04-23 (CR-H1): collapsed the previous SELECT-then-loop-PATCH into
    // a single SECURITY DEFINER RPC with FOR UPDATE SKIP LOCKED. The earlier
    // loop raced Step 1's claim_next_audit under concurrent cron invocations:
    // two ticks could observe the same agent_error row, PATCH it to queued,
    // and both attempt to claim. RPC partitions rows atomically.
    //
    // The RPC matches the legacy filter semantics, including NULL-safe
    // backoff (rows with last_agent_error_at IS NULL are treated as eligible).
    var errorBackoffCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    var requeued = await sb.mutate('rpc/requeue_retriable_agent_errors', 'POST', {
      p_backoff_cutoff: errorBackoffCutoff,
      p_limit: 50
    });
    var agentErrorRequeued = Array.isArray(requeued) ? requeued.length : 0;

    // ============================================================
    // STEP 1: Claim the oldest queued audit atomically and dispatch
    // ============================================================

    // Pre-flight: check queued count before claiming. Lets us return an
    // accurate response when the agent is unreachable/busy without actually
    // flipping a row to dispatching.
    var queuedPreview = await sb.query('entity_audits?status=eq.queued&select=id&limit=1');
    var hasQueued = queuedPreview && queuedPreview.length > 0;

    if (!hasQueued) {
      return res.status(200).json({
        message: 'No queued audits.',
        remaining: 0,
        stale_checked: staleChecked,
        stale_requeued: staleRequeued,
        dispatching_requeued: dispatchingRequeued,
        agent_error_requeued: agentErrorRequeued,
        requeue_reason: requeueReason,
        agent_active_tasks: agentActiveTasks
      });
    }

    // Don't dispatch if agent is unreachable (no claim either — leave row queued)
    if (!agentHealthy) {
      var remainUnreach = await sb.query('entity_audits?status=eq.queued&select=id');
      return res.status(200).json({
        message: 'Agent unreachable, skipping dispatch.',
        remaining: remainUnreach ? remainUnreach.length : 0,
        stale_checked: staleChecked,
        stale_requeued: staleRequeued,
        dispatching_requeued: dispatchingRequeued,
        agent_error_requeued: agentErrorRequeued,
        requeue_reason: requeueReason
      });
    }

    // Don't dispatch if agent already has active tasks (enforce one-at-a-time).
    // agentActiveTasks reflects the count BEFORE our Step 0 requeue, but if we
    // requeued tasks and the agent truly has 0, this won't block.
    if (agentActiveTasks > 0) {
      var remainAll = await sb.query('entity_audits?status=eq.queued&select=id');
      return res.status(200).json({
        message: 'Agent busy (' + agentActiveTasks + ' active), waiting.',
        remaining: remainAll ? remainAll.length : 0,
        stale_checked: staleChecked,
        stale_requeued: staleRequeued,
        dispatching_requeued: dispatchingRequeued,
        agent_error_requeued: agentErrorRequeued,
        agent_active_tasks: agentActiveTasks
      });
    }

    // Atomic claim via RPC. Flips queued → dispatching and returns the row.
    // SKIP LOCKED prevents two concurrent cron invocations from claiming the
    // same row. If another invocation beat us to the last row, claimed is
    // empty and we exit cleanly without dispatching.
    var claimed = await sb.mutate('rpc/claim_next_audit', 'POST', {});

    if (!claimed || !Array.isArray(claimed) || claimed.length === 0) {
      return res.status(200).json({
        message: 'Queued row claimed by another invocation.',
        remaining: 0,
        stale_checked: staleChecked,
        stale_requeued: staleRequeued,
        dispatching_requeued: dispatchingRequeued,
        agent_error_requeued: agentErrorRequeued
      });
    }

    var audit = claimed[0];

    // Get contact details for the agent
    var contact = await sb.one('contacts?id=eq.' + audit.contact_id + '&select=city,state_province,website_url&limit=1');

    // Trigger the agent
    var agentResp = await fetch(AGENT_URL + '/tasks/surge-audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify({
        audit_id: audit.id,
        practice_name: audit.brand_query,
        website_url: audit.homepage_url || (contact && contact.website_url) || '',
        city: (contact && contact.city) || '',
        state: (contact && contact.state_province) || '',
        geo_target: audit.geo_target || '',
        gbp_link: audit.gbp_share_link || '',
        client_slug: audit.client_slug
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch (e) {}
      // Mark as error with detail so it doesn't block the queue. Classifier
      // decides whether Step 0.5 should re-dispatch (409/429/5xx) or whether
      // the row is terminal (other 4xx, or >=MAX_DISPATCH_ATTEMPTS). Without
      // this classification, a 4xx loop was possible (dispatch -> 4xx ->
      // requeue -> same 4xx -> ... forever), which Angela-gwak hit on 2026-04-22
      // before the NOT NULL constraint closed her specific case.
      var newAttempts = (audit.dispatch_attempts || 0) + 1;
      var classified = classifyDispatchFailure(agentResp.status, newAttempts);
      await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
        status: 'agent_error',
        agent_error_retriable: classified.retriable,
        last_agent_error: ('Agent returned ' + agentResp.status + ': ' +
          errText.substring(0, 280) + ' — ' + classified.detail).substring(0, 500),
        last_agent_error_code: classified.code,
        last_agent_error_at: new Date().toISOString(),
        dispatch_attempts: newAttempts
      }, 'return=minimal');
      // Return 200 + success:false (cron audit M3). Row already marked
      // agent_error; Step 0.5 backoff requeue will pick up retriable failures
      // on the next cron tick. Returning 5xx would make Vercel retry this
      // entire cron, which is wasteful — the work to recover is already
      // scheduled via the backoff path.
      return res.status(200).json({
        success: false,
        error: 'Agent returned ' + agentResp.status,
        detail: errText.substring(0, 300),
        audit_id: audit.id,
        slug: audit.client_slug,
        stale_checked: staleChecked,
        stale_requeued: staleRequeued,
        dispatching_requeued: dispatchingRequeued,
        agent_error_requeued: agentErrorRequeued
      });
    }

    var agentResult = await agentResp.json();

    // Agent accepted — flip dispatching → agent_running with the real task_id.
    // Reset dispatch_attempts: this attempt-session was successful, future
    // failures should count from zero again.
    await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
      status: 'agent_running',
      agent_task_id: agentResult.task_id,
      dispatch_attempts: 0
    }, 'return=minimal');

    // Count remaining
    var remaining = await sb.query('entity_audits?status=eq.queued&select=id');
    var remainCount = remaining ? remaining.length : 0;

    return res.status(200).json({
      success: true,
      triggered: audit.client_slug,
      audit_id: audit.id,
      task_id: agentResult.task_id,
      remaining: remainCount,
      stale_checked: staleChecked,
      stale_requeued: staleRequeued,
      dispatching_requeued: dispatchingRequeued,
      agent_error_requeued: agentErrorRequeued,
      requeue_reason: requeueReason,
      agent_active_tasks: agentActiveTasks,
      message: 'Triggered audit for ' + audit.client_slug + '. ' + remainCount + ' remaining in queue.'
    });

  } catch (err) {
    console.error('process-audit-queue error:', err);
    monitor.logError('cron/process-audit-queue', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Audit queue processing failed' });
  }
}

module.exports = cronRuns.withTracking('process-audit-queue', handler);

