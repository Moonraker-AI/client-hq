// /api/checkout/create-session.js
// Creates a Stripe Checkout Session on the fly from pricing_tiers.amount_cents.
// No pre-existing Stripe Price needed — line_items[0].price_data is built inline
// so the DB row is the single source of truth for what gets charged.
//
// Request:
//   POST /api/checkout/create-session
//   { slug, product, tier_key }
//
// Response:
//   200 { url: string, mode: 'session'|'payment_link' }
//   4xx { error }
//
// Legacy fallback: if a tier has a stripe_payment_link (buy.stripe.com/...)
// but no amount_cents, we redirect to that link directly. This only matters
// for rows that predate the inline-price_data flow.

var sb = require('../_lib/supabase');

var ALLOWED_PRODUCTS = ['core_marketing', 'entity_audit_premium', 'addons', 'strategy_call'];

var PRODUCT_NAMES = {
  core_marketing:        'CORE Marketing System',
  entity_audit_premium:  'Premium Entity Audit',
  addons:                'Moonraker Add-on Service',
  strategy_call:         'Paid Strategy Call'
};

// Look up the persistent Stripe Product for this product_key, creating it on
// Stripe the first time we see it. Caching via pricing_products.stripe_product_id
// means every future Checkout Session for that key reports under the same
// Product in the Stripe Dashboard (grouped Payments tab, grouped subs, etc).
async function ensureStripeProduct(productKey, stripeSecret) {
  var row;
  try {
    row = await sb.one('pricing_products?product_key=eq.' + encodeURIComponent(productKey) + '&select=product_key,name,stripe_product_id&limit=1');
  } catch (_) { row = null; }
  if (row && row.stripe_product_id) return row.stripe_product_id;

  var name = (row && row.name) || PRODUCT_NAMES[productKey] || productKey;
  try {
    var resp = await fetch('https://api.stripe.com/v1/products', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + stripeSecret,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'name=' + encodeURIComponent(name) +
            '&metadata[product_key]=' + encodeURIComponent(productKey)
    });
    if (!resp.ok) return null;
    var body = await resp.json();
    if (!body || !body.id) return null;
    // Persist so every subsequent checkout skips creation.
    try {
      await sb.mutate(
        'pricing_products?product_key=eq.' + encodeURIComponent(productKey),
        'PATCH',
        { stripe_product_id: body.id, updated_at: new Date().toISOString() }
      );
    } catch (_) { /* non-fatal — reporting will just create again next call */ }
    return body.id;
  } catch (_) {
    return null;
  }
}

// Encode nested JS object as x-www-form-urlencoded for Stripe's API
// (Stripe accepts bracket notation like line_items[0][price_data][unit_amount]=166700).
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

// Stripe subscription interval inferred from billing_cadence + billing_term.
// Returns { mode: 'payment'|'subscription', recurring?: { interval, interval_count } }.
function inferMode(tier) {
  var cadence = tier.billing_cadence;
  if (cadence === 'monthly') {
    return { mode: 'subscription', recurring: { interval: 'month', interval_count: 1 } };
  }
  if (cadence === 'quarterly') {
    // Stripe supports interval=month, interval_count=3 for quarterly recurring.
    return { mode: 'subscription', recurring: { interval: 'month', interval_count: 3 } };
  }
  // upfront / null cadence => one-off payment
  return { mode: 'payment' };
}

function productDisplayName(product, tier) {
  var base = PRODUCT_NAMES[product] || product;
  var suffix = tier.display_name ? ' — ' + tier.display_name : '';
  return base + suffix;
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

  var contact;
  try {
    // For strategy_call, pull the extra fields we need to pre-fill Scott's
    // calendar on the success page. For other products, keep the slim query.
    var contactSelect = product === 'strategy_call'
      ? 'id,email,first_name,last_name,practice_name,phone,website_url,city'
      : 'id,email,first_name,last_name,practice_name';
    contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=' + contactSelect + '&limit=1');
  } catch (e) {
    return res.status(500).json({ error: 'contact lookup failed: ' + e.message });
  }
  if (!contact) return res.status(404).json({ error: 'contact not found for slug' });

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

  var successUrl, cancelUrl;
  if (product === 'strategy_call') {
    // Strategy Call goes to /strategy-call/success with every candidate
    // pre-fill field in the URL — success page builds the calendar iframe
    // URL from query params and omits anything empty. Only non-empty fields
    // are appended so the URL stays readable (and so the success page's
    // "omit empty" logic matches what actually arrived).
    var scParams = [
      'session_id={CHECKOUT_SESSION_ID}',
      'tier=' + encodeURIComponent(tier_key)
    ];
    function scAppend(key, value) {
      if (value && String(value).trim()) scParams.push(key + '=' + encodeURIComponent(value));
    }
    scAppend('first_name',    contact.first_name);
    scAppend('last_name',     contact.last_name);
    scAppend('email',         contact.email);
    scAppend('phone',         contact.phone);
    scAppend('practice_name', contact.practice_name);
    scAppend('website',       contact.website_url);
    scAppend('city',          contact.city);
    successUrl = origin + '/strategy-call/success?' + scParams.join('&');
    cancelUrl  = origin + '/strategy-call?canceled=1';
  } else {
    successUrl = origin + '/' + slug + '/checkout/success?session_id={CHECKOUT_SESSION_ID}&tier=' + encodeURIComponent(tier_key) + '&product=' + encodeURIComponent(product);
    cancelUrl  = origin + '/' + slug + '/checkout?canceled=1';
  }

  // ── Preferred path: Stripe Checkout Session with inline price_data ──
  if (typeof tier.amount_cents === 'number' && tier.amount_cents > 0) {
    var secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

    // ── Dedup guard: if a non-expired, non-consumed Checkout Session already
    // exists for this (contact, product, tier_key), return its URL instead of
    // minting a new one. Prevents the "triple-tap on slow ACH checkout creates
    // three Stripe subscriptions" failure mode (2026-04-22 Athena McCullough).
    // Stripe Checkout Sessions live 24h by default; we mirror that in
    // pending_checkout_sessions.expires_at. The stripe-webhook clears rows on
    // checkout.session.completed.
    try {
      var existing = await sb.one(
        'pending_checkout_sessions' +
        '?contact_id=eq.' + encodeURIComponent(contact.id) +
        '&product=eq.' + encodeURIComponent(product) +
        '&tier_key=eq.' + encodeURIComponent(tier_key) +
        '&consumed_at=is.null' +
        '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) +
        '&select=stripe_session_id,session_url,mode&limit=1'
      );
      if (existing && existing.session_url) {
        return res.status(200).json({
          url: existing.session_url,
          mode: existing.mode || 'session',
          session_id: existing.stripe_session_id,
          reused: true
        });
      }
    } catch (dedupErr) {
      // Non-fatal: if the dedup read fails, fall through and create a fresh
      // session. Better to create a possible duplicate than to block checkout
      // entirely on a transient Supabase read failure.
      console.warn('create-session: dedup check failed, proceeding', dedupErr && dedupErr.message);
    }

    var modeInfo = inferMode(tier);
    var priceData = {
      currency: 'usd',
      unit_amount: tier.amount_cents
    };
    // Prefer a persistent Stripe Product so Dashboard reports can aggregate
    // by tier. Fall back to inline product_data if the create/fetch failed
    // (e.g. transient Stripe outage) — the checkout still succeeds.
    var stripeProductId = await ensureStripeProduct(product, secret);
    if (stripeProductId) {
      priceData.product = stripeProductId;
    } else {
      priceData.product_data = { name: productDisplayName(product, tier) };
    }
    if (modeInfo.recurring) priceData.recurring = modeInfo.recurring;

    var payload = {
      mode: modeInfo.mode,
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: contact.id,
      customer_email: contact.email || undefined,
      allow_promotion_codes: true,
      line_items: [{ price_data: priceData, quantity: 1 }],
      metadata: {
        contact_id: contact.id,
        slug: slug,
        product: product,
        tier_key: tier_key,
        practice_name: contact.practice_name || ''
      }
    };

    // Payment-method lock. ACH-priced tiers (lower amount, advertised for
    // bank transfer) must NOT accept cards, otherwise a prospect can bypass
    // the 3.5% CC surcharge by paying the ACH amount with a card. CC-priced
    // tiers should not offer ACH because the amount already includes the CC
    // surcharge; ACH-paying that same amount would overcharge the client.
    // Tiers with neither suffix (custom arrangements, legacy rows) leave the
    // decision to Stripe's account-level defaults.
    var lowerKey = tier_key.toLowerCase();
    if (/_ach$/.test(lowerKey)) {
      payload.payment_method_types = ['us_bank_account'];
    } else if (/_cc$/.test(lowerKey)) {
      payload.payment_method_types = ['card'];
    }
    // Stripe requires subscription_data.metadata for subscription mode to get the
    // metadata onto the Subscription object itself, not just the Session.
    //
    // cancel_at is NOT a valid subscription_data field on Checkout Sessions —
    // it's set on the Subscription object itself after creation. See the
    // checkout.session.completed handler in stripe-webhook.js, which reads
    // the tier's billing_term and PATCHes the new Subscription with a
    // cancel_at timestamp so committed plans auto-terminate at term end.
    if (modeInfo.mode === 'subscription') {
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

    // Record for dedup. 24h TTL matches Stripe Checkout Session expiry.
    // Upsert via PostgREST's on_conflict: if a row already exists for
    // (contact_id, product, tier_key) that has since expired or been consumed,
    // overwrite it with the new session. Non-fatal: if this write fails, the
    // session still works for the caller — we just lose dedup for that tier
    // until the next manual retry clears it.
    try {
      var nowIso = new Date().toISOString();
      var expiresIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await sb.mutate(
        'pending_checkout_sessions?on_conflict=contact_id,product,tier_key',
        'POST',
        {
          contact_id: contact.id,
          product: product,
          tier_key: tier_key,
          stripe_session_id: data.id,
          session_url: data.url,
          mode: 'session',
          amount_cents: tier.amount_cents,
          created_at: nowIso,
          expires_at: expiresIso,
          consumed_at: null
        },
        'resolution=merge-duplicates,return=minimal'
      );
    } catch (recErr) {
      console.warn('create-session: failed to record pending_checkout_session', recErr && recErr.message);
    }

    return res.status(200).json({ url: data.url, mode: 'session', session_id: data.id });
  }

  // ── Legacy fallback: buy.stripe.com payment link ───────────────────
  if (tier.stripe_payment_link) {
    var url = tier.stripe_payment_link;
    try {
      var u = new URL(url);
      if (contact.email) u.searchParams.set('prefilled_email', contact.email);
      u.searchParams.set('client_reference_id', contact.id);
      url = u.toString();
    } catch (_) { /* leave raw */ }
    return res.status(200).json({ url: url, mode: 'payment_link' });
  }

  return res.status(500).json({ error: 'tier has no amount_cents and no stripe_payment_link' });
};


