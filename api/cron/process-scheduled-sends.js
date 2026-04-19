// /api/cron/process-scheduled-sends.js
// Runs every 5 minutes via Vercel Cron.
//
// Picks up:
//   - status='scheduled' rows whose scheduled_at has passed
//   - status='failed' rows eligible for retry (send_retriable=true,
//     send_attempt_count<MAX_ATTEMPTS, send_next_attempt_at<=now)
// and attempts to send each via /api/send-newsletter.
//
// Retry policy (cron audit H3):
//   - MAX_ATTEMPTS=3. Backoff 5min → 15min → 60min.
//   - Transient failures (429, 5xx, timeouts, network): bump attempt,
//     extend send_next_attempt_at. send_retriable stays true.
//   - Permanent failures (400/401/403/404 from /api/send-newsletter):
//     short-circuit to send_retriable=false immediately.
//   - After MAX_ATTEMPTS on a transient path: send_retriable=false and
//     monitor.critical fires (emails chris@moonraker.ai).
//
// All failure paths set last_send_error so admins can inspect the cause.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

var MAX_ATTEMPTS = 3;
var BACKOFF_MINUTES = [5, 15, 60]; // applied after attempt 1, 2, 3 respectively

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var cronSecret = process.env.CRON_SECRET || '';

  try {
    var now = new Date().toISOString();

    // Pull newly scheduled rows + retry-eligible failed rows in two queries,
    // then merge and cap at 5. Two queries keeps PostgREST simple and avoids
    // an or() expression; the index on (status, send_next_attempt_at) makes
    // the retry query cheap.
    var scheduled = await sb.query(
      'newsletters?status=eq.scheduled&scheduled_at=lte.' + now +
      '&select=id,edition_number,scheduled_at,send_attempt_count&limit=5'
    );
    var retriable = await sb.query(
      'newsletters?status=eq.failed&send_retriable=eq.true' +
      '&send_attempt_count=lt.' + MAX_ATTEMPTS +
      '&send_next_attempt_at=lte.' + now +
      '&select=id,edition_number,scheduled_at,send_attempt_count&limit=5'
    );

    var due = (scheduled || []).concat(retriable || []).slice(0, 5);

    if (due.length === 0) {
      return res.status(200).json({ message: 'No scheduled sends due', checked_at: now });
    }

    var results = [];
    for (var i = 0; i < due.length; i++) {
      var nl = due[i];
      var attempt = (nl.send_attempt_count || 0) + 1;
      console.log(
        'Processing send: Edition #' + nl.edition_number +
        ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + ')'
      );

      try {
        var sendResp = await fetch('https://clients.moonraker.ai/api/send-newsletter', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cronSecret
          },
          body: JSON.stringify({ newsletter_id: nl.id, tier: 'all' })
        });

        var sendData = null;
        try { sendData = await sendResp.json(); } catch (e) {}

        if (sendResp.ok) {
          // /api/send-newsletter flips status=sent itself. Nothing to do here.
          results.push({
            edition: nl.edition_number,
            status: 'sent',
            attempt: attempt,
            sent: sendData && sendData.sent
          });
        } else {
          var errMsg = (sendData && sendData.error) || ('HTTP ' + sendResp.status);
          var permanent = isPermanentHttpStatus(sendResp.status);
          await recordFailure(nl, attempt, errMsg, permanent);
          results.push({
            edition: nl.edition_number,
            status: permanent ? 'terminal' : (attempt >= MAX_ATTEMPTS ? 'exhausted' : 'retrying'),
            attempt: attempt,
            error: errMsg,
            resend_status: sendResp.status
          });
        }
      } catch (e) {
        // Network error, timeout, JSON parse error, etc. — treat as transient.
        var errMsg = e && e.message ? e.message : 'Send failed';
        await recordFailure(nl, attempt, errMsg, false);
        monitor.logError('cron/process-scheduled-sends', e, {
          detail: { stage: 'send_per_edition', edition: nl.edition_number, attempt: attempt }
        });
        results.push({
          edition: nl.edition_number,
          status: attempt >= MAX_ATTEMPTS ? 'exhausted' : 'retrying',
          attempt: attempt,
          error: errMsg
        });
      }
    }

    return res.status(200).json({ processed: results.length, results: results });
  } catch (e) {
    console.error('process-scheduled-sends FATAL:', e.message);
    monitor.logError('cron/process-scheduled-sends', e, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Scheduled sends processing failed' });
  }
};

// 4xx (other than 408/429) are bad-request style errors. No point retrying.
function isPermanentHttpStatus(status) {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

async function recordFailure(nl, attempt, errMsg, permanent) {
  var now = new Date().toISOString();
  var retriable = !permanent && attempt < MAX_ATTEMPTS;
  var backoffMin = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)];
  var nextAttempt = retriable
    ? new Date(Date.now() + backoffMin * 60 * 1000).toISOString()
    : null;

  await sb.mutate('newsletters?id=eq.' + nl.id, 'PATCH', {
    status: 'failed',
    send_attempt_count: attempt,
    last_send_error: (errMsg || 'Unknown').substring(0, 1000),
    send_retriable: retriable,
    send_next_attempt_at: nextAttempt,
    updated_at: now
  });

  if (!retriable) {
    await monitor.critical('cron/process-scheduled-sends', new Error(
      'Newsletter send exhausted (edition #' + nl.edition_number + '): ' + errMsg
    ), {
      detail: {
        newsletter_id: nl.id,
        edition: nl.edition_number,
        attempts: attempt,
        permanent: permanent,
        last_error: errMsg
      }
    });
  }
}
