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
// POST body: {
//   first_name, last_name, practice_name, website, email, phone, city
// }
// Returns: { slug, contact_id }

var sb        = require('../_lib/supabase');
var rateLimit = require('../_lib/rate-limit');
var sanitizer = require('../_lib/html-sanitizer');
var monitor   = require('../_lib/monitor');

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
  city:          120
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

  var email = (emailRaw || '').trim().toLowerCase();

  // Validation. Required: first_name, last_name, email, phone. The calendar
  // requires phone at booking anyway, so we may as well collect it up front.
  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: 'First name, last name, email, and phone are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (website && !/^https?:\/\/.+\..+/.test(website)) {
    return res.status(400).json({ error: 'Website URL must start with http:// or https://' });
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
        updated_at:    new Date().toISOString()
      };
      // Only overwrite optional fields when the new value is non-empty, so
      // an existing client re-running the form without re-typing their
      // practice name doesn't blank it out.
      if (practiceName) patch.practice_name = practiceName;
      if (website)      patch.website_url   = website;
      if (city)         patch.city          = city;

      await sb.mutate(
        'contacts?id=eq.' + existing.id,
        'PATCH',
        patch,
        'return=minimal'
      );

      return res.status(200).json({ slug: existing.slug, contact_id: existing.id });
    }

    // New lead. Find an available slug, then insert.
    var seed = baseSlug(firstName, lastName, practiceName);
    var slug = await findAvailableSlug(seed);

    var insertBody = {
      slug:           slug,
      first_name:     firstName,
      last_name:      lastName,
      email:          email,
      phone:          phone,
      status:         'lead',
      source:         'strategy_call'
      // campaign_type, marketing_consent, quarterly_audits_enabled all have
      // safe defaults at the schema level ('local', false, true).
    };
    if (practiceName) insertBody.practice_name = practiceName;
    if (website)      insertBody.website_url   = website;
    if (city)         insertBody.city          = city;

    var rows = await sb.mutate('contacts', 'POST', insertBody);
    var contact = Array.isArray(rows) ? rows[0] : rows;
    if (!contact || !contact.id) {
      throw new Error('contact insert returned no row');
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
          slug:       retrySlug,
          first_name: firstName,
          last_name:  lastName,
          email:      email,
          phone:      phone,
          status:     'lead',
          source:     'strategy_call'
        };
        if (practiceName) retryBody.practice_name = practiceName;
        if (website)      retryBody.website_url   = website;
        if (city)         retryBody.city          = city;
        var retryRows = await sb.mutate('contacts', 'POST', retryBody);
        var retryContact = Array.isArray(retryRows) ? retryRows[0] : retryRows;
        if (retryContact && retryContact.id) {
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
