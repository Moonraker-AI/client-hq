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
var fetchT = require('./_lib/fetch-with-timeout');
var sanitizer = require('./_lib/html-sanitizer');

function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });

  // ── Read raw body for signature verification ──
  // Reconstructing via JSON.stringify(req.body) doesn't preserve key order,
  // whitespace, or numeric formatting — so signature verification fails
  // against the exact bytes Stripe signed.
  var rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read request body' });
  }
  var rawBodyStr = rawBody.toString('utf8');

  // ── Verify Stripe signature ──
  // Header format: "t=1492774577,v1=hex...,v1=hex..." (comma-separated;
  // multiple v1 entries possible during secret rotation)
  {
    var sigHeader = req.headers['stripe-signature'] || '';
    var timestamp = null;
    var signatures = [];

    sigHeader.split(',').forEach(function(item) {
      var eq = item.indexOf('=');
      if (eq === -1) return;
      var key = item.substring(0, eq).trim();
      var value = item.substring(eq + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') signatures.push(value);
    });

    if (!timestamp || signatures.length === 0) {
      return res.status(400).json({ error: 'Missing Stripe signature components' });
    }

    var ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) {
      return res.status(400).json({ error: 'Invalid webhook timestamp' });
    }

    var age = Math.abs(Date.now() / 1000 - ts);
    if (age > 300) {
      return res.status(400).json({ error: 'Webhook timestamp too old' });
    }

    var payload = timestamp + '.' + rawBodyStr;
    var expectedHex = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
    var expectedBuf = Buffer.from(expectedHex, 'hex');

    var valid = signatures.some(function(sig) {
      var sigBuf;
      try {
        sigBuf = Buffer.from(sig, 'hex');
      } catch (e) {
        return false;
      }
      // timingSafeEqual throws on length mismatch — guard first.
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    });

    if (!valid) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  // ── Parse event from verified raw body ──
  var event;
  try {
    event = JSON.parse(rawBodyStr);
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
  // Populated by /api/checkout/create-session. Accept both the historical
  // 'core_marketing_system' value and the newer 'core_marketing' key used by
  // the pricing_tiers table so legacy payment links and new Checkout Sessions
  // route the same way. Empty when the buyer used a pre-existing buy.stripe.com
  // link that wasn't tagged with metadata.
  var metadataProduct = (session.metadata && session.metadata.product) || '';
  if (metadataProduct === 'core_marketing') metadataProduct = 'core_marketing_system';

  if (!slug) {
    console.log('Stripe webhook: no slug found in session', session.id);
    return res.status(200).json({ received: true, warning: 'No client_reference_id or slug metadata' });
  }

  try {
    var contact = await sb.one('contacts?slug=eq.' + slug + '&select=id,status,email,audit_tier,practice_name,first_name,last_name&limit=1');
    if (!contact) {
      console.log('Stripe webhook: contact not found for slug', slug);
      return res.status(200).json({ received: true, warning: 'Contact not found: ' + slug });
    }

    var results = { slug: slug, session_id: session.id };

    // Entity Audit identified by metadata first (new inline Checkout flow)
    // then falls back to amount detection for legacy buy.stripe.com links
    // that don't carry metadata. Guard the amount fallback against
    // metadataProduct being a DIFFERENT recognized product (e.g. an addon
    // priced at $2,000 like Standalone Website), otherwise we'd mis-route.
    var isEntityAudit = metadataProduct === 'entity_audit_premium' || (
      !metadataProduct && (amountTotal === 200000 || amountTotal === 207000)
    );

    if (isEntityAudit) {
      // ── Premium Entity Audit payment ──

      // Flip contacts.audit_tier = 'premium' server-side. This used to live
      // client-side in checkout/success/index.html but was silently failing
      // (anon has table-level UPDATE grant but no RLS policy, so PostgREST
      // returned an empty array and nothing was ever actually written —
      // evidence: pre-fix there were 31 entity_audits rows with
      // audit_tier='premium' but zero contacts rows). Idempotent: re-running
      // sets the same value. Runs before the entity_audits lookup so it
      // fires even if the audits row doesn't exist yet for this contact.
      var contactTierResult = await sb.mutate(
        'contacts?id=eq.' + contact.id,
        'PATCH',
        { audit_tier: 'premium' }
      );
      if (!contactTierResult || contactTierResult.length === 0) {
        console.error('stripe-webhook: audit_tier flip to premium returned 0 rows for contact ' + contact.id + ', payment ' + (session.payment_intent || session.id));
      }

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

        // M19 race-case check: if the free scorecard email had already been
        // auto-sent by process-entity-audit before this upgrade landed, the
        // customer paid for premium but already received free delivery. Fire
        // a second-chance Loom team notification so the team can still
        // deliver the premium walkthrough. Idempotent via
        // race_loom_notified_at conditional-PATCH-where-null; process-entity-
        // audit's own post-auto-send re-read may also attempt this claim
        // (if it detected the premium upgrade landed during its processing).
        // Only the first writer to flip race_loom_notified_at from NULL to
        // now() wins the claim and sends the email.
        if (upgradeResult && upgradeResult.length > 0 && upgradeResult[0].auto_sent_at) {
          try {
            var loomClaim = await sb.mutate(
              'entity_audits?id=eq.' + audits[0].id + '&race_loom_notified_at=is.null',
              'PATCH',
              { race_loom_notified_at: new Date().toISOString() }
            );
            if (loomClaim && loomClaim.length > 0) {
              var resendKey = process.env.RESEND_API_KEY;
              if (resendKey) {
                var loomPracticeName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() || '(unknown practice)';
                await fetchT('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
                    to: ['notifications@clients.moonraker.ai'],
                    subject: 'Premium Audit Paid After Free Delivery — Loom Required for ' + sanitizer.sanitizeText(loomPracticeName, 200),
                    html: '<p><strong>Race-case premium audit detected.</strong> The customer paid for a premium entity audit after the free scorecard email had already been auto-sent, so they need a premium delivery to complete their purchase.</p>' +
                      '<p><strong>Client:</strong> ' + sanitizer.sanitizeText((contact.first_name || '') + ' ' + (contact.last_name || ''), 200) + '</p>' +
                      '<p><strong>Practice:</strong> ' + sanitizer.sanitizeText(loomPracticeName, 200) + '</p>' +
                      '<p><strong>Audit ID:</strong> ' + sanitizer.sanitizeText(String(audits[0].id), 64) + '</p>' +
                      '<p style="margin-top:16px;"><strong>Next steps:</strong></p>' +
                      '<ol><li>Record a personalized Loom walkthrough covering the same audit data</li><li>Add the Loom URL to the audit in admin</li><li>Send the premium delivery email from admin</li></ol>' +
                      '<p>The free scorecard already went out; this Loom is the premium top-up.</p>' +
                      '<p><a href="https://clients.moonraker.ai/admin/clients" style="color:#00D47E;">Open in Admin</a></p>'
                  })
                }, 15000);
                results.race_loom_notified = true;
              }
            } else {
              // process-entity-audit already claimed + sent (or the audit row was deleted).
              results.race_loom_already_sent = true;
            }
          } catch (raceLoomErr) {
            try {
              await monitor.logError('stripe-webhook', raceLoomErr, {
                client_slug: slug,
                detail: { stage: 'race_loom_notification', audit_id: audits[0].id, session_id: session.id }
              });
            } catch (_) { /* don't mask the 200 */ }
            results.race_loom_notify_failed = true;
          }
        }
      }
    } else if (metadataProduct === 'core_marketing_system') {
      // ── CORE Marketing System payment ──

      // Look up tier details ONCE so we can use for both the contact PATCH
      // (plan_tier/billing_cadence/commitment_months) and the cancel_at logic
      // below. tier_key comes in as metadata.tier_key e.g. 'annual_monthly_ach'.
      var tierKeyEarly = (session.metadata && session.metadata.tier_key) || '';
      var tierRowEarly = null;
      if (tierKeyEarly) {
        try {
          tierRowEarly = await sb.one(
            'pricing_tiers?product_key=eq.core_marketing&tier_key=eq.' +
            encodeURIComponent(tierKeyEarly) +
            '&select=tier_key,amount_cents,payment_method,billing_term,billing_cadence&limit=1'
          );
        } catch (tierLookupErr) {
          await monitor.logError('stripe-webhook', tierLookupErr, {
            client_slug: slug,
            detail: { stage: 'tier_lookup_early', tier_key: tierKeyEarly, session_id: session.id }
          });
        }
      }

      // Race-resilient status flip: scope the PATCH by status=prospect at the
      // PostgREST filter level so concurrent webhook deliveries for the same
      // session can't each fire the trigger chain. First delivery wins; any
      // later delivery patches 0 rows and takes the no-op branch below.
      //
      // This replaces the older read-then-write gate (`if (contact.status ===
      // 'prospect')`) which was vulnerable to a TOCTOU race between the
      // SELECT and the PATCH.
      var enrichedPatch = { status: 'onboarding' };

      if (tierRowEarly) {
        var isAnnual = tierRowEarly.billing_term === 'annual';
        // Normalize billing_cadence for contacts: quarterly_upfront becomes
        // 'quarterly' (matches canonical Flexible Quarterly), everything
        // else uses the tier's billing_cadence directly.
        var normalizedCadence = tierRowEarly.billing_cadence;
        if (tierKeyEarly.toLowerCase().indexOf('quarterly_upfront') === 0) {
          normalizedCadence = 'quarterly';
        }
        enrichedPatch.plan_tier = isAnnual ? 'annual' : 'flexible';
        enrichedPatch.billing_cadence = normalizedCadence;
        enrichedPatch.commitment_months = isAnnual ? 12 : 0;
        enrichedPatch.commitment_start_at = new Date().toISOString();
        enrichedPatch.plan_amount_cents = tierRowEarly.amount_cents;
        enrichedPatch.payment_method = tierRowEarly.payment_method;
        // Legacy plan_type for backward-compat reads during transition
        enrichedPatch.plan_type = isAnnual ? 'annual' : (normalizedCadence === 'quarterly' ? 'quarterly' : 'monthly');
      }

      var flipResult = await sb.mutate(
        'contacts?slug=eq.' + slug + '&status=eq.prospect',
        'PATCH',
        enrichedPatch,
        'return=representation'
      );
      var flipped = Array.isArray(flipResult) && flipResult.length > 0;

      if (flipped) {
        results.action = 'status_flipped_to_onboarding';
        results.previous_status = 'prospect';
        if (tierRowEarly) {
          results.commitment_fields_set = {
            plan_tier: enrichedPatch.plan_tier,
            billing_cadence: enrichedPatch.billing_cadence,
            commitment_months: enrichedPatch.commitment_months
          };
        } else {
          results.commitment_fields_set = null;
          results.tier_lookup_missed = tierKeyEarly || null;
        }

        // Fire team notification (awaited; monitor.critical on failure).
        // We still return 200 to Stripe even if this fails — Stripe must not
        // retry the webhook (status flip + payments insert are already done).
        // The critical alert email is the surfacing channel for operators.
        try {
          var notifyResp = await fetchT('https://clients.moonraker.ai/api/notify-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
            body: JSON.stringify({ event: 'payment_received', slug: slug })
          }, 15000);
          if (!notifyResp.ok) {
            var notifyErrBody = '';
            try { notifyErrBody = await notifyResp.text(); } catch (_) {}
            await monitor.critical('stripe-webhook', new Error('notify-team returned ' + notifyResp.status), {
              client_slug: slug,
              detail: {
                stage: 'notify_team',
                status: notifyResp.status,
                body_preview: notifyErrBody.substring(0, 500),
                session_id: session.id
              }
            });
            results.notify_team_failed = true;
          }
        } catch (notifyErr) {
          try {
            await monitor.critical('stripe-webhook', notifyErr, {
              client_slug: slug,
              detail: { stage: 'notify_team', session_id: session.id }
            });
          } catch (_) { /* don't let alert failure mask the 200 */ }
          results.notify_team_failed = true;
        }

        // Set up quarterly audit schedule (awaited; monitor.critical on failure).
        // Adopts recent lead audit as baseline if within 30 days, otherwise triggers fresh.
        try {
          var schedResp = await fetchT('https://clients.moonraker.ai/api/setup-audit-schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
            body: JSON.stringify({ contact_id: contact.id })
          }, 15000);
          if (!schedResp.ok) {
            var schedErrBody = '';
            try { schedErrBody = await schedResp.text(); } catch (_) {}
            await monitor.critical('stripe-webhook', new Error('setup-audit-schedule returned ' + schedResp.status), {
              client_slug: slug,
              detail: {
                stage: 'setup_audit_schedule',
                status: schedResp.status,
                body_preview: schedErrBody.substring(0, 500),
                session_id: session.id,
                contact_id: contact.id
              }
            });
            results.setup_audit_schedule_failed = true;
          }
        } catch (schedErr) {
          try {
            await monitor.critical('stripe-webhook', schedErr, {
              client_slug: slug,
              detail: { stage: 'setup_audit_schedule', session_id: session.id, contact_id: contact.id }
            });
          } catch (_) { /* don't let alert failure mask the 200 */ }
          results.setup_audit_schedule_failed = true;
        }
      } else {
        // Either the contact was never in 'prospect' (already active,
        // already onboarding, lead, etc.) or a concurrent webhook delivery
        // won the race and already flipped them. Both are expected.
        results.action = 'no_status_change';
        results.reason = 'Contact not in prospect at PATCH time (pre-read was: ' + contact.status + ')';
      }

      // ── Set cancel_at on committed subscription plans ──
      // create-session.js can't set cancel_at directly (not a valid
      // subscription_data field on Checkout Sessions), so we do it here
      // once Stripe has created the actual Subscription. Anchoring in this
      // handler means cancel_at tracks the real subscription start (after
      // ACH clearing, etc.), not the raw checkout-click time.
      //
      // billing_term drives the window:
      //   annual    → now + 365d  (annual_monthly, annual_quarterly)
      //   quarterly → now +  90d  (quarterly_monthly)
      //   monthly   → null         (flexible monthly, runs indefinitely)
      //
      // Idempotent: Stripe accepts the same cancel_at repeatedly. Failures
      // are logged but do not block the 200 — operators can reapply by
      // rerunning or patching the subscription manually.
      if (session.mode === 'subscription' && session.subscription) {
        var tierKey = tierKeyEarly;
        if (tierKey) {
          try {
            // Reuse tierRowEarly (loaded at top of core_marketing_system
            // branch) rather than re-fetching. Falls back to a fresh fetch
            // only if the early lookup failed.
            var tierRow = tierRowEarly;
            if (!tierRow) {
              tierRow = await sb.one(
                'pricing_tiers?product_key=eq.core_marketing&tier_key=eq.' +
                encodeURIComponent(tierKey) + '&select=billing_term&limit=1'
              );
            }
            var billingTerm = tierRow && tierRow.billing_term;
            var cancelAt = null;
            if (billingTerm === 'annual')    cancelAt = Math.floor(Date.now()/1000) + 365 * 86400;
            else if (billingTerm === 'quarterly') cancelAt = Math.floor(Date.now()/1000) +  90 * 86400;

            if (cancelAt) {
              var stripeSecret = process.env.STRIPE_SECRET_KEY;
              if (!stripeSecret) {
                await monitor.logError('stripe-webhook', new Error('STRIPE_SECRET_KEY missing for cancel_at patch'), {
                  client_slug: slug,
                  detail: { stage: 'set_cancel_at', tier_key: tierKey, subscription_id: session.subscription }
                });
              } else {
                var patchResp = await fetchT('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(session.subscription), {
                  method: 'POST',
                  headers: {
                    'Authorization': 'Bearer ' + stripeSecret,
                    'Content-Type': 'application/x-www-form-urlencoded'
                  },
                  body: 'cancel_at=' + cancelAt
                }, 15000);
                if (!patchResp.ok) {
                  var patchErrBody = '';
                  try { patchErrBody = await patchResp.text(); } catch (_) {}
                  await monitor.critical('stripe-webhook', new Error('Stripe subscription PATCH cancel_at returned ' + patchResp.status), {
                    client_slug: slug,
                    detail: {
                      stage: 'set_cancel_at',
                      tier_key: tierKey,
                      subscription_id: session.subscription,
                      status: patchResp.status,
                      body_preview: patchErrBody.substring(0, 500)
                    }
                  });
                  results.cancel_at_failed = true;
                } else {
                  results.cancel_at_set = cancelAt;
                }
              }
            }
            // billingTerm==='monthly' or null: intentional no-op.
          } catch (cancelAtErr) {
            try {
              await monitor.logError('stripe-webhook', cancelAtErr, {
                client_slug: slug,
                detail: { stage: 'set_cancel_at', tier_key: tierKey, subscription_id: session.subscription }
              });
            } catch (_) { /* don't mask the 200 */ }
            results.cancel_at_failed = true;
          }
        }
      }
    } else if (metadataProduct === 'strategy_call') {
      // ── 1-Hour Strategy Call payment (legacy payment-link flow) ──
      // Log and notify only. Do NOT flip contact.status (a strategy-call
      // purchaser might be a lead, prospect, or returning active client;
      // the purchase itself carries no lifecycle signal). Do NOT schedule
      // an audit. The payments row insert below is the canonical record.
      results.action = 'strategy_call_logged';
      try {
        var scNotifyResp = await fetchT('https://clients.moonraker.ai/api/notify-team', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
          body: JSON.stringify({ event: 'strategy_call_purchased', slug: slug })
        }, 15000);
        if (!scNotifyResp.ok) {
          var scNotifyErrBody = '';
          try { scNotifyErrBody = await scNotifyResp.text(); } catch (_) {}
          await monitor.logError('stripe-webhook', new Error('notify-team returned ' + scNotifyResp.status), {
            client_slug: slug,
            detail: {
              stage: 'notify_team_strategy_call',
              status: scNotifyResp.status,
              body_preview: scNotifyErrBody.substring(0, 500),
              session_id: session.id
            }
          });
          results.notify_team_failed = true;
        }
      } catch (scNotifyErr) {
        try {
          await monitor.logError('stripe-webhook', scNotifyErr, {
            client_slug: slug,
            detail: { stage: 'notify_team_strategy_call', session_id: session.id }
          });
        } catch (_) { /* don't mask the 200 */ }
        results.notify_team_failed = true;
      }
    } else if (metadataProduct === 'addons') {
      // ── Add-on purchase from /<slug>/offers ──
      // Log and notify only. Add-ons are by definition outside the main
      // campaign lifecycle: an active client buying a $300 press release
      // shouldn't have their status, plan_type, or commitment touched.
      // The tier_key metadata tells the team which add-on was purchased
      // so they know what to deliver. payments row insert below captures
      // the canonical record.
      var addonTierKey = (session.metadata && session.metadata.tier_key) || '(unknown)';
      results.action = 'addon_logged';
      results.addon_tier_key = addonTierKey;
      try {
        var addonNotifyResp = await fetchT('https://clients.moonraker.ai/api/notify-team', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '') },
          body: JSON.stringify({ event: 'addon_purchased', slug: slug, tier_key: addonTierKey })
        }, 15000);
        if (!addonNotifyResp.ok) {
          var addonNotifyErrBody = '';
          try { addonNotifyErrBody = await addonNotifyResp.text(); } catch (_) {}
          await monitor.logError('stripe-webhook', new Error('notify-team returned ' + addonNotifyResp.status), {
            client_slug: slug,
            detail: {
              stage: 'notify_team_addon',
              tier_key: addonTierKey,
              status: addonNotifyResp.status,
              body_preview: addonNotifyErrBody.substring(0, 500),
              session_id: session.id
            }
          });
          results.notify_team_failed = true;
        }
      } catch (addonNotifyErr) {
        try {
          await monitor.logError('stripe-webhook', addonNotifyErr, {
            client_slug: slug,
            detail: { stage: 'notify_team_addon', tier_key: addonTierKey, session_id: session.id }
          });
        } catch (_) { /* don't mask the 200 */ }
        results.notify_team_failed = true;
      }
    } else {
      // ── Unrecognized product ──
      // M41 fail-loud: the branching landed here because neither the
      // metadata.product (if any) nor the amount-threshold fallback
      // matched a recognized product. Fail loud so a newly-created
      // untagged payment link or a newly-added product surfaces in
      // monitor logs instead of silently defaulting to the CORE
      // onboarding cascade.
      try {
        await monitor.logError('stripe-webhook', new Error('Unrecognized Stripe product'), {
          client_slug: slug,
          detail: {
            stage: 'classify_product',
            metadata_product: metadataProduct || '(empty)',
            amount_total: amountTotal,
            session_id: session.id
          }
        });
      } catch (_) { /* don't mask the 200 */ }
      results.action = 'unclassified_product';
      results.metadata_product = metadataProduct || null;
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
        description: isEntityAudit
          ? 'Entity Audit'
          : (metadataProduct === 'addons'
              ? ('Add-on: ' + ((session.metadata && session.metadata.tier_key) || 'unknown'))
              : (metadataProduct === 'strategy_call' ? 'Strategy Call' : 'CORE Marketing System'))
      }, 'return=minimal');
    } catch (logErr) {
      console.log('Failed to log payment:', logErr.message);
    }

    return res.status(200).json({ received: true, results: results });

  } catch (err) {
    monitor.logError('Stripe webhook', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

// Disable Vercel's default body parser so we can read the raw bytes that
// Stripe actually signed. Reconstructing via JSON.stringify(req.body)
// doesn't preserve key order, whitespace, or numeric formatting.
// NOTE: This must be assigned AFTER `module.exports = handler` above,
// otherwise the handler reassignment wipes it out.
module.exports.config = { api: { bodyParser: false } };

