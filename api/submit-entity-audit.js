// /api/submit-entity-audit.js
// Public-facing endpoint for the entity audit intake form.
// Creates a lead contact + entity_audits row, then triggers the Surge agent.
// Writes an opt-in row to newsletter_subscribers when marketing_consent=true
// (via _lib/newsletter-subscribe, idempotent + honors prior opt-outs).
//
// POST body: {
//   first_name, last_name, practice_name, website_url, email,
//   source, referral_name, city, state, gbp_link, marketing_consent
// }

var sb = require('./_lib/supabase');
var rateLimit = require('./_lib/rate-limit');
var entityAuditTrigger = require('./_lib/entity-audit-trigger');
var newsletter = require('./_lib/newsletter-subscribe');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Origin validation: block cross-origin abuse.
  // Empty Origin is now rejected (H15) — curl and non-browser callers that
  // strip the header previously bypassed the check.
  var origin = req.headers.origin || '';
  if (!origin || origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

  // Rate limit: 3 submissions/hour per IP. Replaces the old global 20/hour
  // limit (H14) — a single spammer could exhaust the global window and block
  // legitimate submissions. Per-IP caps the spammer without collateral damage.
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':submit-entity-audit', 3, 3600);
  rateLimit.setHeaders(res, rl, 3);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  var body = req.body || {};
  var firstName = (body.first_name || '').trim();
  var lastName = (body.last_name || '').trim();
  var practiceName = (body.practice_name || '').trim();
  var websiteUrl = (body.website_url || '').trim();
  var email = (body.email || '').trim().toLowerCase();
  var source = (body.source || 'landing_page').trim();
  var referralName = (body.referral_name || '').trim();
  var city = (body.city || '').trim();
  var state = (body.state || '').trim();
  var gbpLink = (body.gbp_link || '').trim();
  var marketingConsent = body.marketing_consent !== false;

  // Validation
  if (!firstName || !lastName || !websiteUrl || !email) {
    return res.status(400).json({ error: 'First name, last name, website URL, and email are required.' });
  }
  if (!/^https?:\/\/.+\..+/.test(websiteUrl)) {
    return res.status(400).json({ error: 'Please provide a valid website URL starting with http:// or https://' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  // Build slug. brandQuery + geoTarget are now derived inside the helper
  // (entity-audit-trigger.js) so we don't compute them here.
  var slug = (firstName + ' ' + lastName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);

  try {
    // M9: slug pre-check removed — contacts_slug_key (UNIQUE) is the
    // authoritative backstop, pre-check was racy and redundant. The
    // catch block below detects 23505 by PostgREST error code and
    // returns the slug-specific empathetic message.
    //
    // Email pre-check KEPT. The contacts table currently has no
    // UNIQUE constraint on email (verified via pg_constraint), so
    // removing this pre-check would allow duplicates. Filed as a
    // separate finding — schema change is out of this session's scope.
    var byEmail = await sb.query('contacts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
    if (byEmail && byEmail.length > 0) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'We already have a record with this email address. If you have not received your scorecard yet, please contact support@moonraker.ai.'
      });
    }

    // 1. Create contact
    var contactRows = await sb.mutate('contacts', 'POST', {
      first_name: firstName,
      last_name: lastName,
      practice_name: practiceName || null,
      website_url: websiteUrl,
      email: email,
      slug: slug,
      status: 'lead',
      source: source,
      referral_code: referralName || null,
      audit_tier: 'free',
      city: city || null,
      state_province: state || null,
      marketing_consent: marketingConsent
    });

    var contact = contactRows[0];

    // 2. Create entity_audits row + trigger the Surge agent. All the prior
    // inline logic (~100 lines) lives in _lib/entity-audit-trigger.js now so
    // it can be shared with the stripe-webhook strategy_call branch. Behavior
    // is identical: agent failures flip the audit to status='agent_error',
    // cron/process-audit-queue.js Step 0.5 auto-retries on a 5-min backoff,
    // an FYI email hits notifications@ for observability.
    var auditResult = await entityAuditTrigger.createAndTriggerAudit({
      contact: {
        id: contact.id,
        slug: slug,
        first_name: firstName,
        last_name: lastName,
        practice_name: practiceName
      },
      website_url: websiteUrl,
      city: city,
      state: state,
      gbp_link: gbpLink,
      audit_tier: 'free'
    });

    // 3. Newsletter subscribe (idempotent, never throws internally, but wrap
    // in try/catch as belt-and-braces — the intake response must succeed
    // even if the subscribe write fails unexpectedly). Source='entity-audit'
    // matches the CHECK constraint on newsletter_subscribers.source.
    try {
      var subResult = await newsletter.subscribeIfConsenting({
        email: email,
        first_name: firstName,
        last_name: lastName,
        source: 'entity-audit',
        marketingConsent: marketingConsent
      });
      if (subResult && subResult.action === 'error') {
        try {
          await monitor.logError('submit-entity-audit', new Error('newsletter_subscribe_failed'), {
            client_slug: slug,
            detail: { stage: 'newsletter_subscribe', reason: subResult.error }
          });
        } catch (_) { /* never mask the 200 */ }
      }
    } catch (subErr) {
      try {
        await monitor.logError('submit-entity-audit', subErr, {
          client_slug: slug,
          detail: { stage: 'newsletter_subscribe_threw' }
        });
      } catch (_) { /* never mask the 200 */ }
    }

    return res.status(200).json({
      success: true,
      contact_id: contact.id,
      audit_id: auditResult.audit_id,
      agent_triggered: auditResult.agent_triggered
    });

  } catch (err) {
    console.error('submit-entity-audit error:', err);

    // M9: detect unique-constraint violation via structured PostgREST
    // error (err.detail.code === '23505') first, with constraint-name
    // fallback, and substring match as the last resort for forward-compat
    // with helper rewrites. sb.mutate attaches the raw PostgREST body
    // as err.detail (see api/_lib/supabase.js).
    var detail = err && err.detail;
    var pgCode = detail && detail.code;
    var msg = (err && err.message) || '';
    var isUnique = (pgCode === '23505') ||
                   msg.indexOf('contacts_slug_key') !== -1 ||
                   msg.indexOf('duplicate key') !== -1 ||
                   msg.indexOf('duplicate') !== -1 ||
                   msg.indexOf('unique') !== -1;
    if (isUnique) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'It looks like we already have your information on file. If you have not received your scorecard yet, please contact support@moonraker.ai.'
      });
    }
    return res.status(500).json({ error: msg || 'Something went wrong. Please try again.' });
  }
};

