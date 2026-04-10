// /api/notify-team.js
// Sends branded team notification emails via Resend for key lifecycle events:
//   - payment_received: Prospect paid, now onboarding
//   - intro_call_complete: Intro call finished (with checklist summary)
//   - onboarding_complete: All onboarding steps done, promoted to active
//
// Uses shared email template (dark header/footer) for consistent branding.
// POST { event: string, slug: string }

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var body = req.body || {};
  var event = body.event;
  var slug = body.slug;

  if (!event || !slug) return res.status(400).json({ error: 'Missing event or slug' });

  var validEvents = ['payment_received', 'intro_call_complete', 'onboarding_complete'];
  if (validEvents.indexOf(event) === -1) return res.status(400).json({ error: 'Invalid event type' });

  try {
    var contact = await sb.one('contacts?slug=eq.' + slug + '&select=id,first_name,last_name,practice_name,email,status,plan_type,city,state_province&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    var clientName = (contact.first_name || '') + ' ' + (contact.last_name || '');
    var deepDiveUrl = 'https://clients.moonraker.ai/admin/clients?slug=' + slug;

    var subject = '';
    var content = '';
    var headerLabel = 'Team Notification';

    if (event === 'payment_received') {
      subject = 'New Client Payment: ' + clientName.trim();
      headerLabel = 'New Payment';
      content = buildPaymentContent(contact, clientName, deepDiveUrl);

    } else if (event === 'intro_call_complete') {
      var steps = await sb.query('intro_call_steps?contact_id=eq.' + contact.id + '&step_key=neq.intro_call_complete&order=sort_order.asc&select=step_key,label,category,status');
      subject = 'Intro Call Complete: ' + clientName.trim();
      headerLabel = 'Intro Call Complete';
      content = buildIntroCallContent(contact, clientName, deepDiveUrl, steps || []);

    } else if (event === 'onboarding_complete') {
      subject = 'Onboarding Complete: ' + clientName.trim();
      headerLabel = 'Onboarding Complete';
      content = buildOnboardingContent(contact, clientName, deepDiveUrl);
    }

    var htmlBody = email.wrap({
      headerLabel: headerLabel, content: content,
      footerNote: 'This is an internal notification for the Moonraker team.'
    });

    var recipients = ['support@moonraker.ai', 'scott@moonraker.ai', 'chris@moonraker.ai'];

    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: email.FROM.notifications, to: recipients, subject: subject, html: htmlBody })
    });

    var emailResult = await emailResp.json();
    if (!emailResp.ok) {
      console.error('Resend error:', emailResult);
      return res.status(500).json({ error: 'Email send failed', detail: emailResult });
    }

    return res.status(200).json({ success: true, event: event, slug: slug, email_id: emailResult.id });

  } catch (err) {
    console.error('notify-team error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};

// ── Content builders ──

function clientHeader(contact, clientName) {
  var practice = contact.practice_name || '';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  return email.sectionHeading(clientName.trim()) +
    (practice || location
      ? email.p(email.esc(practice) + (practice && location ? ' \u00B7 ' : '') + email.esc(location))
      : '');
}

function detailRow(label, value) {
  if (!value) return '';
  return '<tr>' +
    '<td style="padding:8px 0;color:#6B7599;font-family:Inter,sans-serif;font-size:14px;border-bottom:1px solid #E2E8F0">' + email.esc(label) + '</td>' +
    '<td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;font-family:Inter,sans-serif;font-size:14px;border-bottom:1px solid #E2E8F0">' + email.esc(value) + '</td>' +
    '</tr>';
}

function detailTable(rows) {
  var html = '';
  rows.forEach(function(r) { html += detailRow(r[0], r[1]); });
  if (!html) return '';
  return '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px">' + html + '</table>';
}

function buildPaymentContent(contact, clientName, deepDiveUrl) {
  var plan = contact.plan_type || 'CORE Marketing System';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  return clientHeader(contact, clientName) +
    email.p('Payment received. Status moved to <strong style="color:#00D47E">Onboarding</strong>. Onboarding steps, intro call checklist, and deliverables have been automatically seeded.') +
    detailTable([['Plan', plan], ['Email', contact.email || ''], ['Location', location]]) +
    email.cta(deepDiveUrl, 'View Client');
}

function buildIntroCallContent(contact, clientName, deepDiveUrl, steps) {
  var categories = {};
  var catLabels = { 'platform_access': 'Platform Access', 'campaign_setup': 'Campaign Setup', 'expectations': 'Expectations' };
  steps.forEach(function(s) {
    var cat = s.category || 'other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(s);
  });

  var completed = steps.filter(function(s) { return s.status === 'complete'; }).length;
  var total = steps.length;
  var pending = total - completed;

  var checklistHtml = '<div style="margin:16px 0;padding:16px 20px;background:#F7FDFB;border-radius:10px;border:1px solid #E2E8F0">' +
    '<p style="font-family:Inter,sans-serif;font-size:13px;color:#00D47E;margin:0 0 12px;font-weight:600">' +
      completed + ' of ' + total + ' tasks completed' +
      (pending > 0 ? ' \u2014 ' + pending + ' still pending' : ' \u2014 all clear!') +
    '</p>';

  var catOrder = ['platform_access', 'campaign_setup', 'expectations'];
  catOrder.forEach(function(catKey) {
    var catSteps = categories[catKey];
    if (!catSteps) return;
    checklistHtml += '<p style="font-family:Inter,sans-serif;font-size:11px;color:#6B7599;margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600">' + (catLabels[catKey] || catKey) + '</p>';
    catSteps.forEach(function(s) {
      var icon = s.status === 'complete' ? '\u2705' : '\u2B1C';
      var color = s.status === 'complete' ? '#6B7599' : '#1E2A5E';
      checklistHtml += '<p style="font-family:Inter,sans-serif;font-size:13px;color:' + color + ';margin:2px 0">' + icon + ' ' + email.esc(s.label) + '</p>';
    });
  });
  checklistHtml += '</div>';

  var warningHtml = '';
  if (pending > 0) {
    warningHtml = email.p('<span style="color:#D97706">\u26A0\uFE0F ' + pending + ' task' + (pending > 1 ? 's' : '') + ' still need attention.</span>');
  }

  return clientHeader(contact, clientName) +
    email.p('The intro call has been completed. Below is the checklist summary.') +
    checklistHtml + warningHtml +
    email.cta(deepDiveUrl, 'View Client');
}

function buildOnboardingContent(contact, clientName, deepDiveUrl) {
  return clientHeader(contact, clientName) +
    email.p('All onboarding steps are complete. Status promoted to <strong style="color:#00D47E">Active</strong>. The client is now ready for ongoing campaign work, reporting, and deliverables.') +
    email.p('<span style="color:#6B7599;font-size:13px">Monthly report scheduling can now be configured in the Reports tab.</span>') +
    email.cta(deepDiveUrl, 'View Client');
}
