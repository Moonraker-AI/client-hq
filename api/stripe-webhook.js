// /api/stripe-webhook.js
// Receives Stripe webhook events for payment completions.
// Handles two flows:
//   1. CORE Marketing System purchase: flips contact status to 'onboarding'
//   2. Premium Entity Audit purchase: marks entity audit as 'paid'
//
// This is the server-side backstop for the client-side checkout/success page.
// Even if the browser redirect fails, this ensures status transitions happen.
//
// Setup: In Stripe Dashboard > Webhooks, create an endpoint pointing to
//   https://clients.moonraker.ai/api/stripe-webhook
// Listen for: checkout.session.completed
// Copy the signing secret and add as STRIPE_WEBHOOK_SECRET in Vercel env vars.

var crypto = require('crypto');
var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });

  // ── Read raw body for signature verification ──
  var rawBody = '';
  if (typeof req.body === 'string') {
    rawBody = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (req.body && typeof req.body === 'object') {
    rawBody = JSON.stringify(req.body);
  }

  // ── Verify Stripe signature ──
  {
    var sigHeader = req.headers['stripe-signature'] || '';
    var parts = {};
    sigHeader.split(',').forEach(function(item) {
      var kv = item.split('=');
      if (kv[0]) parts[kv[0].trim()] = kv[1];
    });

    var timestamp = parts['t'];
    var signature = parts['v1'];

    if (!timestamp || !signature) {
      return res.status(400).json({ error: 'Missing Stripe signature components' });
    }

    var age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) {
      return res.status(400).json({ error: 'Webhook timestamp too old' });
    }

    var payload = timestamp + '.' + rawBody;
    var expected = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');

    if (expected !== signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  // ── Parse event ──
  var event;
  try {
    event = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!event || !event.type) return res.status(400).json({ error: 'Missing event type' });

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  var session = event.data && event.data.object;
  if (!session) return res.status(200).json({ received: true, error: 'No session object' });

  var slug = session.client_reference_id || (session.metadata && session.metadata.slug) || '';
  var amountTotal = session.amount_total || 0;
  var paymentStatus = session.payment_status || '';

  if (!slug) {
    console.log('Stripe webhook: no slug found in session', session.id);
    return res.status(200).json({ received: true, warning: 'No client_reference_id or slug metadata' });
  }

  try {
    var contact = await sb.one('contacts?slug=eq.' + slug + '&select=id,status,email,audit_tier&limit=1');
    if (!contact) {
      console.log('Stripe webhook: contact not found for slug', slug);
      return res.status(200).json({ received: true, warning: 'Contact not found: ' + slug });
    }

    var results = { slug: slug, session_id: session.id };

    // Entity Audit: $2,000 (200000 cents) or $2,070 (207000 cents for CC)
    var isEntityAudit = amountTotal === 200000 || amountTotal === 207000;

    if (isEntityAudit) {
      // ── Premium Entity Audit payment ──
      var audits = await sb.query('entity_audits?contact_id=eq.' + contact.id + '&order=created_at.desc&limit=1');
      if (audits && audits.length > 0) {
        var upgradeResult = await sb.mutate('entity_audits?id=eq.' + audits[0].id, 'PATCH', {
          audit_tier: 'premium',
          stripe_payment_id: session.payment_intent || session.id
        });
        if (!upgradeResult || upgradeResult.length === 0) {
          console.error('stripe-webhook: CRITICAL — audit tier upgrade failed for audit ' + audits[0].id + ', payment ' + (session.payment_intent || session.id));
        }
        results.action = 'entity_audit_upgraded';
        results.audit_id = audits[0].id;
      }
    } else {
      // ── CORE Marketing System payment ──
      if (contact.status === 'prospect') {
        var flipResult = await sb.mutate('contacts?slug=eq.' + slug, 'PATCH', { status: 'onboarding' });
        if (!flipResult || flipResult.length === 0) {
          console.error('stripe-webhook: CRITICAL — status flip to onboarding failed for ' + slug + ', payment ' + (session.payment_intent || session.id));
        }
        results.action = 'status_flipped_to_onboarding';
        results.previous_status = 'prospect';

        // Fire team notification (non-blocking)
        try {
          fetch('https://clients.moonraker.ai/api/notify-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
            body: JSON.stringify({ event: 'payment_received', slug: slug })
          }).catch(function(e) { console.log('Notification fire-and-forget error:', e.message); });
        } catch (notifyErr) {
          console.log('Failed to trigger payment notification:', notifyErr.message);
        }

        // Set up quarterly audit schedule (non-blocking)
        // Adopts recent lead audit as baseline if within 30 days, otherwise triggers fresh
        try {
          fetch('https://clients.moonraker.ai/api/setup-audit-schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
            body: JSON.stringify({ contact_id: contact.id })
          }).catch(function(e) { console.log('Audit schedule fire-and-forget error:', e.message); });
        } catch (schedErr) {
          console.log('Failed to trigger audit schedule setup:', schedErr.message);
        }
      } else {
        results.action = 'no_status_change';
        results.reason = 'Contact status is ' + contact.status + ', not prospect';
      }
    }

    // Log the payment (column names corrected to match schema)
    try {
      await sb.mutate('payments', 'POST', {
        contact_id: contact.id,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent || null,
        amount_cents: amountTotal,
        payment_method: session.payment_method_types ? session.payment_method_types[0] : null,
        status: paymentStatus,
        description: isEntityAudit ? 'Entity Audit' : 'CORE Marketing System'
      }, 'return=minimal');
    } catch (logErr) {
      console.log('Failed to log payment:', logErr.message);
    }

    return res.status(200).json({ received: true, results: results });

  } catch (err) {
    monitor.logError('Stripe webhook', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};
