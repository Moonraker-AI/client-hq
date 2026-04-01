// /api/send-report-email.js - Send branded report notification email to client
// Uses Resend from reports@clients.moonraker.ai, reply-to support@, CC scott@

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var resendKey = process.env.RESEND_API_KEY;
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    var body = req.body;
    var snapshotId = body.snapshot_id;
    var previewOnly = body.preview === true;

    if (!snapshotId) return res.status(400).json({ error: 'snapshot_id required' });

    var headers = {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
      'Accept': 'application/json'
    };

    // Fetch snapshot
    var snapResp = await fetch(sbUrl + '/rest/v1/report_snapshots?id=eq.' + snapshotId + '&select=*&limit=1', { headers: headers });
    var snaps = await snapResp.json();
    if (!snaps || snaps.length === 0) return res.status(404).json({ error: 'Snapshot not found' });
    var snap = snaps[0];

    // Fetch contact
    var contactResp = await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + snap.client_slug + '&select=first_name,last_name,email,practice_name,credentials,slug&limit=1', { headers: headers });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found' });
    var contact = contacts[0];

    if (!contact.email) return res.status(400).json({ error: 'Client has no email address' });

    // Fetch highlights
    var hlResp = await fetch(sbUrl + '/rest/v1/report_highlights?client_slug=eq.' + snap.client_slug + '&report_month=eq.' + snap.report_month + '&order=sort_order&limit=5', { headers: headers });
    var highlights = await hlResp.json();

    // Build month label
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var parts = snap.report_month.split('-');
    var monthLabel = months[parseInt(parts[1]) - 1] + ' ' + parts[0];

    var clientName = (contact.first_name || '') + (contact.last_name ? ' ' + contact.last_name : '');
    var practiceName = contact.practice_name || clientName;
    var reportUrl = 'https://clients.moonraker.ai/' + contact.slug + '/reports#' + snap.report_month;
    var calendarUrl = 'https://msg.moonraker.ai/widget/bookings/scott-pope-calendar';

    // Build highlights HTML
    var highlightsHtml = '';
    if (highlights && highlights.length > 0) {
      var iconColors = { win: '#00D47E', milestone: '#3B82F6', insight: '#F59E0B', action: '#8B5CF6' };
      var iconEmojis = { win: '&#127942;', milestone: '&#128202;', insight: '&#128161;', action: '&#9889;' };
      highlights.forEach(function(h) {
        var color = iconColors[h.highlight_type] || '#00D47E';
        var emoji = iconEmojis[h.highlight_type] || '&#11088;';
        highlightsHtml += '<tr><td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;">' +
          '<table cellpadding="0" cellspacing="0" border="0"><tr>' +
          '<td style="width:36px;vertical-align:top;padding-right:12px;">' +
            '<div style="width:36px;height:36px;border-radius:8px;background:' + color + '15;text-align:center;line-height:36px;font-size:18px;">' + emoji + '</div>' +
          '</td>' +
          '<td style="vertical-align:top;">' +
            '<div style="font-family:Outfit,sans-serif;font-weight:700;font-size:15px;color:#1E2A5E;margin-bottom:2px;">' + esc(h.headline) + '</div>' +
            '<div style="font-size:14px;color:#333F70;line-height:1.5;">' + esc(h.body) + '</div>' +
          '</td></tr></table>' +
          '</td></tr>';
      });
    }

    // Build KPI row
    var kpiHtml = '';
    function kpiCell(label, value, sub) {
      return '<td style="text-align:center;padding:16px 8px;">' +
        '<div style="font-size:12px;color:#6B7599;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
        '<div style="font-family:Outfit,sans-serif;font-weight:700;font-size:24px;color:#1E2A5E;">' + (value || '-') + '</div>' +
        (sub ? '<div style="font-size:11px;color:#6B7599;margin-top:2px;">' + sub + '</div>' : '') +
        '</td>';
    }
    if (snap.gsc_clicks || snap.gsc_impressions) {
      kpiHtml += kpiCell('Clicks', (snap.gsc_clicks || 0).toLocaleString());
      kpiHtml += kpiCell('Impressions', (snap.gsc_impressions || 0).toLocaleString());
    }
    if (snap.tasks_total) {
      kpiHtml += kpiCell('Tasks Complete', snap.tasks_complete + '/' + snap.tasks_total);
    }

    // Full email HTML
    var emailHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
      '<body style="margin:0;padding:0;background:#F7FDFB;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;">' +
      '<tr><td align="center" style="padding:24px 16px;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">' +

      // Header
      '<tr><td style="background:#141C3A;padding:24px 32px;border-radius:14px 14px 0 0;">' +
        '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
          '<td><img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" alt="Moonraker" height="28" style="display:block;"></td>' +
          '<td style="text-align:right;"><span style="color:rgba(232,245,239,.45);font-size:12px;">Monthly Campaign Report</span></td>' +
        '</tr></table>' +
      '</td></tr>' +

      // Hero
      '<tr><td style="background:#FFFFFF;padding:32px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0;">' +
        '<h1 style="font-family:Outfit,sans-serif;font-weight:700;font-size:24px;color:#1E2A5E;margin:0 0 8px;">Your ' + monthLabel + ' Report is Ready</h1>' +
        '<p style="font-size:15px;color:#333F70;margin:0 0 24px;line-height:1.6;">Hi ' + esc(contact.first_name || 'there') + ', here is a summary of your campaign progress for ' + monthLabel + ' (Month ' + (snap.campaign_month || '-') + ').</p>' +

        // KPIs
        (kpiHtml ? '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;border-radius:10px;margin-bottom:24px;"><tr>' + kpiHtml + '</tr></table>' : '') +
      '</td></tr>' +

      // Highlights
      (highlightsHtml ? '<tr><td style="background:#FFFFFF;padding:0 32px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0;">' +
        '<h2 style="font-family:Outfit,sans-serif;font-weight:700;font-size:18px;color:#1E2A5E;margin:0 0 12px;">Highlights</h2>' +
        '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;border-radius:10px;overflow:hidden;">' +
        highlightsHtml +
        '</table>' +
      '</td></tr>' : '') +

      // CTA
      '<tr><td style="background:#FFFFFF;padding:8px 32px 32px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0;">' +
        '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">' +
          '<a href="' + reportUrl + '" style="display:inline-block;background:#00D47E;color:#FFFFFF;font-family:Outfit,sans-serif;font-weight:700;font-size:15px;text-decoration:none;padding:14px 32px;border-radius:10px;">View Full Report</a>' +
        '</td></tr></table>' +
      '</td></tr>' +

      // Footer
      '<tr><td style="background:#F7FDFB;padding:24px 32px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px;text-align:center;">' +
        '<p style="font-size:13px;color:#6B7599;margin:0 0 8px;line-height:1.6;">Questions about your report? Reply to this email or <a href="' + calendarUrl + '" style="color:#00D47E;text-decoration:none;font-weight:500;">book a call with Scott</a>.</p>' +
        '<p style="font-size:12px;color:#6B7599;margin:0;">&copy; 2026 Moonraker AI &middot; <a href="https://moonraker.ai" style="color:#6B7599;">moonraker.ai</a></p>' +
      '</td></tr>' +

      '</table></td></tr></table></body></html>';

    var subject = 'Your ' + monthLabel + ' Campaign Report is Ready \uD83D\uDCCA';

    // Preview mode - return the HTML without sending
    if (previewOnly) {
      return res.status(200).json({
        success: true,
        preview: true,
        to: contact.email,
        cc: 'scott@moonraker.ai',
        reply_to: 'support@moonraker.ai',
        subject: subject,
        html: emailHtml
      });
    }

    // Send via Resend
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Moonraker Reports <reports@clients.moonraker.ai>',
        to: [contact.email],
        cc: ['scott@moonraker.ai'],
        reply_to: 'support@moonraker.ai',
        subject: subject,
        html: emailHtml
      })
    });

    if (emailResp.ok) {
      var result = await emailResp.json();
      return res.status(200).json({ success: true, email_id: result.id, sent_to: contact.email });
    } else {
      var errText = await emailResp.text();
      return res.status(500).json({ error: 'Resend failed', status: emailResp.status, detail: errText });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
