// /api/strategy-call/create-lead.js
// Public-facing endpoint for the /strategy-call landing page intake form.
// Creates or updates a lead contact with source='strategy_call', THEN the
// client calls /api/checkout/create-session to open Stripe.
//
// Doing intake BEFORE Stripe (rather than capturing via webhook) means that
// if they abandon checkout we still have the lead in contacts — this is the
// whole point of the pre-CORE funnel.
//
// Unlike /api/submit-entity-audit (which rejects duplicate emails outright),
// this endpoint UPSERTS by email: a prospect may have come through an earlier
// audit intake, and re-collecting their contact info as part of a paid call
// purchase is normal. Active / onboarding clients are allowed through at this
// stage; the stripe-webhook raises a monitor.critical if one actually pays
// for the call (almost certainly a mis-click on their part).
//
// Form expanded 2026-04-22 to mirror /entity-audit intake. Website + GBP fields
// are collected here so that the stripe-webhook can auto-trigger a free entity
// audit after payment (giving Scott visibility data before the call). If
// has_gbp='yes', gbp_link is required. Newsletter opt-in writes to
// newsletter_subscribers via _lib/newsletter-subscribe (idempotent, honors
// prior opt-outs).
//
// POST body: {
//   first_name, last_name, practice_name, website, email, phone,
//   city, state, has_gbp, gbp_link, marketing_consent
// }
// Returns: { slug, contact_id }

var sb        = require('../_lib/supabase');
var rateLimit = require('../_lib/rate-limit');
var sanitizer = require('../_lib/html-sanitizer');
var monitor   = require('../_lib/monitor');
var newsletter = require('../_lib/newsletter-subscribe');

// Same origin check as submit-entity-audit. The landing at /strategy-call
// lives on clients.moonraker.ai, so legitimate calls will always carry the
// same origin; empty or mismatched origins are cross-origin abuse.
var ALLOWED_ORIGIN = 'https://clients.moonraker.ai';

// Max lengths chosen to be generous but bounded. sanitizeText() strips
// control chars and truncates to the given length.
var MAX = {
  first_name:    80,
  last_name:     80,
  practice_name: 200,
  website:       500,
  email:         200,
  phone:         40,
  city:          120,
  state:         80,
  gbp_link:      500
};

// Slug from "first last" (practice name as fallback). Mirrors the convention
// used in submit-entity-audit + the admin deep-dive URL structure.
function baseSlug(firstName, lastName, practiceName) {
  var seed = (firstName + ' ' + lastName).trim();
  if (!seed) seed = practiceName || '';
  return seed.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60) || 'strategy-call-lead';
}

// Loop until we find an unused slug. Collision rate is tiny in practice
// (only identical-name leads collide) so an unbounded loop with a hard cap
// is safe and simpler than a single round-trip to generate-then-catch-23505.
async function findAvailableSlug(seed) {
  // Fast path: try the bare slug first.
  var candidate = seed;
  for (var i = 0; i < 10; i++) {
    var existing = await sb.query(
      'contacts?slug=eq.' + encodeURIComponent(candidate) + '&select=id&limit=1'
    );
    if (!existing || existing.length === 0) return candidate;
    // Short random suffix. 4 chars of base36 gives ~1.6M combinations; after
    // 10 attempts the odds of repeated collision are astronomically small.
    candidate = seed.substring(0, 55) + '-' + Math.random().toString(36).substring(2, 6);
  }
  throw new Error('Could not find available slug after 10 attempts');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Origin validation: block cross-origin abuse. Empty origin is rejected
  // (matches H15 pattern in submit-entity-audit).
  var origin = (req.headers && req.headers.origin) || '';
  if (!origin || origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'Service not configured' });
  }

  // Rate limit: 5 submissions/hour per IP. Slightly higher than entity audit
  // (which is 3/hour) because this endpoint is payment-gated — an attacker
  // still has to move through Stripe to do any damage. Fail-closed on store
  // outage, same as other public intakes.
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':strategy-call-create-lead', 5, 3600);
  rateLimit.setHeaders(res, rl, 5);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many submissions. Please try again in a bit.' });
  }

  var body = (req.body && typeof req.body === 'object') ? req.body : {};

  // Sanitize + bound every string. sanitizeText strips control chars,
  // normalises whitespace, and truncates to maxLen.
  var firstName    = sanitizer.sanitizeText(body.first_name,    MAX.first_name);
  var lastName     = sanitizer.sanitizeText(body.last_name,     MAX.last_name);
  var practiceName = sanitizer.sanitizeText(body.practice_name, MAX.practice_name);
  var website      = sanitizer.sanitizeText(body.website,       MAX.website);
  var emailRaw     = sanitizer.sanitizeText(body.email,         MAX.email);
  var phone        = sanitizer.sanitizeText(body.phone,         MAX.phone);
  var city         = sanitizer.sanitizeText(body.city,          MAX.city);
  var state        = sanitizer.sanitizeText(body.state,         MAX.state);
  var gbpLink      = sanitizer.sanitizeText(body.gbp_link,      MAX.gbp_link);

  var email = (emailRaw || '').trim().toLowerCase();

  // has_gbp: 'yes' | 'no' | '' (treat blank as missing). Not sanitized via
  // sanitizeText because we want exact-match on the allowlist.
  var hasGbpRaw = (body.has_gbp || '').toString().trim().toLowerCase();
  var hasGbp = (hasGbpRaw === 'yes' || hasGbpRaw === 'no') ? hasGbpRaw : '';

  // marketing_consent: default true (checkbox is pre-checked on the form).
  // Only an explicit false disables the newsletter opt-in. Matches the
  // submit-entity-audit behavior.
  var marketingConsent = body.marketing_consent !== false;

  // Validation. Required (tightened 2026-04-22 to match entity-audit intake):
  //   first_name, last_name, email, phone, website, has_gbp.
  // If has_gbp='yes', gbp_link is also required. Website is now required
  // (was optional pre-expansion) so the stripe-webhook has something to
  // feed the Surge agent after payment.
  if (!firstName || !lastName || !email || !phone || !website) {
    return res.status(400).json({ error: 'First name, last name, email, phone, and website are all required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!/^https?:\/\/.+\..+/.test(website)) {
    return res.status(400).json({ error: 'Website URL must start with http:// or https://' });
  }
  if (!hasGbp) {
    return res.status(400).json({ error: 'Please indicate whether you have a Google Business Profile.' });
  }
  if (hasGbp === 'yes') {
    if (!gbpLink) {
      return res.status(400).json({ error: 'Please share your Google Business Profile link.' });
    }
    if (!/^https?:\/\/.+\..+/.test(gbpLink)) {
      return res.status(400).json({ error: 'Google Business Profile link must start with http:// or https://' });
    }
  }

  try {
    // UPSERT by email: if a contact exists, update the provided fields and
    // return their existing slug. If not, create a new lead. We don't flip
    // status on existing contacts — an active client who re-fills this form
    // stays active. The webhook raises the red flag if they actually pay.
    var existing = await sb.one(
      'contacts?email=eq.' + encodeURIComponent(email) +
      '&select=id,slug,status,lost&limit=1'
    );

    if (existing) {
      // Update only the fields the form collects. Don't touch status, lost,
      // source, or any campaign-related field — those are owned by the
      // lifecycle pipeline.
      var patch = {
        first_name:    firstName,
        last_name:     lastName,
        phone:         phone,
        // Website is required as of 2026-04-22, so always overwrite.
        website_url:   website,
        // marketing_consent reflects the checkbox state on THIS submission.
        // Writing it honestly lets someone un-check to opt out of future
        // newsletters even if they previously consented (the newsletter
        // subscribe call below honors the opt-out — we don't re-subscribe
        // an 'unsubscribed' row regardless of what this flag says).
        marketing_consent: marketingConsent,
        updated_at:    new Date().toISOString()
      };
      // Only overwrite optional fields when the new value is non-empty, so
      // an existing client re-running the form without re-typing their
      // practice name doesn't blank it out.
      if (practiceName) patch.practice_name = practiceName;
      if (city)         patch.city          = city;
      if (state)        patch.state_province = state;
      // Only write gbp_share_link when the user affirmatively supplied one
      // this time. If they answered "No" on GBP, leave any previously-
      // captured link alone rather than blanking it — they may have had a
      // GBP linked from an earlier audit intake that we shouldn't lose.
      if (hasGbp === 'yes' && gbpLink) {
        patch.gbp_share_link = gbpLink;
      }

      await sb.mutate(
        'contacts?id=eq.' + existing.id,
        'PATCH',
        patch,
        'return=minimal'
      );

      // Newsletter opt-in (idempotent). Safe to call every time; the helper
      // skips existing active/opted-out rows.
      try {
        var subUpd = await newsletter.subscribeIfConsenting({
          email: email,
          first_name: firstName,
          last_name: lastName,
          source: 'strategy-call',
          marketingConsent: marketingConsent
        });
        if (subUpd && subUpd.action === 'error') {
          try {
            await monitor.logError('strategy-call-create-lead', new Error('newsletter_subscribe_failed'), {
              client_slug: existing.slug,
              detail: { stage: 'newsletter_subscribe_upsert_branch', reason: subUpd.error }
            });
          } catch (_) {}
        }
      } catch (subErr) {
        try {
          await monitor.logError('strategy-call-create-lead', subErr, {
            client_slug: existing.slug,
            detail: { stage: 'newsletter_subscribe_threw_upsert_branch' }
          });
        } catch (_) {}
      }

      return res.status(200).json({ slug: existing.slug, contact_id: existing.id });
    }

    // New lead. Find an available slug, then insert.
    var seed = baseSlug(firstName, lastName, practiceName);
    var slug = await findAvailableSlug(seed);

    var insertBody = {
      slug:               slug,
      first_name:         firstName,
      last_name:          lastName,
      email:              email,
      phone:              phone,
      status:             'lead',
      source:             'strategy_call',
      // Website is required as of 2026-04-22.
      website_url:        website,
      // Persist marketing_consent at the contact level so downstream CRM
      // queries see the opt-in state even before the newsletter subscribe
      // lands (or if the subscribe write fails).
      marketing_consent:  marketingConsent
      // campaign_type, quarterly_audits_enabled have safe schema defaults.
    };
    if (practiceName)        insertBody.practice_name  = practiceName;
    if (city)                insertBody.city           = city;
    if (state)               insertBody.state_province = state;
    if (hasGbp === 'yes' && gbpLink) insertBody.gbp_share_link = gbpLink;

    var rows = await sb.mutate('contacts', 'POST', insertBody);
    var contact = Array.isArray(rows) ? rows[0] : rows;
    if (!contact || !contact.id) {
      throw new Error('contact insert returned no row');
    }

    // Newsletter opt-in (idempotent, never throws internally). Failures
    // do not block the response — the lead is already saved, and we don't
    // want to 500 the intake over a subscribe hiccup.
    try {
      var subIns = await newsletter.subscribeIfConsenting({
        email: email,
        first_name: firstName,
        last_name: lastName,
        source: 'strategy-call',
        marketingConsent: marketingConsent
      });
      if (subIns && subIns.action === 'error') {
        try {
          await monitor.logError('strategy-call-create-lead', new Error('newsletter_subscribe_failed'), {
            client_slug: slug,
            detail: { stage: 'newsletter_subscribe_insert_branch', reason: subIns.error }
          });
        } catch (_) {}
      }
    } catch (subErr) {
      try {
        await monitor.logError('strategy-call-create-lead', subErr, {
          client_slug: slug,
          detail: { stage: 'newsletter_subscribe_threw_insert_branch' }
        });
      } catch (_) {}
    }

    return res.status(200).json({ slug: contact.slug, contact_id: contact.id });

  } catch (err) {
    // Slug collision race: a concurrent insert grabbed the slug between our
    // availability check and our insert. Very rare; retry once with a fresh
    // suffix. Everything else logs + returns a generic 5xx.
    var detail = err && err.detail;
    var pgCode = detail && detail.code;
    if (pgCode === '23505') {
      try {
        var retrySeed = baseSlug(firstName, lastName, practiceName);
        var retrySlug = retrySeed.substring(0, 55) + '-' + Math.random().toString(36).substring(2, 6);
        var retryBody = {
          slug:              retrySlug,
          first_name:        firstName,
          last_name:         lastName,
          email:             email,
          phone:             phone,
          status:            'lead',
          source:            'strategy_call',
          website_url:       website,
          marketing_consent: marketingConsent
        };
        if (practiceName)        retryBody.practice_name  = practiceName;
        if (city)                retryBody.city           = city;
        if (state)               retryBody.state_province = state;
        if (hasGbp === 'yes' && gbpLink) retryBody.gbp_share_link = gbpLink;
        var retryRows = await sb.mutate('contacts', 'POST', retryBody);
        var retryContact = Array.isArray(retryRows) ? retryRows[0] : retryRows;
        if (retryContact && retryContact.id) {
          // Newsletter opt-in on the retry path too, matching the primary
          // insert branch. Failures here also don't block.
          try {
            var subRetry = await newsletter.subscribeIfConsenting({
              email: email,
              first_name: firstName,
              last_name: lastName,
              source: 'strategy-call',
              marketingConsent: marketingConsent
            });
            if (subRetry && subRetry.action === 'error') {
              try {
                await monitor.logError('strategy-call-create-lead', new Error('newsletter_subscribe_failed'), {
                  client_slug: retrySlug,
                  detail: { stage: 'newsletter_subscribe_retry_branch', reason: subRetry.error }
                });
              } catch (_) {}
            }
          } catch (subErr) {
            try {
              await monitor.logError('strategy-call-create-lead', subErr, {
                client_slug: retrySlug,
                detail: { stage: 'newsletter_subscribe_threw_retry_branch' }
              });
            } catch (_) {}
          }
          return res.status(200).json({ slug: retryContact.slug, contact_id: retryContact.id });
        }
      } catch (retryErr) {
        // fall through to generic error
        try {
          await monitor.logError('strategy-call-create-lead', retryErr, {
            detail: { stage: 'slug_collision_retry', email_suffix: email.split('@')[1] || '' }
          });
        } catch (_) {}
      }
    }

    try {
      await monitor.logError('strategy-call-create-lead', err, {
        detail: { stage: 'upsert_lead', email_suffix: email.split('@')[1] || '' }
      });
    } catch (_) {}

    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
