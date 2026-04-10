// /api/send-report-email.js - Send branded report notification email to client
// Uses shared email template for consistent branding.
// From: reports@clients.moonraker.ai, reply-to support@, CC scott@

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    var body = req.body;
    var snapshotId = body.snapshot_id;
    var previewOnly = body.preview === true;

    if (!snapshotId) return res.status(400).json({ error: 'snapshot_id required' });

    // Fetch snapshot
    var snap = await sb.one('report_snapshots?id=eq.' + snapshotId + '&select=*&limit=1');
    if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

    // Fetch contact
    var contact = await sb.one('contacts?slug=eq.' + snap.client_slug + '&select=first_name,last_name,email,practice_name,credentials,slug&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.email) return res.status(400).json({ error: 'Client has no email address' });

    // Fetch highlights
    var highlights = await sb.query('report_highlights?client_slug=eq.' + snap.client_slug + '&report_month=eq.' + snap.report_month + '&order=sort_order&limit=5');

    // Build month label
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var parts = snap.report_month.split('-');
    var monthLabel = months[parseInt(parts[1]) - 1] + ' ' + parts[0];

    var clientName = (contact.first_name || '') + (contact.last_name ? ' ' + contact.last_name : '');
    var practiceName = contact.practice_name || clientName;
    var reportUrl = 'https://clients.moonraker.ai/' + contact.slug + '/reports#' + snap.report_month;

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
            '<div style="font-family:Outfit,sans-serif;font-weight:700;font-size:15px;color:#1E2A5E;margin-bottom:2px;">' + email.esc(h.headline) + '</div>' +
            '<div style="font-family:Inter,sans-serif;font-size:14px;color:#333F70;line-height:1.5;">' + email.esc(h.body) + '</div>' +
          '</td></tr></table>' +
          '</td></tr>';
      });
    }

    // Build KPI row
    var kpiHtml = '';
    function kpiCell(label, value, sub) {
      return '<td style="text-align:center;padding:16px 8px;">' +
        '<div style="font-family:Inter,sans-serif;font-size:12px;color:#6B7599;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
        '<div style="font-family:Outfit,sans-serif;font-weight:700;font-size:24px;color:#1E2A5E;">' + (value || '-') + '</div>' +
        (sub ? '<div style="font-family:Inter,sans-serif;font-size:11px;color:#6B7599;margin-top:2px;">' + sub + '</div>' : '') +
        '</td>';
    }
    if (snap.gsc_clicks || snap.gsc_impressions) {
      kpiHtml += kpiCell('Clicks', (snap.gsc_clicks || 0).toLocaleString());
      kpiHtml += kpiCell('Impressions', (snap.gsc_impressions || 0).toLocaleString());
    }
    if (snap.tasks_total) {
      kpiHtml += kpiCell('Tasks Complete', snap.tasks_complete + '/' + snap.tasks_total);
    }

    // Geogrid summary
    var geogridHtml = '';
    var neo = snap.neo_data || {};
    if (neo.grids && neo.grids.length > 0) {
      geogridHtml = email.sectionHeading('Local Rank Tracking') +
        '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;border-radius:10px;overflow:hidden;margin-bottom:8px;">';
      neo.grids.forEach(function(g) {
        var label = g.label || g.search_term;
        var solv = Math.round((g.solv || 0) * 100);
        var agrColor = g.agr <= 3 ? '#00D47E' : g.agr <= 7 ? '#F59E0B' : '#EF4444';
        var solvColor = solv >= 60 ? '#00D47E' : solv >= 30 ? '#F59E0B' : '#EF4444';
        geogridHtml += '<tr><td style="padding:12px 16px;border-bottom:1px solid #E2E8F0;">' +
          '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
          '<td style="vertical-align:middle;"><div style="font-family:Outfit,sans-serif;font-weight:700;font-size:14px;color:#1E2A5E;">' + email.esc(label) + '</div>' +
          '<div style="font-family:Inter,sans-serif;font-size:12px;color:#6B7599;margin-top:2px;">' + email.esc(g.search_term) + '</div></td>' +
          '<td style="text-align:right;white-space:nowrap;vertical-align:middle;">' +
          '<span style="font-family:Outfit,sans-serif;font-weight:700;font-size:14px;color:' + agrColor + ';">AGR ' + (g.agr || '-') + '</span>' +
          '<span style="font-family:Inter,sans-serif;color:#E2E8F0;margin:0 6px;">|</span>' +
          '<span style="font-family:Outfit,sans-serif;font-weight:700;font-size:14px;color:' + solvColor + ';">SoLV ' + solv + '%</span>' +
          '</td></tr></table></td></tr>';
      });
      geogridHtml += '</table>' +
        '<p style="font-family:Inter,sans-serif;font-size:12px;color:#6B7599;margin:0 0 24px;">Avg Grid Rank: ' + neo.avg_agr + ' | Share of Local Voice: ' + Math.round((neo.avg_solv || 0) * 100) + '% across ' + neo.grid_count + ' keywords</p>';
    }

    // AI visibility summary
    var aiHtml = '';
    var ai = snap.ai_visibility || {};
    if (ai.engines && ai.engines.length > 0) {
      aiHtml = email.sectionHeading('AI Visibility') +
        '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;border-radius:10px;overflow:hidden;margin-bottom:8px;">';
      ai.engines.forEach(function(e) {
        var dotColor = e.cited ? '#00D47E' : '#CBD5E1';
        var statusText = e.cited ? 'Citing' : 'Not citing';
        var statusColor = e.cited ? '#00D47E' : '#6B7599';
        aiHtml += '<tr><td style="padding:10px 16px;border-bottom:1px solid #E2E8F0;">' +
          '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
          '<td style="width:12px;vertical-align:middle;"><div style="width:10px;height:10px;border-radius:50%;background:' + dotColor + ';"></div></td>' +
          '<td style="padding-left:10px;vertical-align:middle;"><span style="font-family:Inter,sans-serif;font-weight:600;font-size:14px;color:#1E2A5E;">' + email.esc(e.name) + '</span></td>' +
          '<td style="text-align:right;vertical-align:middle;"><span style="font-family:Inter,sans-serif;font-size:13px;font-weight:600;color:' + statusColor + ';">' + statusText + '</span></td>' +
          '</tr></table></td></tr>';
      });
      aiHtml += '</table>' +
        '<p style="font-family:Inter,sans-serif;font-size:12px;color:#6B7599;margin:0 0 24px;">' + (ai.engines_citing || 0) + ' of ' + (ai.engines_checked || 0) + ' AI engines citing this month</p>';
    }

    // Assemble content
    var content =
      '<h1 style="font-family:Outfit,sans-serif;font-weight:700;font-size:24px;color:#1E2A5E;margin:0 0 8px;">Your ' + monthLabel + ' Report is Ready</h1>' +
      '<p style="font-family:Inter,sans-serif;font-size:15px;color:#333F70;margin:0 0 24px;line-height:1.6;">Hi ' + email.esc(contact.first_name || 'there') + ', here is a summary of your campaign progress for ' + monthLabel + ' (Month ' + (snap.campaign_month || '-') + ').</p>' +
      (kpiHtml ? '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;border-radius:10px;margin-bottom:24px;"><tr>' + kpiHtml + '</tr></table>' : '') +
      (highlightsHtml ? email.sectionHeading('Highlights') + '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;border-radius:10px;overflow:hidden;margin-bottom:24px;">' + highlightsHtml + '</table>' : '') +
      geogridHtml +
      aiHtml +
      email.cta(reportUrl, 'View Full Report');

    var emailHtml = email.wrap({
      headerLabel: 'Monthly Campaign Report',
      footerNote: 'Questions about your report? Reply to this email and our team will follow up.',
      content: content
    });

    var subject = 'Your ' + monthLabel + ' Campaign Report is Ready \uD83D\uDCCA';

    // Preview mode
    if (previewOnly) {
      return res.status(200).json({
        success: true, preview: true,
        to: contact.email, cc: 'scott@moonraker.ai',
        reply_to: 'support@moonraker.ai', subject: subject, html: emailHtml
      });
    }

    // Send via Resend
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email.FROM.reports, to: [contact.email],
        cc: ['scott@moonraker.ai'], reply_to: 'support@moonraker.ai',
        subject: subject, html: emailHtml
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
