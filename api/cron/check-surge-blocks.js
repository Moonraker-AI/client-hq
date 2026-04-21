// api/cron/check-surge-blocks.js
// Hourly auto-heal for terminally-failed entity audits blocked on Surge.
//
// Policy:
//   - Only rows with status=agent_error AND agent_error_retriable=false
//     AND last_agent_error_code IN ('surge_maintenance','credits_exhausted')
//     are considered healable.
//   - 'surge_rejected', 'target_blocked', and 'generic_exception' are NEVER
//     auto-healed — those require human review (target_blocked = the client
//     site's WAF refused Surge's crawl; fix must happen on the client site,
//     not by requeuing).
//   - Healing means flipping the row back to queued+retriable=true with
//     agent_task_id cleared. The existing 30-min process-audit-queue
//     cron picks it up from there.
//   - Agent is probed via GET /admin/surge-status which logs into Surge
//     with a throwaway browser (no LLM calls, no audit lock).
//
// Failure modes:
//   - Agent unreachable or /admin/surge-status errored: report in
//     response, leave rows blocked, send no email.
//   - Healing PATCH fails for an individual row: log via monitor, skip,
//     continue with other rows. Digest only counts rows that actually
//     flipped.
//
// Vercel cron: every hour on the hour (configured in vercel.json).

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var fetchT = require('../_lib/fetch-with-timeout');
var email = require('../_lib/email-template');
var cronRuns = require('../_lib/cron-runs');

var HEALABLE_CODES = ['surge_maintenance', 'credits_exhausted'];

// Overall handler budget. Vercel's maxDuration for this route is 120s; we
// cap at 90s so that the withTracking finally block has 30s of headroom to
// PATCH cron_runs before Vercel SIGKILLs the process. Prior behavior left
// cron_runs rows stuck in status='running' for an hour (until
// cleanup-stale-runs auto-expired them) because the kill-at-120s happened
// before any return statement fired.
var HANDLER_BUDGET_MS = 90000;
// Agent probe timeout: 30s is enough for a Playwright login + networkidle
// in practice; the previous 90s ate almost the entire function budget on
// any agent-slow event, guaranteeing a Vercel SIGKILL.
var AGENT_PROBE_TIMEOUT_MS = 30000;
// Per-row PATCH timeout — keeps the healing loop bounded even if PostgREST
// slows down. 10 rows × 5s = 50s absolute worst case.
var HEAL_PATCH_TIMEOUT_MS = 5000;

// Returns { promise, cancel } so the caller can Promise.race() against the
// promise AND clear the underlying Node timer once the work completes.
// Without the cancel, the setTimeout keeps the event loop alive after the
// HTTP response has been sent; Vercel's Fluid-compute then freezes/kills
// the instance before the withTracking finally block's PATCH to cron_runs
// commits, leaving cron_runs rows stuck in status='running' until
// cleanup-stale-runs auto-expires them. .unref() is a second line of
// defense in case the caller forgets to cancel.
function budgetTimeout(ms, label) {
  var timer = null;
  var promise = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      reject(new Error('Handler budget exceeded (' + ms + 'ms) at: ' + label));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return {
    promise: promise,
    cancel: function() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

var CODE_LABELS = {
  surge_maintenance: 'Surge maintenance mode',
  credits_exhausted: 'Surge credits exhausted',
  surge_rejected: 'Surge silently rejected submission',
  target_blocked: 'Target site WAF blocked Surge crawl',
  generic_exception: 'Unhandled agent error'
};

async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: 'Agent service not configured' });
  }

  // Global handler watchdog — guarantees we reject (and therefore run the
  // withTracking finally block) before Vercel's maxDuration SIGKILL lands.
  // IMPORTANT: must be cancelled in the outer finally below so the timer
  // does not keep the Node event loop alive after we return, which would
  // cause Vercel to terminate before cron_runs.finish() PATCH commits.
  var watchdogHandle = budgetTimeout(HANDLER_BUDGET_MS, 'handler-global');
  var watchdog = watchdogHandle.promise;

  try {
    // ── Step 1: Find healable blocked audits ──────────────────────
    // Heavy columns (surge_raw_data, tasks, email_body) intentionally
    // omitted. `contacts!contact_id(...)` disambiguates the two FKs.
    var blocked = await Promise.race([
      sb.query(
        'entity_audits?status=eq.agent_error&agent_error_retriable=eq.false' +
        '&last_agent_error_code=in.(' + HEALABLE_CODES.join(',') + ')' +
        '&select=id,client_slug,last_agent_error_code,contact_id,' +
        'contacts!contact_id(practice_name)'
      ),
      watchdog
    ]);

    if (!Array.isArray(blocked)) blocked = [];

    if (blocked.length === 0) {
      return res.status(200).json({
        blocks_found: 0,
        agent_checked: false,
        maintenance_active: null,
        credits: null,
        healed_surge_maintenance: 0,
        healed_credits_exhausted: 0,
        total_healed: 0,
        note: 'No healable blocked audits.'
      });
    }

    // ── Step 2: Probe Surge via the agent ─────────────────────────
    // /ops/surge-status spins up an independent headless browser and
    // reports maintenance_active + credits. 90s timeout covers a full
    // login (Playwright spawn + DOM fill + networkidle).
    //
    // Path is /ops/* (not /admin/*) because Caddy on the agent host
    // routes /admin/* to the out-of-band admin service on port 8001.
    var status = null;
    var statusError = null;

    try {
      var probeResp = await Promise.race([
        fetchT(
          AGENT_URL + '/ops/surge-status',
          { headers: { 'Authorization': 'Bearer ' + AGENT_KEY } },
          AGENT_PROBE_TIMEOUT_MS
        ),
        watchdog
      ]);

      if (!probeResp.ok) {
        statusError = 'Agent /ops/surge-status returned HTTP ' + probeResp.status;
      } else {
        status = await Promise.race([probeResp.json(), watchdog]);
      }
    } catch (e) {
      statusError = 'Agent /ops/surge-status failed: ' + e.message;
    }

    if (!status || status.error || statusError) {
      var reportedError = statusError || (status && status.error) || 'Unknown';
      monitor.warn('cron/check-surge-blocks', 'Could not probe Surge status', {
        detail: { reported_error: reportedError, blocks_found: blocked.length }
      }).catch(function() {});

      return res.status(200).json({
        blocks_found: blocked.length,
        agent_checked: !!status,
        maintenance_active: status ? !!status.maintenance_active : null,
        credits: status ? (status.credits == null ? null : status.credits) : null,
        healed_surge_maintenance: 0,
        healed_credits_exhausted: 0,
        total_healed: 0,
        note: 'Staying blocked: ' + reportedError
      });
    }

    var maintenanceActive = !!status.maintenance_active;
    var credits = (typeof status.credits === 'number') ? status.credits : null;

    // ── Step 3: Per-row decide + heal ─────────────────────────────
    // Per-row PATCH (not batch) so a single failure doesn't mask the
    // rest. Preserves last_agent_error* fields per the retry audit
    // trail invariant.
    var healedMaintenance = 0;
    var healedCredits = 0;
    var healedRows = [];

    for (var i = 0; i < blocked.length; i++) {
      var row = blocked[i];
      var code = row.last_agent_error_code;
      var shouldHeal = false;

      if (code === 'surge_maintenance' && !maintenanceActive) {
        shouldHeal = true;
      } else if (code === 'credits_exhausted' && credits != null && credits > 0) {
        shouldHeal = true;
      }

      if (!shouldHeal) continue;

      try {
        await Promise.race([
          sb.mutate(
            'entity_audits?id=eq.' + row.id,
            'PATCH',
            {
              status: 'queued',
              agent_error_retriable: true,
              agent_task_id: null
            },
            'return=minimal',
            HEAL_PATCH_TIMEOUT_MS
          ),
          watchdog
        ]);

        if (code === 'surge_maintenance') healedMaintenance++;
        else if (code === 'credits_exhausted') healedCredits++;

        healedRows.push({
          id: row.id,
          client_slug: row.client_slug,
          practice_name: (row.contacts && row.contacts.practice_name) || row.client_slug || 'Unknown',
          prior_code: code
        });
      } catch (patchErr) {
        monitor.logError('cron/check-surge-blocks', patchErr, {
          detail: { audit_id: row.id, code: code, stage: 'heal_patch' }
        }).catch(function() {});
      }
    }

    var totalHealed = healedMaintenance + healedCredits;

    // ── Step 4: Digest email (only if something was healed) ───────
    if (totalHealed > 0) {
      try {
        await Promise.race([
          sendDigestEmail(healedRows, maintenanceActive, credits),
          watchdog
        ]);
      } catch (mailErr) {
        monitor.logError('cron/check-surge-blocks', mailErr, {
          detail: { stage: 'digest_email', healed: totalHealed }
        }).catch(function() {});
      }
    }

    return res.status(200).json({
      blocks_found: blocked.length,
      agent_checked: true,
      maintenance_active: maintenanceActive,
      credits: credits,
      healed_surge_maintenance: healedMaintenance,
      healed_credits_exhausted: healedCredits,
      total_healed: totalHealed,
      note: totalHealed > 0
        ? 'Requeued ' + totalHealed + ' audit(s).'
        : 'No conditions met for healing.'
    });
  } catch (err) {
    monitor.logError('cron/check-surge-blocks', err, {
      detail: { stage: 'handler' }
    }).catch(function() {});
    return res.status(500).json({ error: 'check-surge-blocks failed' });
  } finally {
    // Cancel the 90s watchdog timer so Node's event loop doesn't stay alive
    // after we return. Critical: without this, Vercel terminates the
    // instance before withTracking's finally block can PATCH cron_runs.
    watchdogHandle.cancel();
  }
}

module.exports = cronRuns.withTracking('check-surge-blocks', handler);

// ── Digest email builder ──────────────────────────────────────────

async function sendDigestEmail(healedRows, maintenanceActive, credits) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  var esc = email.esc;
  var p = email.p;

  // Table of healed audits: practice name + prior code
  var tableRows = '';
  for (var i = 0; i < healedRows.length; i++) {
    var r = healedRows[i];
    var label = CODE_LABELS[r.prior_code] || r.prior_code;
    tableRows +=
      '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:14px;color:#1E2A5E;font-family:Inter,sans-serif;">' +
      esc(r.practice_name) +
      '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#6B7599;font-family:Inter,sans-serif;">' +
      esc(label) +
      '</td>' +
      '</tr>';
  }

  var closingBits = [];
  closingBits.push(
    'Surge maintenance mode: ' + (maintenanceActive ? 'still active' : 'cleared')
  );
  closingBits.push(
    'Credits: ' + (credits == null ? 'unknown' : String(credits))
  );

  var headerLabel = 'Audit Auto-Requeue';
  var n = healedRows.length;
  var subject = 'Audits Auto-Requeued (' + n + ')';

  var bodyHtml =
    p(
      n + ' entity audit' + (n === 1 ? '' : 's') +
      ' previously blocked on Surge ' +
      (n === 1 ? 'has' : 'have') +
      ' been automatically requeued. The 30-minute queue runner will ' +
      'dispatch ' + (n === 1 ? 'it' : 'them') + ' next.'
    ) +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" ' +
    'style="border:1px solid #E2E8F0;border-radius:8px;margin:0 0 20px;' +
    'border-collapse:separate;border-spacing:0;">' +
    '<thead><tr>' +
    '<th style="padding:8px 12px;background:#F7FDFB;text-align:left;' +
    'font-family:Outfit,sans-serif;font-weight:700;font-size:12px;' +
    'color:#6B7599;text-transform:uppercase;letter-spacing:.04em;' +
    'border-bottom:1px solid #E2E8F0;">Practice</th>' +
    '<th style="padding:8px 12px;background:#F7FDFB;text-align:left;' +
    'font-family:Outfit,sans-serif;font-weight:700;font-size:12px;' +
    'color:#6B7599;text-transform:uppercase;letter-spacing:.04em;' +
    'border-bottom:1px solid #E2E8F0;">Prior Block Reason</th>' +
    '</tr></thead><tbody>' +
    tableRows +
    '</tbody></table>' +
    p('Surge status at time of auto-heal: ' + closingBits.join(', ') + '.');

  var html = email.wrap({
    headerLabel: headerLabel,
    content: bodyHtml,
    footerNote: 'Automated notification from Moonraker Client HQ'
  });

  var resp = await fetchT(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: email.FROM.notifications,
        to: [
          'chris@moonraker.ai',
          'scott@moonraker.ai',
          'support@moonraker.ai'
        ],
        subject: subject,
        html: html
      })
    },
    15000
  );

  if (!resp.ok) {
    var body = '';
    try { body = await resp.text(); } catch (e) {}
    throw new Error('Resend returned ' + resp.status + ': ' + body.substring(0, 200));
  }
}
