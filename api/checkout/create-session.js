// /api/checkout/create-session.js
// Converts a { slug, tier_key } pair into a payable Stripe URL.
//
// Flow:
//   1. Look up the pricing_tiers row by (product_key inferred from caller, tier_key)
//   2. If stripe_price_id is set: create a real Stripe Checkout Session with
//      success_url, cancel_url, client_reference_id (contact.id), metadata, and
//      customer_email. Return { url: session.url }.
//   3. If only stripe_payment_link is set (legacy buy.stripe.com): return that URL
//      directly. The payment link itself already handles success behaviour in Stripe
//      Dashboard — but we can't plumb contact_id through it, which is why we want
//      to migrate every tier to a stripe_price_id over time.
//
// Request:
//   POST /api/checkout/create-session
//   { slug, product, tier_key, billing_term?, billing_cadence? }
//
// Response:
//   200 { url: string, mode: 'session'|'payment_link' }
//   4xx { error }

var sb = require('../_lib/supabase');

var ALLOWED_PRODUCTS = ['core_marketing', 'entity_audit_premium'];

// Encode a plain JS object as x-www-form-urlencoded Stripe expects,
// with bracket notation for nested fields (line_items[0][price] etc).
function encodeStripeForm(obj, prefix) {
  var parts = [];
  Object.keys(obj).forEach(function(key) {
    var value = obj[key];
    var k = prefix ? prefix + '[' + key + ']' : key;
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeStripeForm(value, k));
    } else if (Array.isArray(value)) {
      value.forEach(function(item, idx) {
        if (typeof item === 'object') {
          parts.push(encodeStripeForm(item, k + '[' + idx + ']'));
        } else {
          parts.push(encodeURIComponent(k + '[' + idx + ']') + '=' + encodeURIComponent(String(item)));
        }
      });
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(value)));
    }
  });
  return parts.join('&');
}

function inferMode(tier) {
  // Monthly / quarterly cadence = recurring subscription. Upfront / one-off = payment.
  if (tier.billing_cadence === 'monthly' || tier.billing_cadence === 'quarterly') return 'subscription';
  if (tier.period === '/month' || tier.period === '/quarter') return 'subscription';
  return 'payment';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var body = req.body || {};
  var slug = String(body.slug || '').trim();
  var product = String(body.product || '').trim();
  var tier_key = String(body.tier_key || '').trim();

  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!product || ALLOWED_PRODUCTS.indexOf(product) === -1) {
    return res.status(400).json({ error: 'valid product required', allowed: ALLOWED_PRODUCTS });
  }
  if (!tier_key) return res.status(400).json({ error: 'tier_key required' });

  // Fetch contact for metadata/customer_email
  var contact;
  try {
    contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id,email,first_name,last_name,practice_name&limit=1');
  } catch (e) {
    return res.status(500).json({ error: 'contact lookup failed: ' + e.message });
  }
  if (!contact) return res.status(404).json({ error: 'contact not found for slug' });

  // Fetch tier
  var tiers;
  try {
    tiers = await sb.query(
      'pricing_tiers?product_key=eq.' + encodeURIComponent(product) +
      '&tier_key=eq.' + encodeURIComponent(tier_key) +
      '&active=eq.true&limit=1'
    );
  } catch (e) {
    return res.status(500).json({ error: 'pricing fetch failed: ' + e.message });
  }
  var tier = tiers && tiers[0];
  if (!tier) return res.status(404).json({ error: 'tier not found or inactive' });

  var origin = (req.headers && (req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'https') + '://' +
                (req.headers['x-forwarded-host'] || req.headers.host)) || 'https://clients.moonraker.ai';
  var successUrl = origin + '/' + slug + '/checkout/success?session_id={CHECKOUT_SESSION_ID}&tier=' + encodeURIComponent(tier_key);
  var cancelUrl  = origin + '/' + slug + '/checkout?canceled=1';

  // ── Preferred path: Stripe Checkout Session ─────────────────────────
  if (tier.stripe_price_id) {
    var secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

    var mode = inferMode(tier);
    var payload = {
      mode: mode,
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: contact.id,
      customer_email: contact.email || undefined,
      allow_promotion_codes: true,
      line_items: [{ price: tier.stripe_price_id, quantity: 1 }],
      metadata: {
        contact_id: contact.id,
        slug: slug,
        product: product,
        tier_key: tier_key,
        practice_name: contact.practice_name || ''
      }
    };
    // Stripe requires subscription_data.metadata for subscription-mode sessions
    // so the metadata lives on the Subscription object as well, not only the Session.
    if (mode === 'subscription') {
      payload.subscription_data = { metadata: payload.metadata };
    } else {
      payload.payment_intent_data = { metadata: payload.metadata };
    }

    var resp;
    try {
      resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + secret,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: encodeStripeForm(payload)
      });
    } catch (e) {
      return res.status(502).json({ error: 'stripe request failed: ' + e.message });
    }

    var data;
    try { data = await resp.json(); } catch (_) { data = {}; }
    if (!resp.ok) {
      return res.status(502).json({ error: 'stripe error', stripe: data && data.error ? data.error.message : ('HTTP ' + resp.status) });
    }
    if (!data.url) return res.status(502).json({ error: 'stripe returned no session url' });

    return res.status(200).json({ url: data.url, mode: 'session', session_id: data.id });
  }

  // ── Fallback: legacy buy.stripe.com payment link ─────────────────────
  if (tier.stripe_payment_link) {
    // Payment links accept prefilled_email as a query param. They do not carry
    // our metadata — the stripe-webhook matches on customer_email or falls back
    // to the slug-derived contact lookup in the payment line-item description.
    var url = tier.stripe_payment_link;
    try {
      var u = new URL(url);
      if (contact.email) u.searchParams.set('prefilled_email', contact.email);
      // client_reference_id is supported on payment links and shows up on the
      // checkout.session.completed event — use it so the webhook can match.
      u.searchParams.set('client_reference_id', contact.id);
      url = u.toString();
    } catch (_) { /* leave raw */ }
    return res.status(200).json({ url: url, mode: 'payment_link' });
  }

  return res.status(500).json({ error: 'tier has neither stripe_price_id nor stripe_payment_link' });
};
