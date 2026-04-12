// /api/submit-entity-audit.js
// Public-facing endpoint for the entity audit intake form.
// Creates a lead contact + entity_audits row, then triggers the Surge agent.
//
// POST body: {
//   first_name, last_name, practice_name, website_url, email,
//   source, referral_name, city, state, gbp_link
// }

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

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
    // Rate limit: max 20 submissions per hour (prevents automated spam)
    var oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    var recentAudits = await sb.query('entity_audits?created_at=gte.' + encodeURIComponent(oneHourAgo) + '&source=eq.landing_page&select=id&limit=21');
    if (recentAudits && recentAudits.length >= 20) {
      return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
    }

    // Check for existing contact with this slug
    var existing = await sb.query('contacts?slug=eq.' + slug + '&select=id&limit=1');
    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'It looks like we already have your information on file. If you have not received your scorecard yet, please contact support@moonraker.ai.'
      });
    }

    // Also check by email
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
        var agentResp = await fetch(AGENT_URL + '/tasks/surge-audit', {
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
        });

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
          await fetch('https://api.resend.com/emails', {
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
          });
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
    var msg = err.message || 'Something went wrong. Please try again.';
    if (msg.indexOf('duplicate') !== -1 || msg.indexOf('unique') !== -1) {
      return res.status(409).json({
        error: 'duplicate',
        message: 'It looks like we already have a record for this practice. Please contact support@moonraker.ai.'
      });
    }
    return res.status(500).json({ error: msg });
  }
};
