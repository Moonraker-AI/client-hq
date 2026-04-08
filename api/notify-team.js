// /api/notify-team.js
// Sends branded team notification emails via Resend for key lifecycle events:
//   - payment_received: Prospect paid, now onboarding
//   - intro_call_complete: Intro call finished (with checklist summary)
//   - onboarding_complete: All onboarding steps done, promoted to active
//
// POST { event: string, slug: string }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var resendKey = process.env.RESEND_API_KEY;

  if (!sbKey || !resendKey) {
    return res.status(500).json({ error: 'Missing required env vars' });
  }

  var body = req.body || {};
  var event = body.event;
  var slug = body.slug;

  if (!event || !slug) {
    return res.status(400).json({ error: 'Missing event or slug' });
  }

  var validEvents = ['payment_received', 'intro_call_complete', 'onboarding_complete'];
  if (validEvents.indexOf(event) === -1) {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
  }

  try {
    // Look up contact
    var contactResp = await fetch(
      sbUrl + '/rest/v1/contacts?slug=eq.' + slug + '&select=id,first_name,last_name,practice_name,email,status,plan_type,city,state_province&limit=1',
      { headers: sbHeaders() }
    );
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    var contact = contacts[0];
    var clientName = (contact.first_name || '') + ' ' + (contact.last_name || '');
    var deepDiveUrl = 'https://clients.moonraker.ai/admin/clients?slug=' + slug;

    var subject = '';
    var htmlBody = '';

    // ── Build email based on event type ──

    if (event === 'payment_received') {
      subject = 'New Client Payment: ' + clientName.trim();
      htmlBody = buildPaymentEmail(contact, clientName, deepDiveUrl);

    } else if (event === 'intro_call_complete') {
      // Fetch intro call steps for checklist summary
      var stepsResp = await fetch(
        sbUrl + '/rest/v1/intro_call_steps?contact_id=eq.' + contact.id + '&step_key=neq.intro_call_complete&order=sort_order.asc&select=step_key,label,category,status',
        { headers: sbHeaders() }
      );
      var steps = await stepsResp.json();
      subject = 'Intro Call Complete: ' + clientName.trim();
      htmlBody = buildIntroCallEmail(contact, clientName, deepDiveUrl, steps || []);

    } else if (event === 'onboarding_complete') {
      subject = 'Onboarding Complete: ' + clientName.trim();
      htmlBody = buildOnboardingEmail(contact, clientName, deepDiveUrl);
    }

    // ── Send via Resend ──
    var recipients = ['support@moonraker.ai', 'scott@moonraker.ai', 'chris@moonraker.ai'];

    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
        to: recipients,
        subject: subject,
        html: htmlBody
      })
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

// ── Email builders ──
// All team emails use a consistent light-themed branded template
// matching the compile-report notification style.

function buildPaymentEmail(contact, clientName, deepDiveUrl) {
  var plan = contact.plan_type || 'CORE Marketing System';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  var practice = contact.practice_name || '';

  return emailWrapper(
    'New Client Payment',
    '<p style="margin:0 0 4px;color:#1E2A5E;font-size:18px;font-weight:700">' + esc(clientName.trim()) + '</p>' +
    '<p style="margin:0 0 16px;color:#6B7599;font-size:14px">' + esc(practice) + (location ? ' \u00B7 ' + esc(location) : '') + '</p>' +
    '<p style="margin:0 0 16px;color:#333F70;font-size:14px">' +
      'Payment received. Status moved to <strong style="color:#00D47E">Onboarding</strong>. ' +
      'Onboarding steps, intro call checklist, and deliverables have been automatically seeded.' +
    '</p>' +
    detailTable([
      ['Plan', plan],
      ['Email', contact.email || ''],
      ['Location', location]
    ]) +
    '<div style="margin-top:20px">' + actionButton('View Client', deepDiveUrl) + '</div>'
  );
}

function buildIntroCallEmail(contact, clientName, deepDiveUrl, steps) {
  var practice = contact.practice_name || '';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');

  // Group steps by category
  var categories = {};
  var catLabels = {
    'platform_access': 'Platform Access',
    'campaign_setup': 'Campaign Setup',
    'expectations': 'Expectations'
  };
  steps.forEach(function(s) {
    var cat = s.category || 'other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(s);
  });

  var completed = steps.filter(function(s) { return s.status === 'complete'; }).length;
  var total = steps.length;
  var pending = total - completed;

  // Build checklist summary
  var checklistHtml = '<div style="margin:16px 0;padding:16px 20px;background:#fff;border-radius:8px;border:1px solid #E2E8F0">' +
    '<p style="font-size:13px;color:#00D47E;margin:0 0 12px;font-weight:600">' +
      completed + ' of ' + total + ' tasks completed' +
      (pending > 0 ? ' \u2014 ' + pending + ' still pending' : ' \u2014 all clear!') +
    '</p>';

  var catOrder = ['platform_access', 'campaign_setup', 'expectations'];
  catOrder.forEach(function(catKey) {
    var catSteps = categories[catKey];
    if (!catSteps) return;
    checklistHtml += '<p style="font-size:11px;color:#6B7599;margin:12px 0 4px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600">' + (catLabels[catKey] || catKey) + '</p>';
    catSteps.forEach(function(s) {
      var icon = s.status === 'complete' ? '\u2705' : '\u2B1C';
      var color = s.status === 'complete' ? '#6B7599' : '#1E2A5E';
      checklistHtml += '<p style="font-size:13px;color:' + color + ';margin:2px 0">' + icon + ' ' + esc(s.label) + '</p>';
    });
  });
  checklistHtml += '</div>';

  var warningHtml = '';
  if (pending > 0) {
    warningHtml = '<p style="font-size:13px;color:#D97706;margin:0 0 16px">\u26A0\uFE0F ' + pending + ' task' + (pending > 1 ? 's' : '') + ' still need attention.</p>';
  }

  return emailWrapper(
    'Intro Call Complete',
    '<p style="margin:0 0 4px;color:#1E2A5E;font-size:18px;font-weight:700">' + esc(clientName.trim()) + '</p>' +
    '<p style="margin:0 0 16px;color:#6B7599;font-size:14px">' + esc(practice) + (location ? ' \u00B7 ' + esc(location) : '') + '</p>' +
    '<p style="margin:0 0 4px;color:#333F70;font-size:14px">The intro call has been completed. Below is the checklist summary.</p>' +
    checklistHtml +
    warningHtml +
    '<div style="margin-top:20px">' + actionButton('View Client', deepDiveUrl) + '</div>'
  );
}

function buildOnboardingEmail(contact, clientName, deepDiveUrl) {
  var practice = contact.practice_name || '';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');

  return emailWrapper(
    'Onboarding Complete',
    '<p style="margin:0 0 4px;color:#1E2A5E;font-size:18px;font-weight:700">' + esc(clientName.trim()) + '</p>' +
    '<p style="margin:0 0 16px;color:#6B7599;font-size:14px">' + esc(practice) + (location ? ' \u00B7 ' + esc(location) : '') + '</p>' +
    '<p style="margin:0 0 16px;color:#333F70;font-size:14px">' +
      'All onboarding steps are complete. Status promoted to <strong style="color:#00D47E">Active</strong>. ' +
      'The client is now ready for ongoing campaign work, reporting, and deliverables.' +
    '</p>' +
    '<p style="margin:0 0 16px;color:#6B7599;font-size:13px">Monthly report scheduling can now be configured in the Reports tab.</p>' +
    '<div style="margin-top:20px">' + actionButton('View Client', deepDiveUrl) + '</div>'
  );
}

// ── Shared email components (light branded template) ──

function emailWrapper(title, bodyContent) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:#F0F4F8;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">' +
    '<div style="max-width:520px;margin:0 auto;padding:32px 16px">' +
      '<div style="text-align:center;margin-bottom:16px">' +
        '<img src="https://clients.moonraker.ai/assets/logo.png" alt="Moonraker" style="height:32px" />' +
      '</div>' +
      '<div style="background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06)">' +
        '<div style="background:#F8FAFC;border-radius:10px;padding:24px">' +
          '<p style="margin:0 0 16px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#00D47E">' + esc(title) + '</p>' +
          bodyContent +
        '</div>' +
      '</div>' +
      '<p style="font-size:11px;color:#6B7599;margin-top:16px;text-align:center">Moonraker AI \u00B7 Team Notification</p>' +
    '</div></body></html>';
}

function detailTable(rows) {
  var html = '<table style="width:100%;font-size:14px;border-collapse:collapse;margin-top:12px">';
  rows.forEach(function(r) {
    if (!r[1]) return;
    html += '<tr>' +
      '<td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">' + esc(r[0]) + '</td>' +
      '<td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + esc(r[1]) + '</td>' +
    '</tr>';
  });
  html += '</table>';
  return html;
}

function actionButton(label, url) {
  return '<a href="' + esc(url) + '" style="display:inline-block;padding:12px 24px;background:#00D47E;color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px">' + esc(label) + '</a>';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

