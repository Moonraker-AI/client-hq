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

// How long an audit can stay in agent_running before we consider it stale
// (only used when the agent IS actively processing something)
var STALE_THRESHOLD_HOURS = 2;

// How long a 'dispatching' row can sit before we assume the cron crashed
// between the atomic claim and agent dispatch. 2 minutes comfortably covers
// network round-trip + agent accept latency.
var DISPATCHING_STALE_MS = 2 * 60 * 1000;

module.exports = async function handler(req, res) {
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
        await sb.mutate('entity_audits?id=eq.' + staleDispatching[di].id, 'PATCH', {
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
          await sb.mutate('entity_audits?id=eq.' + runningAudits[i].id, 'PATCH', {
            status: 'queued',
            agent_task_id: null
          }, 'return=minimal');
          staleRequeued++;
        }
      } else if (!agentHealthy) {
        // Agent unreachable. Requeue all so they retry once it comes back.
        requeueReason = 'agent_unreachable';
        for (var i = 0; i < runningAudits.length; i++) {
          await sb.mutate('entity_audits?id=eq.' + runningAudits[i].id, 'PATCH', {
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

    // ============================================================
    // STEP 0.5: Flip agent_error rows back to queued for retry.
    // ============================================================
    // Only rows with agent_error_retriable=true are requeued. Terminal
    // failures (credits_exhausted, surge_maintenance, surge_rejected)
    // are set retriable=false by the agent and require manual intervention.
    // 5-min backoff is a safety rail against a submit-time failure being
    // immediately retried in the same cron tick that's about to dispatch;
    // well below the cron interval so no real throttling happens in practice.
    // Do NOT clear last_agent_error / last_agent_error_at when flipping —
    // admins want to see "this row errored N minutes ago, now retrying."
    var errorBackoffCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    var errorRows = await sb.query(
      'entity_audits?status=eq.agent_error' +
      '&agent_error_retriable=eq.true' +
      '&last_agent_error_at=lt.' + encodeURIComponent(errorBackoffCutoff) +
      '&select=id'
    );
    var agentErrorRequeued = 0;
    if (errorRows && errorRows.length > 0) {
      for (var i = 0; i < errorRows.length; i++) {
        await sb.mutate('entity_audits?id=eq.' + errorRows[i].id, 'PATCH', {
          status: 'queued',
          agent_task_id: null
        }, 'return=minimal');
        agentErrorRequeued++;
      }
    }

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
      })
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch (e) {}
      // Mark as error with detail so it doesn't block the queue and so the
      // Step 0.5 agent_error requeue path can back off and retry.
      await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
        status: 'agent_error',
        last_agent_error: ('Agent returned ' + agentResp.status + ': ' +
          errText.substring(0, 400)).substring(0, 500),
        last_agent_error_at: new Date().toISOString()
      }, 'return=minimal');
      return res.status(200).json({
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
    await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
      status: 'agent_running',
      agent_task_id: agentResult.task_id
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
};

