// api/send-newsletter.js
// Sends a newsletter to active subscribers via Resend.
// POST { newsletter_id, tier: 'all' | 'hot' | 'warm', override_limit: number (optional) }
// Chunks into batches of 50, logs each send to newsletter_sends.
// Warm-up: reads newsletter_warmup setting to limit sends and auto-ramp.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var nl = require('./_lib/newsletter-template');

var RESEND_KEY = process.env.RESEND_API_KEY_NEWSLETTER || process.env.RESEND_API_KEY;
var FROM_ADDRESS = 'Scott Pope <newsletter@newsletter.moonraker.ai>';
var REPLY_TO = 'scott@moonraker.ai';
var BATCH_SIZE = 50;

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
    var newsletters = await sb.query('newsletters?id=eq.' + newsletterId + '&select=*');
    if (!newsletters.length) return res.status(404).json({ error: 'Newsletter not found' });
    var newsletter = newsletters[0];

    // TEST SEND: send to specific email with CC to chris, skip all warm-up/subscriber logic
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

    // Read warm-up settings
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
          // null sendLimit = no limit (past ramp schedule)
        }
      }
    } catch (e) {
      // Non-fatal, continue without warmup
      console.error('Failed to read warmup settings:', e.message);
    }

    // Override limit takes precedence
    if (overrideLimit && overrideLimit > 0) {
      sendLimit = overrideLimit;
    }

    // Mark as sending
    await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', {
      status: 'sending'
    });

    // Fetch subscribers based on tier
    // Order: hot engagement first, then warm, then cold; oldest first within each tier
    var subFilter = 'status=eq.active';
    if (tier === 'hot') {
      subFilter += '&engagement_tier=eq.hot';
    } else if (tier === 'warm') {
      subFilter += '&engagement_tier=in.(hot,warm)';
    }

    // Determine how many to fetch
    var fetchLimit = sendLimit ? sendLimit + 100 : 5000; // fetch extra for safety
    var orderBy = 'order=engagement_tier.asc,subscribed_at.asc'; // hot < warm < cold alphabetically

    var subscribers = await sb.query('newsletter_subscribers?' + subFilter + '&select=id,email,first_name&' + orderBy + '&limit=' + fetchLimit);

    if (!subscribers.length) {
      await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', { status: 'draft' });
      return res.status(400).json({ error: 'No subscribers match the selected tier' });
    }

    // Check which subscribers already received this newsletter (for re-sends / partial sends)
    var alreadySent = {};
    try {
      var existing = await sb.query('newsletter_sends?newsletter_id=eq.' + newsletterId + '&status=eq.sent&select=subscriber_id&limit=5000');
      for (var e = 0; e < existing.length; e++) {
        alreadySent[existing[e].subscriber_id] = true;
      }
    } catch (e) {
      // Non-fatal
    }

    // Filter out already-sent subscribers
    var eligibleSubscribers = subscribers.filter(function(s) {
      return !alreadySent[s.id];
    });

    // Apply send limit
    var sendList = sendLimit ? eligibleSubscribers.slice(0, sendLimit) : eligibleSubscribers;

    var totalSent = 0;
    var totalFailed = 0;
    var errors = [];

    // Process in batches
    for (var i = 0; i < sendList.length; i += BATCH_SIZE) {
      var batch = sendList.slice(i, i + BATCH_SIZE);

      var sendPromises = batch.map(function(sub) {
        var emailHtml = nl.build(newsletter, sub.id);

        return fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [sub.email],
            reply_to: REPLY_TO,
            subject: newsletter.subject || 'Moonraker Weekly Newsletter',
            html: emailHtml,
            headers: {
              'List-Unsubscribe': '<https://clients.moonraker.ai/api/newsletter-unsubscribe?sid=' + sub.id + '>',
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
          })
        }).then(async function(r) {
          var data = await r.json();
          if (r.ok && data.id) {
            return { subscriber_id: sub.id, resend_message_id: data.id, status: 'sent' };
          } else {
            return { subscriber_id: sub.id, status: 'failed', error: data.message || 'Unknown error' };
          }
        }).catch(function(err) {
          return { subscriber_id: sub.id, status: 'failed', error: err.message };
        });
      });

      var results = await Promise.all(sendPromises);

      // Log sends to newsletter_sends
      var sendRecords = results.map(function(r) {
        if (r.status === 'sent') {
          totalSent++;
          return {
            newsletter_id: newsletterId,
            subscriber_id: r.subscriber_id,
            status: 'sent',
            resend_message_id: r.resend_message_id,
            sent_at: new Date().toISOString()
          };
        } else {
          totalFailed++;
          if (r.error) errors.push(r.error);
          return {
            newsletter_id: newsletterId,
            subscriber_id: r.subscriber_id,
            status: 'pending'
          };
        }
      });

      // Batch insert send records
      if (sendRecords.length) {
        try {
          await sb.mutate('newsletter_sends', 'POST', sendRecords);
        } catch (e) {
          console.error('Failed to log sends:', e.message);
        }
      }

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < sendList.length) {
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      }
    }

    // Update newsletter stats and status
    var finalStatus = totalSent > 0 ? 'sent' : 'failed';
    await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', {
      status: finalStatus,
      sent_at: new Date().toISOString(),
      stats_total_sent: (newsletter.stats_total_sent || 0) + totalSent,
      stats_bounced: (newsletter.stats_bounced || 0) + totalFailed
    });

    // Auto-advance warm-up step after successful send
    if (warmup && warmup.enabled && totalSent > 0 && !overrideLimit) {
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
    }

    return res.status(200).json({
      sent: totalSent,
      failed: totalFailed,
      total_subscribers: subscribers.length,
      eligible: eligibleSubscribers.length,
      send_limit: sendLimit,
      warmup_step: warmup ? (warmup.current_step || 0) : null,
      warmup_enabled: warmup ? warmup.enabled : false,
      errors: errors.slice(0, 5)
    });

  } catch (e) {
    console.error('send-newsletter error:', e);
    try {
      if (body && body.newsletter_id) {
        await sb.mutate('newsletters?id=eq.' + body.newsletter_id, 'PATCH', { status: 'failed' });
      }
    } catch (e2) {}
    return res.status(500).json({ error: e.message });
  }
};

