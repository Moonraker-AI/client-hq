// /api/submit-entity-audit.js
// Public-facing endpoint for the entity audit intake form.
// Creates a lead contact + entity_audits row, then triggers the Surge agent.
//
// POST body: {
//   first_name, last_name, practice_name, website_url, email,
//   source, referral_name, city, state, gbp_link
// }

var sb = require('./_lib/supabase');
var rateLimit = require('./_lib/rate-limit');
var fetchT = require('./_lib/fetch-with-timeout');

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

  // Build slug
  var slug = (firstName + ' ' + lastName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
  var brandQuery = practiceName || (firstName + ' ' + lastName);
  var geoTarget = city && state ? city + ', ' + state : city || state || '';

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

    // 2. Create entity_audits row
    var auditRows = await sb.mutate('entity_audits', 'POST', {
      contact_id: contact.id,
      client_slug: slug,
      audit_tier: 'free',
      brand_query: brandQuery,
      homepage_url: websiteUrl,
      status: 'pending',
      geo_target: geoTarget || null,
      gbp_share_link: gbpLink || null
    });

    var audit = auditRows[0];

    // 3. Trigger the agent service
    var AGENT_URL = process.env.AGENT_SERVICE_URL;
    var AGENT_KEY = process.env.AGENT_API_KEY;
    var agentTriggered = false;
    var agentError = null;

    if (AGENT_URL && AGENT_KEY) {
      try {
        var agentResp = await fetchT(AGENT_URL + '/tasks/surge-audit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + AGENT_KEY
          },
          body: JSON.stringify({
            audit_id: audit.id,
            practice_name: brandQuery,
            website_url: websiteUrl,
            city: city || '',
            state: state || '',
            geo_target: geoTarget,
            gbp_link: gbpLink,
            client_slug: slug
          })
        }, 30000);

        if (agentResp.ok) {
          var agentResult = await agentResp.json();
          // Update audit status to agent_running
          await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
            status: 'agent_running',
            agent_task_id: agentResult.task_id
          }, 'return=minimal');
          agentTriggered = true;
        } else {
          agentError = 'Agent returned ' + agentResp.status;
        }
      } catch (e) {
        agentError = e.message;
      }
    } else {
      agentError = 'Agent service not configured';
    }

    // If agent failed, still return success to the user (team will handle manually)
    if (!agentTriggered && agentError) {
      console.error('Agent trigger failed:', agentError, '- audit will need manual processing');
      // Notify team about the failed trigger
      try {
        var resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          await fetchT('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
              to: ['notifications@clients.moonraker.ai'],
              subject: 'Entity Audit Agent Failed - ' + brandQuery,
              html: '<p>A new entity audit was submitted but the agent could not be triggered.</p>' +
                '<p><strong>Contact:</strong> ' + firstName + ' ' + lastName + ' (' + email + ')</p>' +
                '<p><strong>Practice:</strong> ' + brandQuery + '</p>' +
                '<p><strong>Error:</strong> ' + agentError + '</p>' +
                '<p><a href="https://clients.moonraker.ai/admin/clients#audit-' + audit.id + '">View in Admin</a></p>'
            })
          }, 10000);
        }
      } catch (notifyErr) {
        console.error('Failed to send agent-failure notification:', notifyErr);
      }
    }

    return res.status(200).json({
      success: true,
      contact_id: contact.id,
      audit_id: audit.id,
      agent_triggered: agentTriggered
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

