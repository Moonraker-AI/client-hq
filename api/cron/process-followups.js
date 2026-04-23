// /api/cron/process-followups.js
// Runs daily via Vercel Cron. Finds pending follow-ups where scheduled_for <= now,
// checks if the prospect has signed up or been marked lost, then sends or cancels.
// Processes up to 10 followups per table per run to stay within function timeout.
//
// Retry policy (cron audit H, Batch 1 Part B) — mirrors process-scheduled-sends:
//   - MAX_ATTEMPTS=3. Backoff 5min -> 15min -> 60min.
//   - Transient failures (429, 5xx, timeouts, network): bump attempt,
//     extend followup_next_attempt_at. followup_retriable stays true.
//   - Permanent failures (400/401/403/404 from Resend): short-circuit to
//     followup_retriable=false immediately.
//   - After MAX_ATTEMPTS on a transient path: followup_retriable=false and
//     monitor.critical fires (emails chris@moonraker.ai).
//
// SELECT extended to include retry-eligible failed rows per table.
// All failure paths set last_followup_error so admins can inspect the cause.

var auth = require('../_lib/auth');
var email = require('../_lib/email-template');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');
var fetchT = require('../_lib/fetch-with-timeout');

var MAX_ATTEMPTS = 3;
var BACKOFF_MINUTES = [5, 15, 60]; // applied after attempt 1, 2, 3 respectively
var PER_TABLE_LIMIT = 10;

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var resendKey = process.env.RESEND_API_KEY;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var now = new Date().toISOString();
  var results = { proposal: { sent: 0, cancelled: 0, failed: 0 }, audit: { sent: 0, cancelled: 0, failed: 0 } };

  try {
    // ── PART 1: Process proposal follow-ups ──
    // Due = pending+scheduled_for<=now OR retry-eligible failed row.
    // Use PostgREST or= to keep the query to a single round trip per table.
    var proposalFilter =
      'or=(' +
        'and(status.eq.pending,scheduled_for.lte.' + now + '),' +
        'and(status.eq.failed,followup_retriable.eq.true,followup_attempt_count.lt.' + MAX_ATTEMPTS +
          ',followup_next_attempt_at.lte.' + now + ')' +
      ')';
    var followups = await sb.query('proposal_followups?' + proposalFilter
      + '&order=scheduled_for.asc&limit=' + PER_TABLE_LIMIT
      + '&select=*,proposals(id,sent_at,status,contacts(id,email,first_name,last_name,practice_name,status,lost))');

    for (var i = 0; i < (followups || []).length; i++) {
      var fu = followups[i];
      var proposal = fu.proposals;
      var contact = proposal ? proposal.contacts : null;

      if (!contact || !contact.email) {
        // Terminal: no retry path resolves a missing contact email.
        await patchRecord('proposal_followups', fu.id, {
          status: 'failed',
          error_message: 'No contact email found',
          last_followup_error: 'No contact email found',
          followup_retriable: false,
          followup_next_attempt_at: null,
          updated_at: now
        });
        results.proposal.failed++;
        continue;
      }

      var cancelStatuses = ['onboarding', 'active'];
      if (cancelStatuses.indexOf(contact.status) !== -1 || contact.lost) {
        var reason = contact.lost ? 'lost' : 'signed_up';
        // Cancel ALL pending rows for this proposal (existing behavior). Retry
        // rows that are status=failed are handled individually below.
        await sb.mutate('proposal_followups?proposal_id=eq.' + proposal.id + '&status=eq.pending', 'PATCH', {
          status: 'cancelled', cancelled_at: now, cancel_reason: reason, updated_at: now
        });
        results.proposal.cancelled++;
        continue;
      }

      var attempt = (fu.followup_attempt_count || 0) + 1;
      var sendResult = await sendFollowupEmail(resendKey, contact, fu, email.FROM.proposals);
      if (sendResult.ok) {
        await patchRecord('proposal_followups', fu.id, {
          status: 'sent',
          sent_at: now,
          followup_attempt_count: attempt,
          followup_retriable: false,
          followup_next_attempt_at: null,
          last_followup_error: null,
          updated_at: now
        });
        results.proposal.sent++;
      } else {
        await recordFailure('proposal_followups', fu, attempt, sendResult.error, sendResult.permanent, 'proposal');
        results.proposal.failed++;
      }
    }

    // ── PART 2: Process audit follow-ups ──
    var auditFilter =
      'or=(' +
        'and(status.eq.pending,scheduled_for.lte.' + now + '),' +
        'and(status.eq.failed,followup_retriable.eq.true,followup_attempt_count.lt.' + MAX_ATTEMPTS +
          ',followup_next_attempt_at.lte.' + now + ')' +
      ')';
    var auditFollowups = await sb.query('audit_followups?' + auditFilter
      + '&order=scheduled_for.asc&limit=' + PER_TABLE_LIMIT
      + '&select=*,contacts(id,email,first_name,last_name,practice_name,status,lost)');

    for (var j = 0; j < (auditFollowups || []).length; j++) {
      var afu = auditFollowups[j];
      var ac = afu.contacts;

      if (!ac || !ac.email) {
        await patchRecord('audit_followups', afu.id, {
          status: 'failed',
          error_message: 'No contact email found',
          last_followup_error: 'No contact email found',
          followup_retriable: false,
          followup_next_attempt_at: null,
          updated_at: now
        });
        results.audit.failed++;
        continue;
      }

      // Audit followups cancel when lead becomes prospect (or beyond) or lost
      var auditCancelStatuses = ['prospect', 'onboarding', 'active'];
      if (auditCancelStatuses.indexOf(ac.status) !== -1 || ac.lost) {
        var aReason = ac.lost ? 'lost' : 'converted_to_prospect';
        await sb.mutate('audit_followups?audit_id=eq.' + afu.audit_id + '&status=eq.pending', 'PATCH', {
          status: 'cancelled', cancelled_at: now, cancel_reason: aReason, updated_at: now
        });
        results.audit.cancelled++;
        continue;
      }

      var aAttempt = (afu.followup_attempt_count || 0) + 1;
      var aSendResult = await sendFollowupEmail(resendKey, ac, afu, email.FROM.audits);
      if (aSendResult.ok) {
        await patchRecord('audit_followups', afu.id, {
          status: 'sent',
          sent_at: now,
          followup_attempt_count: aAttempt,
          followup_retriable: false,
          followup_next_attempt_at: null,
          last_followup_error: null,
          updated_at: now
        });
        results.audit.sent++;
      } else {
        await recordFailure('audit_followups', afu, aAttempt, aSendResult.error, aSendResult.permanent, 'audit');
        results.audit.failed++;
      }
    }

    return res.status(200).json({ ok: true, results: results });
  } catch (e) {
    // CR-M1: Per-row recordFailure already persisted retry state for every
    // known send failure. Returning 500 here would trigger a Vercel retry
    // and risk duplicate Resend sends for rows already marked 'sent' in
    // this tick. Keep 200 + log to monitor.
    monitor.logError('cron/process-followups', e, {
      detail: { stage: 'cron_handler', results: results }
    });
    return res.status(200).json({ ok: false, error: 'Cron failed: ' + (e && e.message ? e.message : 'unknown'), results: results });
  }
}

module.exports = cronRuns.withTracking('process-followups', handler);

// 4xx (other than 408/429) are bad-request style errors. No point retrying.
function isPermanentHttpStatus(status) {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

// Sends one follow-up via Resend. Returns { ok, error, permanent }.
// Retains 15s fetchT timeout from Batch 0.
async function sendFollowupEmail(resendKey, contact, followup, fromAddress) {
  try {
    var emailResp = await fetchT('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddress,
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: followup.subject,
        html: followup.body_html
      })
    }, 15000);
    var emailData = null;
    try { emailData = await emailResp.json(); } catch (e) {}

    if (!emailResp.ok || !emailData || !emailData.id) {
      var resendErrMsg = (emailData && emailData.error && (emailData.error.message || emailData.error))
        || ('Resend ' + emailResp.status);
      monitor.logError('cron/process-followups', new Error('Resend send failed'), {
        detail: {
          stage: 'send_followup_email',
          resend_status: emailResp.status,
          resend_error: emailData && emailData.error ? emailData.error : null,
          contact_email: contact.email,
          followup_id: followup.id
        }
      });
      return {
        ok: false,
        error: typeof resendErrMsg === 'string' ? resendErrMsg : JSON.stringify(resendErrMsg),
        permanent: isPermanentHttpStatus(emailResp.status)
      };
    }
    return { ok: true };
  } catch (e) {
    // Network error, timeout, JSON parse error. Treat as transient.
    var exMsg = e && e.message ? e.message : 'Send failed';
    monitor.logError('cron/process-followups', e, {
      detail: {
        stage: 'send_followup_email_exception',
        contact_email: contact.email,
        followup_id: followup.id
      }
    });
    return { ok: false, error: exMsg, permanent: false };
  }
}

// Persists a failed attempt + bumps retry columns. Fires monitor.critical
// once, at exhaustion (either a permanent error or MAX_ATTEMPTS reached).
async function recordFailure(table, row, attempt, errMsg, permanent, kind) {
  var now = new Date().toISOString();
  var retriable = !permanent && attempt < MAX_ATTEMPTS;
  var backoffMin = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)];
  var nextAttempt = retriable
    ? new Date(Date.now() + backoffMin * 60 * 1000).toISOString()
    : null;
  var shortErr = (errMsg || 'Unknown').substring(0, 1000);

  await sb.mutate(table + '?id=eq.' + row.id, 'PATCH', {
    status: 'failed',
    error_message: shortErr,
    last_followup_error: shortErr,
    followup_attempt_count: attempt,
    followup_retriable: retriable,
    followup_next_attempt_at: nextAttempt,
    updated_at: now
  });

  if (!retriable) {
    await monitor.critical('cron/process-followups', new Error(
      kind + ' followup send exhausted (followup_id=' + row.id + '): ' + shortErr
    ), {
      detail: {
        table: table,
        followup_id: row.id,
        attempts: attempt,
        permanent: permanent,
        last_error: shortErr
      }
    });
  }
}

async function patchRecord(table, id, data) {
  await sb.mutate(table + '?id=eq.' + id, 'PATCH', data);
}
