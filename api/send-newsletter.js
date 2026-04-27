// api/send-newsletter.js
// Sends a newsletter to active subscribers via Resend's BATCH endpoint.
// POST { newsletter_id, tier: 'all' | 'hot' | 'warm', override_limit: number (optional), test_email: string (optional) }
//
// Uses https://api.resend.com/emails/batch (up to 100 emails per request, one
// rate-limit unit per request). Previous per-email POST pattern caused 96%
// rate-limit rejections on the 2026-04-17 inaugural send — see post-mortem
// in docs/ or commit history.
//
// Warm-up: reads newsletter_warmup setting to limit sends. Only auto-advances
// the step if success rate is >= 80% (so a rate-limited send doesn't burn
// a ramp step).

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');
var nl = require('./_lib/newsletter-template');

var RESEND_KEY = process.env.RESEND_API_KEY_NEWSLETTER || process.env.RESEND_API_KEY;
var FROM_ADDRESS = 'Scott Pope <newsletter@newsletter.moonraker.ai>';
var REPLY_TO = 'scott@moonraker.ai';
var BATCH_SIZE = 100;               // Resend /emails/batch max
var INTER_BATCH_DELAY_MS = 600;     // keep well under 5 rps; was 300, bumped after batch 3 rejection on edition 33
var WARMUP_SUCCESS_THRESHOLD = 0.80;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};

  try {
    var newsletterId = body.newsletter_id;
    var tier = body.tier || 'all';
    var overrideLimit = body.override_limit ? parseInt(body.override_limit, 10) : null;
    var testEmail = body.test_email || null;

    if (!newsletterId) return res.status(400).json({ error: 'newsletter_id required' });
    if (!RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

    // Fetch newsletter
    var newsletters = await sb.query('newsletters?id=eq.' + encodeURIComponent(newsletterId) + '&select=*');
    if (!newsletters.length) return res.status(404).json({ error: 'Newsletter not found' });
    var newsletter = newsletters[0];

    // ─────────────────────────────────────────────────────────────
    // TEST SEND: one-off to a specific email with CC to Chris.
    // Skips all warm-up/subscriber/tracking logic.
    // ─────────────────────────────────────────────────────────────
    if (testEmail) {
      var testHtml = nl.build(newsletter, 'test');
      var testResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [testEmail],
          cc: ['chris@moonraker.ai'],
          reply_to: REPLY_TO,
          subject: '[TEST] ' + (newsletter.subject || 'Moonraker Weekly Newsletter'),
          html: testHtml
        })
      });
      var testData = await testResp.json();
      if (!testResp.ok) return res.status(500).json({ error: 'Test send failed: ' + (testData.message || 'Unknown error') });
      return res.status(200).json({ success: true, test: true, sent_to: testEmail, cc: 'chris@moonraker.ai', resend_id: testData.id });
    }

    if (newsletter.status === 'sent') return res.status(400).json({ error: 'Newsletter already sent' });
    if (newsletter.status === 'sending') return res.status(400).json({ error: 'Newsletter is currently sending' });

    // ─────────────────────────────────────────────────────────────
    // Warm-up settings
    // ─────────────────────────────────────────────────────────────
    var warmup = null;
    var sendLimit = null;
    try {
      var settings = await sb.query('settings?key=eq.newsletter_warmup&select=value');
      if (settings.length && settings[0].value) {
        warmup = settings[0].value;
        if (warmup.enabled) {
          var step = warmup.current_step || 0;
          var schedule = warmup.ramp_schedule || [250, 500, 750, 1000, 1500, 2000];
          if (step < schedule.length) {
            sendLimit = schedule[step];
          }
          // null sendLimit = past ramp schedule = no limit
        }
      }
    } catch (e) {
      console.error('Failed to read warmup settings:', e.message);
    }
    if (overrideLimit && overrideLimit > 0) sendLimit = overrideLimit;

    // ─────────────────────────────────────────────────────────────
    // Claim "sending" state (fail if another run holds it)
    // ─────────────────────────────────────────────────────────────
    var sendingResult = await sb.mutate('newsletters?id=eq.' + encodeURIComponent(newsletterId), 'PATCH', { status: 'sending' });
    if (!sendingResult || sendingResult.length === 0) {
      return res.status(409).json({ error: 'Newsletter status transition to sending failed — may already be sending or in invalid state' });
    }

    // Subscribers
    var subFilter = 'status=eq.active';
    if (tier === 'hot') subFilter += '&engagement_tier=eq.hot';
    else if (tier === 'warm') subFilter += '&engagement_tier=in.(hot,warm)';

    // Fetch ALL active subscribers in tier. Filtering happens in JS so the dedup
    // doesn't get fooled by a small fetchLimit landing entirely inside the
    // already-sent set. Hard cap of 5000 to keep memory bounded — bump if
    // subscriber base grows past that.
    var fetchLimit = 5000;
    var orderBy = 'order=engagement_tier.asc,subscribed_at.asc';
    var subscribers = await sb.query('newsletter_subscribers?' + subFilter + '&select=id,email,first_name&' + orderBy + '&limit=' + fetchLimit);

    if (!subscribers.length) {
      await sb.mutate('newsletters?id=eq.' + encodeURIComponent(newsletterId), 'PATCH', { status: 'draft' });
      return res.status(400).json({ error: 'No subscribers match the selected tier' });
    }

    // Already-sent dedup (partial re-sends).
    // Treat any non-failed row as already received: 'sent' is the initial insert,
    // but webhooks promote it to 'delivered' / 'opened' / 'clicked' / 'bounced' /
    // 'complained' before a re-send is likely. Only 'failed' (and 'pending', if
    // it ever shows up) means the email never went out.
    var alreadySent = {};
    try {
      var existing = await sb.query('newsletter_sends?newsletter_id=eq.' + newsletterId +
        '&status=in.(sent,delivered,opened,clicked,bounced,complained)' +
        '&select=subscriber_id&limit=5000');
      for (var e = 0; e < existing.length; e++) alreadySent[existing[e].subscriber_id] = true;
    } catch (e) { /* non-fatal */ }

    var eligibleSubscribers = subscribers.filter(function(s) { return !alreadySent[s.id]; });
    var sendList = sendLimit ? eligibleSubscribers.slice(0, sendLimit) : eligibleSubscribers;

    if (sendList.length === 0) {
      await sb.mutate('newsletters?id=eq.' + encodeURIComponent(newsletterId), 'PATCH', { status: 'sent' });
      return res.status(200).json({
        sent: 0, failed: 0, skipped_already_sent: subscribers.length - eligibleSubscribers.length,
        message: 'All eligible subscribers have already received this newsletter'
      });
    }

    var warmupActive = !!(warmup && warmup.enabled && (warmup.current_step || 0) < (warmup.ramp_schedule || []).length);

    // Pre-validate emails. Resend rejects the entire 100-email batch if a single
    // address is malformed (e.g. trailing dot, leading whitespace) — see
    // 2026-04-27 incident on edition #33. We strip invalid addresses up front,
    // record them as 'failed' so the dedup catches them on re-runs, and let the
    // batch endpoint see only well-formed payloads.
    // RFC 5321 in spirit, not letter — Resend's parser is what we have to satisfy.
    var EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
    var invalidRecords = [];
    var validSendList = [];
    for (var v = 0; v < sendList.length; v++) {
      var addr = (sendList[v].email || '').trim();
      if (EMAIL_RE.test(addr)) {
        validSendList.push(sendList[v]);
      } else {
        invalidRecords.push({
          newsletter_id: newsletterId,
          subscriber_id: sendList[v].id,
          status: 'failed'
        });
      }
    }
    if (invalidRecords.length) {
      try { await sb.mutate('newsletter_sends', 'POST', invalidRecords); } catch (e) {
        console.error('failed to record invalid-email rows:', e.message);
      }
      try {
        await monitor.logError('send-newsletter', new Error('Skipped ' + invalidRecords.length + ' invalid email(s)'), {
          severity: 'warning',
          detail: { newsletter_id: newsletterId, count: invalidRecords.length }
        });
      } catch (e) { /* non-fatal */ }
    }
    sendList = validSendList;

    var totalSent = 0;
    var totalFailed = 0;
    var errors = [];
    var insertFailures = 0;

    // ─────────────────────────────────────────────────────────────
    // Send via Resend batch endpoint.
    // One API call per batch of up to 100 emails = one rate-limit unit.
    // Response shape: { data: [{ id }, { id }, ...] } aligned with request order.
    // ─────────────────────────────────────────────────────────────
    for (var i = 0; i < sendList.length; i += BATCH_SIZE) {
      var batch = sendList.slice(i, i + BATCH_SIZE);

      var batchPayload = batch.map(function(sub) {
        return {
          from: FROM_ADDRESS,
          to: [sub.email],
          reply_to: REPLY_TO,
          subject: newsletter.subject || 'Moonraker Weekly Newsletter',
          html: nl.build(newsletter, sub.id, { warmupActive: warmupActive }),
          headers: {
            'List-Unsubscribe': '<https://clients.moonraker.ai/api/newsletter-unsubscribe?sid=' + sub.id + '>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
          }
        };
      });

      var batchResult;
      var batchOk = false;
      var batchErrMsg = null;
      // Retry the whole batch on transient failure (429, 5xx, network).
      // Each retry waits longer to let Resend's window clear.
      var BATCH_RETRY_DELAYS_MS = [2000, 5000];
      for (var batchAttempt = 0; batchAttempt <= BATCH_RETRY_DELAYS_MS.length; batchAttempt++) {
        try {
          var batchResp = await fetch('https://api.resend.com/emails/batch', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + RESEND_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(batchPayload)
          });
          batchResult = await batchResp.json();
          if (batchResp.ok) {
            batchOk = true;
            break;
          }
          batchErrMsg = (batchResult && batchResult.message) || ('HTTP ' + batchResp.status);
          // Only retry on transient codes
          var transient = batchResp.status === 429 || batchResp.status >= 500;
          if (!transient || batchAttempt === BATCH_RETRY_DELAYS_MS.length) break;
          console.error('send-newsletter batch ' + (i / BATCH_SIZE + 1) + ' attempt ' +
            (batchAttempt + 1) + ' transient failure: ' + batchErrMsg + ' — retrying in ' +
            BATCH_RETRY_DELAYS_MS[batchAttempt] + 'ms');
          await new Promise(function(r) { setTimeout(r, BATCH_RETRY_DELAYS_MS[batchAttempt]); });
        } catch (err) {
          batchErrMsg = err.message;
          if (batchAttempt === BATCH_RETRY_DELAYS_MS.length) break;
          console.error('send-newsletter batch ' + (i / BATCH_SIZE + 1) + ' attempt ' +
            (batchAttempt + 1) + ' network error: ' + batchErrMsg + ' — retrying in ' +
            BATCH_RETRY_DELAYS_MS[batchAttempt] + 'ms');
          await new Promise(function(r) { setTimeout(r, BATCH_RETRY_DELAYS_MS[batchAttempt]); });
        }
      }
      if (!batchOk) {
        console.error('send-newsletter batch ' + (i / BATCH_SIZE + 1) + ' rejected after retries: ' + batchErrMsg);
        errors.push('Batch ' + (i / BATCH_SIZE + 1) + ': ' + batchErrMsg);
        // Persist to error_log — Vercel runtime logs truncate at ~80 chars in MCP/UI
        // and the response body's `errors` array isn't always inspected.
        try {
          await monitor.logError('send-newsletter', new Error('Resend batch rejected: ' + batchErrMsg), {
            detail: {
              newsletter_id: newsletterId,
              batch_index: i / BATCH_SIZE,
              batch_size: batch.length,
              raw_response: batchResult
            }
          });
        } catch (e) { /* non-fatal */ }
        batchResult = { data: [] }; // pairing loop treats all as failed
      }

      var responseIds = (batchResult && batchResult.data) || [];

      // Pair responses with batch order. responseIds[k] corresponds to batch[k].
      var sendRecords = batch.map(function(sub, k) {
        var resp = responseIds[k];
        if (resp && resp.id) {
          totalSent++;
          return {
            newsletter_id: newsletterId,
            subscriber_id: sub.id,
            status: 'sent',
            resend_message_id: resp.id,
            sent_at: new Date().toISOString()
          };
        } else {
          totalFailed++;
          return {
            newsletter_id: newsletterId,
            subscriber_id: sub.id,
            status: 'failed'
          };
        }
      });

      // Insert send rows (with retry — silent failure here = broken accounting)
      var insertOK = false;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          await sb.mutate('newsletter_sends', 'POST', sendRecords);
          insertOK = true;
          break;
        } catch (insErr) {
          console.error('newsletter_sends insert attempt ' + (attempt + 1) + ' failed: ' + insErr.message);
          if (attempt < 2) await new Promise(function(r) { setTimeout(r, 500 * (attempt + 1)); });
        }
      }
      if (!insertOK) {
        insertFailures += sendRecords.length;
        // Keep going — abandoning mid-run leaves more damage than pressing on
      }

      if (i + BATCH_SIZE < sendList.length) {
        await new Promise(function(resolve) { setTimeout(resolve, INTER_BATCH_DELAY_MS); });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Update newsletter row: status, stats
    // ─────────────────────────────────────────────────────────────
    // 'sent' only when every eligible subscriber has been processed AND
    // this run had zero failures. Otherwise 'draft' so the admin can re-send
    // to catch the rest without re-hitting those already successful.
    // remainingEligible = subs we'd send to next run (eligibleSubscribers minus
    // the slice we just completed). Warmup-capped runs and override_limit runs
    // both leave remainingEligible > 0 and correctly stay in 'draft'.
    var remainingEligible = Math.max(0, eligibleSubscribers.length - sendList.length);
    var isComplete = (totalFailed === 0 && insertFailures === 0 && remainingEligible === 0);
    var finalStatus = isComplete ? 'sent' : 'draft';
    var finalUpdate = {
      status: finalStatus,
      stats_total_sent: (newsletter.stats_total_sent || 0) + totalSent,
      stats_bounced: newsletter.stats_bounced || 0 // real bounces come from webhook events
    };
    if (isComplete) finalUpdate.sent_at = new Date().toISOString();

    var finalResult = await sb.mutate('newsletters?id=eq.' + encodeURIComponent(newsletterId), 'PATCH', finalUpdate);
    if (!finalResult || finalResult.length === 0) {
      console.error('send-newsletter: final status update failed for newsletter ' + newsletterId);
    }

    // ─────────────────────────────────────────────────────────────
    // Advance warmup only if success rate hit threshold
    // ─────────────────────────────────────────────────────────────
    var successRate = totalSent / (totalSent + totalFailed || 1);
    var canAdvance = warmup && warmup.enabled && !overrideLimit &&
                     totalSent > 0 && successRate >= WARMUP_SUCCESS_THRESHOLD;

    if (canAdvance) {
      try {
        var nextStep = (warmup.current_step || 0) + 1;
        var newWarmup = {
          enabled: nextStep < (warmup.ramp_schedule || []).length,
          current_step: nextStep,
          ramp_schedule: warmup.ramp_schedule || [250, 500, 750, 1000, 1500, 2000],
          sends_completed: (warmup.sends_completed || 0) + 1,
          last_send_date: new Date().toISOString().split('T')[0],
          last_send_count: totalSent
        };
        await sb.mutate('settings?key=eq.newsletter_warmup', 'PATCH', {
          value: newWarmup,
          updated_at: new Date().toISOString()
        });
      } catch (e) {
        console.error('Failed to advance warmup:', e.message);
      }
    } else if (warmup && warmup.enabled && totalSent > 0) {
      console.error('send-newsletter: warmup NOT advanced — success rate ' +
        Math.round(successRate * 100) + '% below ' + Math.round(WARMUP_SUCCESS_THRESHOLD * 100) + '% threshold');
    }

    return res.status(200).json({
      sent: totalSent,
      failed: totalFailed,
      insert_failures: insertFailures,
      success_rate: successRate,
      warmup_advanced: canAdvance,
      total_subscribers: subscribers.length,
      eligible: eligibleSubscribers.length,
      send_limit: sendLimit,
      warmup_step: warmup ? (warmup.current_step || 0) : null,
      warmup_enabled: warmup ? warmup.enabled : false,
      newsletter_status: finalStatus,
      errors: errors.slice(0, 5)
    });

  } catch (e) {
    console.error('send-newsletter error:', e);
    try {
      if (body && body.newsletter_id) {
        await sb.mutate('newsletters?id=eq.' + encodeURIComponent(body.newsletter_id), 'PATCH', { status: 'draft' });
      }
    } catch (e2) {}
    monitor.logError('send-newsletter', e, {
      detail: { stage: 'send_handler' }
    });
    return res.status(500).json({ error: 'Failed to send newsletter' });
  }
};
