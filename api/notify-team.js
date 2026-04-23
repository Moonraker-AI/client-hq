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
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin or internal server-to-server key
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var body = req.body || {};
  var event = body.event;
  var slug = body.slug;

  if (!event || !slug) return res.status(400).json({ error: 'Missing event or slug' });

  var validEvents = ['payment_received', 'intro_call_complete', 'onboarding_complete', 'referral_partner', 'addon_purchased', 'strategy_call_purchased', 'strategy_call_lead_purchased'];
  if (validEvents.indexOf(event) === -1) return res.status(400).json({ error: 'Invalid event type' });

  try {
    var contact = await sb.one('contacts?slug=eq.' + slug + '&select=id,first_name,last_name,practice_name,email,phone,website_url,status,plan_type,plan_amount_cents,city,state_province,source&limit=1');
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

    } else if (event === 'referral_partner') {
      var partner = body.partner || 'Unknown';
      var partnerEmail = body.partner_email || '';
      subject = 'Referral Partner Logged: ' + clientName.trim() + ' via ' + partner.split(' (')[0];
      headerLabel = 'Referral Partner';
      content = buildReferralContent(contact, clientName, deepDiveUrl, partner, partnerEmail);

    } else if (event === 'addon_purchased') {
      var addonTierKey = body.tier_key || 'unknown';
      var addonPrettyName = prettyTierName(addonTierKey);
      subject = 'Add-on Purchased: ' + addonPrettyName + ' \u2014 ' + clientName.trim();
      headerLabel = 'Add-on Purchased';
      content = buildAddonContent(contact, clientName, deepDiveUrl, addonTierKey, addonPrettyName);

    } else if (event === 'strategy_call_purchased') {
      // Legacy buy.stripe.com flow — same email shape as an addon purchase.
      subject = 'Strategy Call Purchased: ' + clientName.trim();
      headerLabel = 'Strategy Call Purchased';
      content = buildAddonContent(contact, clientName, deepDiveUrl, 'paid_strategy_call', 'Paid Strategy Call');

    } else if (event === 'strategy_call_lead_purchased') {
      // New flow from /strategy-call landing page. This fires for a lead
      // who just paid $150 for a 1-hour call with Scott. They've already
      // been redirected to /strategy-call/success where Scott's calendar
      // is embedded, so the ideal path is: they book within minutes.
      // If they don't, Scott reaches out within 24h.
      var practice = (contact.practice_name || '').trim();
      subject = 'New Strategy Call Lead: ' + clientName.trim() + (practice ? ' \u2014 ' + practice : '');
      headerLabel = 'Strategy Call Lead';
      content = buildStrategyCallLeadContent(contact, clientName, deepDiveUrl);

    } else if (event === 'site_map_submitted') {
      // Client finished the onboarding site-map step and submitted for review.
      // Admin reviews at /admin/clients/<slug>/site-map and hits "Approve"
      // which flips the onboarding step to complete.
      subject = 'Site Map Submitted: ' + clientName.trim();
      headerLabel = 'Site Map Ready for Review';
      content = buildSiteMapSubmittedContent(contact, clientName, deepDiveUrl);
    }

    var htmlBody = email.wrap({
      headerLabel: headerLabel, content: content,
      footerNote: 'This is an internal notification for the Moonraker team.'
    });

    var recipients;
    if (event === 'referral_partner') {
      recipients = ['chris@moonraker.ai'];
    } else if (event === 'strategy_call_lead_purchased') {
      // Pre-CRM lead: support@ (Karen) handles onboarded clients; for a
      // lead that just paid for a first call, Scott is the primary owner
      // with Chris looped in.
      recipients = ['scott@moonraker.ai', 'chris@moonraker.ai'];
    } else {
      recipients = ['support@moonraker.ai', 'scott@moonraker.ai', 'chris@moonraker.ai'];
    }

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
    monitor.logError('notify-team', err, { client_slug: slug, detail: { event: event } });
    return res.status(500).json({ error: 'Internal error' });
  }
};

// ── Content builders ──

function clientHeader(contact, clientName) {
  var practice = contact.practice_name || '';
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  return email.sectionHeading(clientName.trim()) +
    (practice || location
      ? email.pRaw(email.esc(practice) + (practice && location ? ' \u00B7 ' : '') + email.esc(location))
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
    email.pRaw('Payment received. Status moved to <strong style="color:#00D47E">Onboarding</strong>. Onboarding steps, intro call checklist, and deliverables have been automatically seeded.') +
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
    warningHtml = email.pRaw('<span style="color:#D97706">\u26A0\uFE0F ' + pending + ' task' + (pending > 1 ? 's' : '') + ' still need' + (pending === 1 ? 's' : '') + ' attention.</span>');
  }

  return clientHeader(contact, clientName) +
    email.pRaw('The intro call has been completed. Below is the checklist summary.') +
    checklistHtml + warningHtml +
    email.cta(deepDiveUrl, 'View Client');
}

function buildOnboardingContent(contact, clientName, deepDiveUrl) {
  return clientHeader(contact, clientName) +
    email.pRaw('All onboarding steps are complete. Status promoted to <strong style="color:#00D47E">Active</strong>. The client is now ready for ongoing campaign work, reporting, and deliverables.') +
    email.pRaw('<span style="color:#6B7599;font-size:13px">Monthly report scheduling can now be configured in the Reports tab.</span>') +
    email.cta(deepDiveUrl, 'View Client');
}

function buildSiteMapSubmittedContent(contact, clientName, deepDiveUrl) {
  var configuratorUrl = 'https://clients.moonraker.ai/admin/clients/' + encodeURIComponent(contact.slug) + '/site-map';
  return clientHeader(contact, clientName) +
    email.pRaw('The client has finished reviewing their site map and submitted it for approval. The onboarding wizard is paused on this step until a team member approves it.') +
    email.pRaw('<span style="color:#6B7599;font-size:13px">Review highlighted services and locations, propose URL rewrites if needed, then click <strong>Approve</strong> to mark the step complete and advance onboarding.</span>') +
    email.cta(configuratorUrl, 'Review Site Map') +
    email.pRaw('<div style="text-align:center;margin-top:12px"><a href="' + deepDiveUrl + '" style="font-size:13px;color:#6B7599">Open full client deep-dive \u2192</a></div>');
}

function buildReferralContent(contact, clientName, deepDiveUrl, partner, partnerEmail) {
  var planCents = contact.plan_amount_cents || 0;
  var firstPayment = planCents > 0 ? '$' + (planCents / 100).toFixed(2) : 'Not set';
  var suggestedPayout = planCents > 0 ? '$' + (planCents / 100 * 0.1).toFixed(2) : 'N/A';
  var plan = contact.plan_type || 'CORE Marketing System';

  var rows = [
    ['Client', clientName.trim()],
    ['Plan', plan],
    ['First Payment', firstPayment],
    ['Referral Partner', partner],
    ['Suggested Payout (10%)', suggestedPayout]
  ];
  if (partnerEmail) rows.push(['Partner Email', partnerEmail]);

  return clientHeader(contact, clientName) +
    email.pRaw('A referral partner has been logged for this client. Below are the details for commission payout.') +
    email.divider() +
    email.sectionHeading('Referral Payout Details') +
    detailTable(rows) +
    email.pRaw('<span style="color:#D97706;font-weight:600">Action needed:</span> Send the referral partner their 10% commission of the first payment.') +
    email.cta(deepDiveUrl, 'View Client');
}

// ── Add-on purchase helpers ──

// Human-readable tier label. tier_key → Title Case. Falls back gracefully
// when the key is missing or unrecognized.
function prettyTierName(tierKey) {
  if (!tierKey || tierKey === 'unknown') return 'Add-on';
  return String(tierKey).replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

// Uses the same branded email template as payment_received / onboarding_complete
// so the team sees a consistent look-and-feel. No status is changed in the
// database when an addon is purchased (the webhook only logs the payment and
// fires this notification); the email just exists to alert the team to
// fulfill the add-on.
function buildAddonContent(contact, clientName, deepDiveUrl, tierKey, prettyName) {
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  var currentStatus = (contact.status || 'unknown').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  return clientHeader(contact, clientName) +
    email.pRaw('An <strong>' + email.esc(prettyName) + '</strong> has been purchased. Client lifecycle status is unchanged &mdash; this is a one-off purchase that needs fulfillment outside the main campaign flow.') +
    detailTable([
      ['Add-on', prettyName],
      ['Tier Key', tierKey],
      ['Client Status', currentStatus],
      ['Email', contact.email || ''],
      ['Location', location]
    ]) +
    email.pRaw('<span style="color:#D97706;font-weight:600">Action needed:</span> Coordinate delivery of this add-on outside the CORE campaign pipeline. The payment is already logged in the client record.') +
    email.cta(deepDiveUrl, 'View Client');
}

// Brand-new lead from /strategy-call landing page. They just paid $150 and
// have already been redirected to /strategy-call/success where Scott's
// calendar is embedded — most people will book in minutes. If they don't,
// Scott reaches out within 24h using the intake details in this email.
function buildStrategyCallLeadContent(contact, clientName, deepDiveUrl) {
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ');
  var currentStatus = (contact.status || 'lead').replace(/\b\w/g, function(c) { return c.toUpperCase(); });

  var rows = [
    ['Name',      clientName.trim()],
    ['Practice',  contact.practice_name || ''],
    ['Email',     contact.email || ''],
    ['Phone',     contact.phone || ''],
    ['Website',   contact.website_url || ''],
    ['Location',  location],
    ['Source',    contact.source || 'strategy_call'],
    ['Status',    currentStatus]
  ];

  return clientHeader(contact, clientName) +
    email.pRaw('A new lead just paid <strong>$150</strong> for a 1-hour strategy call with Scott. They\'ve been redirected to the success page with the calendar embedded, so most leads book within a few minutes of paying.') +
    detailTable(rows) +
    email.pRaw('<span style="color:#D97706;font-weight:600">If no booking within 24 hours:</span> reach out directly using the phone or email above. The $150 momentum fades fast.') +
    email.cta(deepDiveUrl, 'View Lead in Admin');
}

