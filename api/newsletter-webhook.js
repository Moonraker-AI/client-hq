// api/newsletter-webhook.js
// Resend webhook handler for newsletter event tracking.
// Receives: email.delivered, email.opened, email.clicked,
//           email.bounced, email.complained
// Updates newsletter_sends and newsletter_subscribers tables.
// Configure in Resend dashboard: POST https://clients.moonraker.ai/api/newsletter-webhook

var crypto = require('crypto');
var sb = require('./_lib/supabase');

function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Best-effort diagnostic logger. Never throws; webhook path continues even
// if logging fails. Captures enough context to diagnose signature/routing
// issues without persisting the entire body (which can be large).
async function logEvent(outcome, ctx) {
  try {
    var row = {
      route: 'newsletter-webhook',
      event_type: ctx.eventType || null,
      email_id: ctx.emailId || null,
      outcome: outcome,
      detail: ctx.detail || null,
      headers_snapshot: ctx.headers || null,
      body_snippet: ctx.bodySnippet || null
    };
    await sb.mutate('webhook_log', 'POST', row, 'return=minimal');
  } catch (e) {
    console.error('[webhook log write failed]', e.message);
  }
}

function headerSnapshot(req) {
  // Capture only non-sensitive headers relevant to diagnosis.
  // M5 (2026-04-23): svix-signature is explicitly NOT captured — anyone with
  // a signature + body can replay the webhook within the 300s staleness
  // window, so signatures must never be persisted. We still log the PRESENCE
  // of the signature header (as a boolean and a length-only breadcrumb) so
  // "sig missing" diagnostics work without the raw value.
  var picks = ['svix-id', 'svix-timestamp', 'user-agent', 'content-type', 'content-length', 'x-vercel-id'];
  var out = {};
  for (var i = 0; i < picks.length; i++) {
    var v = req.headers[picks[i]];
    if (v !== undefined) out[picks[i]] = String(v);
  }
  var sig = req.headers['svix-signature'];
  if (sig !== undefined) {
    out['svix-signature-present'] = true;
    out['svix-signature-length'] = String(sig).length;
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var hdrs = headerSnapshot(req);

  var webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[newsletter-webhook] RESEND_WEBHOOK_SECRET not configured');
    await logEvent('no_secret_configured', { headers: hdrs });
    return res.status(500).json({ error: 'webhook not configured' });
  }

  var rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    await logEvent('body_read_failed', { headers: hdrs, detail: { error: e.message } });
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  var bodyUtf8 = rawBody.toString('utf8');
  var snippet = bodyUtf8.length > 500 ? bodyUtf8.slice(0, 500) + '...' : bodyUtf8;

  var svixId = req.headers['svix-id'];
  var svixTimestamp = req.headers['svix-timestamp'];
  var svixSignature = req.headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) {
    await logEvent('sig_missing_headers', { headers: hdrs, bodySnippet: snippet });
    return res.status(401).json({ error: 'Missing webhook signature headers' });
  }

  var ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) {
    await logEvent('sig_bad_timestamp', { headers: hdrs, bodySnippet: snippet });
    return res.status(401).json({ error: 'Invalid webhook timestamp' });
  }
  var age = Math.abs(Date.now() / 1000 - ts);
  if (age > 300) {
    await logEvent('sig_stale', { headers: hdrs, bodySnippet: snippet, detail: { age_seconds: Math.round(age) } });
    return res.status(401).json({ error: 'Webhook timestamp too old' });
  }

  var toSign = svixId + '.' + svixTimestamp + '.' + bodyUtf8;
  var secretBytes;
  try {
    secretBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
  } catch (e) {
    await logEvent('sig_bad_secret_format', { headers: hdrs, detail: { error: e.message } });
    return res.status(500).json({ error: 'Malformed webhook secret' });
  }
  var expected = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');
  var expectedBuf = Buffer.from(expected, 'base64');

  var signatures = svixSignature.split(' ').map(function(s) { return s.replace(/^v1,/, ''); });
  var valid = signatures.some(function(sig) {
    var sigBuf;
    try { sigBuf = Buffer.from(sig, 'base64'); } catch (e) { return false; }
    if (sigBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
  if (!valid) {
    await logEvent('sig_invalid', {
      headers: hdrs,
      bodySnippet: snippet,
      detail: {
        expected_length: expectedBuf.length,
        received_signatures: signatures.length,
        // Redacted lengths only — never log raw signatures or the secret
        received_sig_lengths: signatures.map(function(s) {
          try { return Buffer.from(s, 'base64').length; } catch (e) { return -1; }
        })
      }
    });
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  var body;
  try {
    body = JSON.parse(bodyUtf8);
  } catch (e) {
    await logEvent('bad_json', { headers: hdrs, bodySnippet: snippet, detail: { error: e.message } });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  try {
    if (!body || !body.type) {
      await logEvent('no_type', { headers: hdrs, bodySnippet: snippet });
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    var type = body.type;
    var data = body.data || {};
    // Resend v1 uses `email_id`; be defensive if they later rename to `id`
    var messageId = data.email_id || data.id || '';
    var now = new Date().toISOString();

    if (!messageId) {
      await logEvent('no_email_id', { eventType: type, headers: hdrs, bodySnippet: snippet });
      return res.status(200).json({ ok: true, skipped: 'no message id' });
    }

    var sends = await sb.query('newsletter_sends?resend_message_id=eq.' + encodeURIComponent(messageId) + '&select=id,subscriber_id,newsletter_id,status');
    if (!sends.length) {
      await logEvent('send_not_found', { eventType: type, emailId: messageId, headers: hdrs });
      return res.status(200).json({ ok: true, skipped: 'send record not found' });
    }

    var send = sends[0];
    var updates = {};
    var subUpdates = {};

    switch (type) {
      case 'email.delivered':
        updates.status = 'delivered';
        updates.delivered_at = now;
        subUpdates.last_engaged_at = now;
        await incrementStat(send.newsletter_id, 'stats_delivered');
        break;

      case 'email.opened':
        updates.status = 'opened';
        updates.opened_at = now;
        subUpdates.last_engaged_at = now;
        await incrementStat(send.newsletter_id, 'stats_opened');
        break;

      case 'email.clicked':
        updates.status = 'clicked';
        updates.clicked_at = now;
        subUpdates.last_engaged_at = now;
        await incrementStat(send.newsletter_id, 'stats_clicked');
        break;

      case 'email.bounced':
        updates.status = 'bounced';
        subUpdates.status = 'bounced';
        // Read current bounce_count from subscriber (not send) and increment
        try {
          var subRows = await sb.query('newsletter_subscribers?id=eq.' + encodeURIComponent(send.subscriber_id) + '&select=bounce_count');
          var currentBounces = (subRows[0] && subRows[0].bounce_count) || 0;
          subUpdates.bounce_count = currentBounces + 1;
        } catch (e) {
          subUpdates.bounce_count = 1;
        }
        await incrementStat(send.newsletter_id, 'stats_bounced');
        break;

      case 'email.suppressed':
        // Resend refused to send because the recipient is on its suppression
        // list (past hard bounce or prior complaint). Effectively a bounce
        // from our perspective — the email never left Resend.
        updates.status = 'bounced';
        subUpdates.status = 'bounced';
        try {
          var subRowsSup = await sb.query('newsletter_subscribers?id=eq.' + encodeURIComponent(send.subscriber_id) + '&select=bounce_count');
          var currentSup = (subRowsSup[0] && subRowsSup[0].bounce_count) || 0;
          subUpdates.bounce_count = currentSup + 1;
        } catch (e) {
          subUpdates.bounce_count = 1;
        }
        await incrementStat(send.newsletter_id, 'stats_bounced');
        break;

      case 'email.complained':
        updates.status = 'complained';
        subUpdates.status = 'complained';
        await incrementStat(send.newsletter_id, 'stats_complained');
        break;

      case 'email.sent':
        // Fires the moment Resend accepts the email for sending. We already
        // wrote sent_at when the send-newsletter handler got the batch response,
        // so no update needed. Log and return.
        await logEvent('ok_noop', { eventType: type, emailId: messageId });
        return res.status(200).json({ ok: true, noop: true });

      case 'email.delivery_delayed':
        // Recipient server temporarily deferred. Not a failure — Resend retries.
        // We don't change status here; we'll get email.delivered or email.bounced
        // once the retry resolves.
        await logEvent('ok_noop', { eventType: type, emailId: messageId });
        return res.status(200).json({ ok: true, noop: true });

      default:
        await logEvent('unhandled_type', { eventType: type, emailId: messageId, headers: hdrs });
        return res.status(200).json({ ok: true, skipped: 'unhandled type: ' + type });
    }

    if (Object.keys(updates).length) {
      await sb.mutate('newsletter_sends?id=eq.' + encodeURIComponent(send.id), 'PATCH', updates);
    }
    if (Object.keys(subUpdates).length) {
      await sb.mutate('newsletter_subscribers?id=eq.' + encodeURIComponent(send.subscriber_id), 'PATCH', subUpdates);
    }

    if (type === 'email.opened' || type === 'email.clicked') {
      await sb.mutate('newsletter_subscribers?id=eq.' + encodeURIComponent(send.subscriber_id) + '&engagement_tier=neq.hot', 'PATCH', {
        engagement_tier: 'hot'
      });
    }

    await logEvent('ok', { eventType: type, emailId: messageId, detail: { send_id: send.id } });
    return res.status(200).json({ ok: true, type: type, send_id: send.id });

  } catch (e) {
    console.error('newsletter-webhook error:', e);
    await logEvent('db_error', { headers: hdrs, detail: { error: e.message, stack: (e.stack || '').slice(0, 500) } });
    // Always return 200 to prevent Resend retries on our errors. Detail is in
    // webhook_log via logEvent above — do not leak it in the response body.
    return res.status(200).json({ ok: false });
  }
};

// Disable Vercel's default body parser so we can read the raw bytes that
// svix/Resend actually signed.
module.exports.config = { api: { bodyParser: false } };

async function incrementStat(newsletterId, column) {
  try {
    // Atomic single-statement UPDATE via Postgres RPC. Cannot lose counts
    // under concurrent webhook invocations the way SELECT+PATCH could.
    // The RPC whitelists column names internally to block injection.
    await sb.mutate('rpc/increment_newsletter_stat', 'POST', {
      nl_id: newsletterId,
      col: column
    }, 'return=minimal');
  } catch (e) {
    console.error('incrementStat RPC error:', e.message);
  }
}

