// api/admin/backfill-stripe-ids.js
//
// One-shot maintenance endpoint: scan paying contacts (status in onboarding,
// active) whose contacts.stripe_customer_id or contacts.stripe_subscription_id
// is NULL, look the customer up in Stripe by email, and PATCH the missing IDs.
//
// History: stripe-webhook.js was never writing these fields — every Stripe ID
// in the contacts table prior to 2026-04-28 came from manual SQL. The webhook
// has now been fixed; this endpoint reconciles the historical gap.
//
// Auth: admin JWT or CRON_SECRET (requireAdminOrInternal).
// Body: { dry_run?: boolean (default true), limit?: number (default 200) }
// Response: { scanned, eligible, customer_filled, subscription_filled, skipped, errors[] }
//
// Idempotent: skips contacts that already have both IDs. Safe to re-run.
// Never overwrites a non-null value (uses PostgREST is.null filter).

var sb = require('../_lib/supabase');
var auth = require('../_lib/auth');

var STRIPE_API = 'https://api.stripe.com/v1';

function stripeFetch(path, secret) {
  return fetch(STRIPE_API + path, {
    headers: { 'Authorization': 'Bearer ' + secret }
  }).then(function(r) {
    return r.json().then(function(j) { return { ok: r.ok, status: r.status, body: j }; });
  });
}

// Pick the best Stripe customer for a contact when search returns multiples.
// Prefer customers that have an active or trialing subscription; fall back to
// the most recently created.
async function pickCustomer(customers, secret) {
  if (!customers || customers.length === 0) return null;
  if (customers.length === 1) return customers[0];

  // Look for one with an active/trialing subscription
  for (var i = 0; i < customers.length; i++) {
    var subs = await stripeFetch('/subscriptions?customer=' + encodeURIComponent(customers[i].id) + '&limit=5&status=all', secret);
    if (subs.ok && subs.body && Array.isArray(subs.body.data)) {
      var liveSub = subs.body.data.find(function(s) {
        return s.status === 'active' || s.status === 'trialing' || s.status === 'past_due';
      });
      if (liveSub) {
        customers[i]._matchedSubscription = liveSub.id;
        return customers[i];
      }
    }
  }
  // Most recent
  return customers.slice().sort(function(a, b) { return (b.created || 0) - (a.created || 0); })[0];
}

async function findSubscription(customerId, secret) {
  var subs = await stripeFetch('/subscriptions?customer=' + encodeURIComponent(customerId) + '&limit=5&status=all', secret);
  if (!subs.ok || !subs.body || !Array.isArray(subs.body.data) || subs.body.data.length === 0) return null;
  // Prefer active/trialing/past_due; else most recently created
  var live = subs.body.data.find(function(s) {
    return s.status === 'active' || s.status === 'trialing' || s.status === 'past_due';
  });
  if (live) return live.id;
  return subs.body.data.slice().sort(function(a, b) { return (b.created || 0) - (a.created || 0); })[0].id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

  var body = req.body || {};
  var dryRun = body.dry_run !== false; // default true
  var limit = Math.max(1, Math.min(500, parseInt(body.limit, 10) || 200));

  // Pull paying contacts missing at least one Stripe ID.
  // PostgREST `or=` syntax: stripe_customer_id is null OR stripe_subscription_id is null.
  var query =
    'contacts?' +
    'status=in.(onboarding,active)' +
    '&or=(stripe_customer_id.is.null,stripe_subscription_id.is.null)' +
    '&select=id,slug,email,stripe_customer_id,stripe_subscription_id' +
    '&limit=' + limit;

  var rows;
  try {
    rows = await sb.query(query);
  } catch (queryErr) {
    return res.status(500).json({ error: 'Contact lookup failed', detail: queryErr.message });
  }

  var summary = {
    dry_run: dryRun,
    scanned: rows.length,
    eligible: 0,
    customer_filled: 0,
    subscription_filled: 0,
    skipped: 0,
    no_match: [],
    errors: []
  };

  for (var i = 0; i < rows.length; i++) {
    var c = rows[i];
    summary.eligible++;

    try {
      var customerId = c.stripe_customer_id || null;
      var subscriptionId = c.stripe_subscription_id || null;

      // Resolve customer if missing — search by email
      if (!customerId) {
        if (!c.email) { summary.skipped++; summary.no_match.push({ slug: c.slug, reason: 'no_email' }); continue; }
        var custResp = await stripeFetch(
          '/customers?email=' + encodeURIComponent(c.email) + '&limit=10',
          stripeSecret
        );
        if (!custResp.ok) {
          summary.errors.push({ slug: c.slug, stage: 'customer_lookup', status: custResp.status, body: custResp.body });
          continue;
        }
        var customers = (custResp.body && custResp.body.data) || [];
        if (customers.length === 0) { summary.skipped++; summary.no_match.push({ slug: c.slug, email: c.email, reason: 'no_stripe_customer' }); continue; }

        var picked = await pickCustomer(customers, stripeSecret);
        if (!picked) { summary.skipped++; summary.no_match.push({ slug: c.slug, email: c.email, reason: 'pick_failed' }); continue; }
        customerId = picked.id;
        if (picked._matchedSubscription && !subscriptionId) subscriptionId = picked._matchedSubscription;
      }

      // Resolve subscription if still missing
      if (!subscriptionId) {
        var subId = await findSubscription(customerId, stripeSecret);
        if (subId) subscriptionId = subId;
      }

      // Decide what to write — only fill currently-null fields
      var willFillCustomer = !c.stripe_customer_id && !!customerId;
      var willFillSubscription = !c.stripe_subscription_id && !!subscriptionId;

      if (!willFillCustomer && !willFillSubscription) {
        summary.skipped++;
        summary.no_match.push({ slug: c.slug, reason: 'nothing_to_fill', customer_id: customerId, subscription_id: subscriptionId });
        continue;
      }

      if (!dryRun) {
        if (willFillCustomer) {
          await sb.mutate(
            'contacts?id=eq.' + c.id + '&stripe_customer_id=is.null',
            'PATCH',
            { stripe_customer_id: customerId },
            'return=minimal'
          );
        }
        if (willFillSubscription) {
          await sb.mutate(
            'contacts?id=eq.' + c.id + '&stripe_subscription_id=is.null',
            'PATCH',
            { stripe_subscription_id: subscriptionId },
            'return=minimal'
          );
        }
      }

      if (willFillCustomer) summary.customer_filled++;
      if (willFillSubscription) summary.subscription_filled++;
    } catch (rowErr) {
      summary.errors.push({ slug: c.slug, stage: 'row', message: rowErr.message });
    }
  }

  return res.status(200).json(summary);
};
