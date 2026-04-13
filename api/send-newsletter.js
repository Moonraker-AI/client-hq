// api/send-newsletter.js
// Sends a newsletter to active subscribers via Resend.
// POST { newsletter_id, tier: 'all' | 'hot' | 'warm' }
// Chunks into batches of 50, logs each send to newsletter_sends.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var nl = require('./_lib/newsletter-template');

var RESEND_KEY = process.env.RESEND_API_KEY_NEWSLETTER || process.env.RESEND_API_KEY;
var FROM_ADDRESS = 'Moonraker Weekly <newsletter@newsletter.moonraker.ai>';
var BATCH_SIZE = 50;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  try {
    var body = req.body || {};
    var newsletterId = body.newsletter_id;
    var tier = body.tier || 'all';

    if (!newsletterId) return res.status(400).json({ error: 'newsletter_id required' });
    if (!RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

    // Fetch newsletter
    var newsletters = await sb.query('newsletters', 'id=eq.' + newsletterId + '&select=*');
    if (!newsletters.length) return res.status(404).json({ error: 'Newsletter not found' });
    var newsletter = newsletters[0];

    if (newsletter.status === 'sent') return res.status(400).json({ error: 'Newsletter already sent' });
    if (newsletter.status === 'sending') return res.status(400).json({ error: 'Newsletter is currently sending' });

    // Mark as sending
    await sb.mutate('newsletters', 'id=eq.' + newsletterId, 'PATCH', {
      status: 'sending'
    });

    // Fetch subscribers based on tier
    var subFilter = 'status=eq.active';
    if (tier === 'hot') {
      subFilter += '&engagement_tier=eq.hot';
    } else if (tier === 'warm') {
      subFilter += '&engagement_tier=in.(hot,warm)';
    }
    // else 'all' = all active subscribers

    var subscribers = await sb.query('newsletter_subscribers', subFilter + '&select=id,email,first_name&limit=5000');

    if (!subscribers.length) {
      await sb.mutate('newsletters', 'id=eq.' + newsletterId, 'PATCH', { status: 'draft' });
      return res.status(400).json({ error: 'No subscribers match the selected tier' });
    }

    var totalSent = 0;
    var totalFailed = 0;
    var errors = [];

    // Process in batches
    for (var i = 0; i < subscribers.length; i += BATCH_SIZE) {
      var batch = subscribers.slice(i, i + BATCH_SIZE);

      // Send each email individually (Resend batch API sends individual emails)
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
          await sb.mutate('newsletter_sends', '', 'POST', sendRecords);
        } catch (e) {
          console.error('Failed to log sends:', e.message);
        }
      }

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < subscribers.length) {
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      }
    }

    // Update newsletter stats and status
    await sb.mutate('newsletters', 'id=eq.' + newsletterId, 'PATCH', {
      status: totalSent > 0 ? 'sent' : 'failed',
      sent_at: new Date().toISOString(),
      stats_total_sent: totalSent,
      stats_bounced: totalFailed
    });

    return res.status(200).json({
      sent: totalSent,
      failed: totalFailed,
      total_subscribers: subscribers.length,
      errors: errors.slice(0, 5)
    });

  } catch (e) {
    console.error('send-newsletter error:', e);
    // Try to reset status
    try {
      if (body && body.newsletter_id) {
        await sb.mutate('newsletters', 'id=eq.' + body.newsletter_id, 'PATCH', { status: 'failed' });
      }
    } catch (e2) {}
    return res.status(500).json({ error: e.message });
  }
};

