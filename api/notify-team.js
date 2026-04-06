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
    var deepDiveUrl = 'https://clients.moonraker.ai/admin/clients#' + slug;

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

function buildPaymentEmail(contact, clientName, deepDiveUrl) {
  var plan = contact.plan_type || 'CORE Marketing System';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  var practice = contact.practice_name || '';

  return emailWrapper(
    '💳 New Client Payment',
    '<p style="font-size:16px;color:#e0e0e0;margin:0 0 20px;">' +
      '<strong style="color:#fff;">' + esc(clientName.trim()) + '</strong> has completed payment and has been moved to <strong style="color:#00D47E;">Onboarding</strong>.' +
    '</p>' +
    detailRow('Practice', practice) +
    detailRow('Location', location) +
    detailRow('Email', contact.email || '') +
    detailRow('Plan', plan) +
    '<div style="margin-top:24px;">' +
      actionButton('View Client', deepDiveUrl) +
    '</div>' +
    '<p style="font-size:13px;color:#888;margin-top:20px;">Onboarding steps and intro call checklist have been automatically seeded. Deliverables have been created.</p>'
  );
}

function buildIntroCallEmail(contact, clientName, deepDiveUrl, steps) {
  var practice = contact.practice_name || '';

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

  var summaryHtml = '<div style="margin:20px 0;padding:16px;background:#1a1f2e;border-radius:8px;border:1px solid #2a2f3e;">' +
    '<p style="font-size:14px;color:#00D47E;margin:0 0 12px;font-weight:600;">' +
      completed + ' of ' + total + ' tasks completed' +
      (pending > 0 ? ' &mdash; ' + pending + ' still pending' : ' &mdash; all clear!') +
    '</p>';

  var catOrder = ['platform_access', 'campaign_setup', 'expectations'];
  catOrder.forEach(function(catKey) {
    var catSteps = categories[catKey];
    if (!catSteps) return;
    summaryHtml += '<p style="font-size:12px;color:#888;margin:12px 0 6px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">' + (catLabels[catKey] || catKey) + '</p>';
    catSteps.forEach(function(s) {
      var icon = s.status === 'complete' ? '✅' : '⬜';
      var labelColor = s.status === 'complete' ? '#888' : '#e0e0e0';
      var textDecoration = s.status === 'complete' ? 'line-through' : 'none';
      summaryHtml += '<p style="font-size:13px;color:' + labelColor + ';margin:3px 0;text-decoration:' + textDecoration + ';">' + icon + ' ' + esc(s.label) + '</p>';
    });
  });
  summaryHtml += '</div>';

  return emailWrapper(
    '📋 Intro Call Complete',
    '<p style="font-size:16px;color:#e0e0e0;margin:0 0 20px;">' +
      'The intro call for <strong style="color:#fff;">' + esc(clientName.trim()) + '</strong>' +
      (practice ? ' (' + esc(practice) + ')' : '') +
      ' has been completed.' +
    '</p>' +
    summaryHtml +
    (pending > 0
      ? '<p style="font-size:13px;color:#f0ad4e;margin-top:16px;">⚠️ ' + pending + ' task' + (pending > 1 ? 's' : '') + ' still need attention. Check the deep-dive for details.</p>'
      : '') +
    '<div style="margin-top:24px;">' +
      actionButton('View Client', deepDiveUrl) +
    '</div>'
  );
}

function buildOnboardingEmail(contact, clientName, deepDiveUrl) {
  var practice = contact.practice_name || '';

  return emailWrapper(
    '🎉 Onboarding Complete',
    '<p style="font-size:16px;color:#e0e0e0;margin:0 0 20px;">' +
      '<strong style="color:#fff;">' + esc(clientName.trim()) + '</strong>' +
      (practice ? ' (' + esc(practice) + ')' : '') +
      ' has completed all onboarding steps and has been promoted to <strong style="color:#00D47E;">Active</strong>.' +
    '</p>' +
    '<p style="font-size:14px;color:#ccc;margin:0 0 20px;">The client is now ready for ongoing campaign work, reporting, and deliverables.</p>' +
    '<div style="margin-top:24px;">' +
      actionButton('View Client', deepDiveUrl) +
    '</div>' +
    '<p style="font-size:13px;color:#888;margin-top:20px;">Monthly report scheduling can now be configured in the Reports tab.</p>'
  );
}

// ── Shared email components ──

function emailWrapper(title, bodyContent) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
      '<div style="margin-bottom:24px;">' +
        '<img src="https://clients.moonraker.ai/assets/logo.png" alt="Moonraker" style="height:28px;" />' +
      '</div>' +
      '<div style="background:#141922;border-radius:12px;border:1px solid #1e2533;padding:28px;">' +
        '<h2 style="font-size:18px;color:#fff;margin:0 0 16px;font-weight:600;">' + title + '</h2>' +
        bodyContent +
      '</div>' +
      '<p style="font-size:11px;color:#555;margin-top:20px;text-align:center;">Moonraker AI &middot; Team Notification</p>' +
    '</div>' +
    '</body></html>';
}

function detailRow(label, value) {
  if (!value) return '';
  return '<p style="font-size:14px;color:#ccc;margin:6px 0;">' +
    '<span style="color:#888;">' + esc(label) + ':</span> ' + esc(value) +
  '</p>';
}

function actionButton(label, url) {
  return '<a href="' + esc(url) + '" style="display:inline-block;padding:10px 20px;background:#00D47E;color:#0d1117;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">' + esc(label) + '</a>';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
