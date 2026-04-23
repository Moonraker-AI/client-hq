// /api/pricing.js
// Public GET endpoint returning pricing data.
//
// Two modes:
//   GET /api/pricing?product=core_marketing
//     → { product, tiers: [...] }
//       Used by _templates/checkout.html and entity-audit-checkout.html.
//       Single-product scoped, array of tiers.
//
//   GET /api/pricing
//     → { tiers: [...], config: { key: value, ... } }
//       Returns every active tier across all products (each row includes its
//       product_key so callers can group client-side) plus the pricing_config
//       key-value map. Used by shared/csa-content.js to render the CSA with
//       live pricing.
//
// Response:
//   { tiers: [ { tier_key, display_name, amount_cents, amount_display, period,
//                detail, payment_method, billing_term, billing_cadence,
//                product_key? } ] }
//
// Notes:
//   - stripe_price_id and stripe_payment_link are NEVER returned to the browser;
//     the frontend must POST /api/checkout/create-session to receive a usable URL.
//     This keeps Stripe identifiers off the wire on the initial page load.
//   - amount_display is computed server-side so the template doesn't have to
//     carry formatting logic.

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');

var ALLOWED_PRODUCTS = ['core_marketing', 'entity_audit_premium', 'addons'];

function formatAmount(cents) {
  var dollars = cents / 100;
  if (Number.isInteger(dollars)) {
    return dollars.toLocaleString('en-US');
  }
  return dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shapeTier(r, includeProductKey) {
  var out = {
    tier_key: r.tier_key,
    display_name: r.display_name,
    amount_cents: r.amount_cents,
    amount_display: formatAmount(r.amount_cents),
    period: r.period || '',
    detail: r.detail || '',
    payment_method: r.payment_method,
    billing_term: r.billing_term,
    billing_cadence: r.billing_cadence
  };
  if (includeProductKey) out.product_key = r.product_key;
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var product = String(req.query.product || '').trim();

  // ── Unscoped mode: return every tier ────────────────────────────────
  // (pricing_config dropped 2026-04-20 — CC surcharge is locked at 3.5% and
  // lives only in shared/csa-content.js CONFIG_DEFAULTS. The `config` field
  // is preserved in the response shape for backward compat with callers
  // that destructure it, but it's always empty.)
  if (!product) {
    var rows;
    try {
      rows = await sb.query(
        'pricing_tiers?active=eq.true&order=product_key.asc,sort_order.asc&select=' +
        'product_key,tier_key,display_name,amount_cents,period,detail,payment_method,billing_term,billing_cadence'
      );
    } catch (e) {
      monitor.logError('pricing', e, { detail: { stage: 'fetch_all_tiers' } });
      return res.status(500).json({ error: 'Pricing fetch failed' });
    }

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return res.status(200).json({
      tiers: (rows || []).map(function(r) { return shapeTier(r, true); }),
      config: {}
    });
  }

  // ── Scoped mode: existing single-product behavior ──────────────────
  if (ALLOWED_PRODUCTS.indexOf(product) === -1) {
    return res.status(400).json({ error: 'unknown product', allowed: ALLOWED_PRODUCTS });
  }

  var rows;
  try {
    rows = await sb.query(
      'pricing_tiers?product_key=eq.' + encodeURIComponent(product) +
      '&active=eq.true&order=sort_order.asc&select=' +
      'tier_key,display_name,amount_cents,period,detail,payment_method,billing_term,billing_cadence'
    );
  } catch (e) {
    monitor.logError('pricing', e, { detail: { stage: 'fetch_scoped_tier', product: product } });
    return res.status(500).json({ error: 'Pricing fetch failed' });
  }

  // Edge-cache for 60s: pricing changes are infrequent and the endpoint is hit
  // by every checkout page load. Bust via ?v= if Scott needs instant propagation.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  return res.status(200).json({
    product: product,
    tiers: (rows || []).map(function(r) { return shapeTier(r, false); })
  });
};
