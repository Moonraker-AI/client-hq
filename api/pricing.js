// /api/pricing.js
// Public GET endpoint returning active pricing tiers for a product.
// Read by _templates/checkout.html and _templates/entity-audit-checkout.html
// so prices are never hardcoded in deployed per-client copies.
//
// Query:
//   GET /api/pricing?product=core_marketing
//   GET /api/pricing?product=entity_audit_premium
//
// Response:
//   { tiers: [ { tier_key, display_name, amount_cents, amount_display, period,
//                detail, payment_method, billing_term, billing_cadence,
//                has_stripe_price_id, ... } ] }
//
// Notes:
//   - stripe_price_id and stripe_payment_link are NEVER returned to the browser;
//     the frontend must POST /api/checkout/create-session to receive a usable URL.
//     This keeps Stripe identifiers off the wire on the initial page load.
//   - amount_display is computed server-side so the template doesn't have to
//     carry formatting logic.

var sb = require('./_lib/supabase');

var ALLOWED_PRODUCTS = ['core_marketing', 'entity_audit_premium'];

function formatAmount(cents) {
  var dollars = cents / 100;
  if (Number.isInteger(dollars)) {
    return dollars.toLocaleString('en-US');
  }
  return dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var product = String(req.query.product || '').trim();
  if (!product) return res.status(400).json({ error: 'product query param required' });
  if (ALLOWED_PRODUCTS.indexOf(product) === -1) {
    return res.status(400).json({ error: 'unknown product', allowed: ALLOWED_PRODUCTS });
  }

  var rows;
  try {
    rows = await sb.query(
      'pricing_tiers?product_key=eq.' + encodeURIComponent(product) +
      '&active=eq.true&order=sort_order.asc&select=' +
      'tier_key,display_name,amount_cents,period,detail,payment_method,billing_term,billing_cadence,' +
      'stripe_price_id,stripe_payment_link'
    );
  } catch (e) {
    return res.status(500).json({ error: 'pricing fetch failed: ' + e.message });
  }

  var tiers = (rows || []).map(function(r) {
    return {
      tier_key: r.tier_key,
      display_name: r.display_name,
      amount_cents: r.amount_cents,
      amount_display: formatAmount(r.amount_cents),
      period: r.period || '',
      detail: r.detail || '',
      payment_method: r.payment_method,
      billing_term: r.billing_term,
      billing_cadence: r.billing_cadence,
      has_stripe_price_id: !!r.stripe_price_id,
      has_payment_link: !!r.stripe_payment_link
    };
  });

  // Edge-cache for 60s: pricing changes are infrequent and the endpoint is hit
  // by every checkout page load. Bust via ?v= if Scott needs instant propagation.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return res.status(200).json({ product: product, tiers: tiers });
};
