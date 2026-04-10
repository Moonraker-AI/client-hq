// /api/send-audit-email.js
// Sends a branded entity audit delivery email to the client via Resend.
// Also updates entity_audits status to 'delivered' and records sent_at/sent_to.
//
// POST { audit_id }

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var auditId = (req.body || {}).audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  try {
    // Load audit + contact
    var audit = await sb.one('entity_audits?id=eq.' + auditId + '&select=*,contacts(id,slug,first_name,last_name,practice_name,email,city,state_province)&limit=1');
    if (!audit) return res.status(404).json({ error: 'Audit not found' });

    var contact = audit.contacts;
    if (!contact) return res.status(404).json({ error: 'Contact not found for audit' });
    if (!contact.email) return res.status(400).json({ error: 'No email on file for this contact' });

    var slug = contact.slug;
    var firstName = contact.first_name || '';
    var practiceName = contact.practice_name || '';
    var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';

    // Build scores summary
    var scores = audit.scores || {};
    var overallScore = scores.overall || null;

    var overallHtml = '';
    if (overallScore !== null) {
      var oc = overallScore >= 80 ? '#00D47E' : overallScore >= 50 ? '#F59E0B' : '#EF4444';
      overallHtml = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0 8px;"><tr><td align="center">' +
        '<div style="font-family:Inter,sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6B7599;margin-bottom:6px;">Overall CORE Score</div>' +
        '<div style="font-family:Outfit,sans-serif;font-size:40px;font-weight:700;color:' + oc + ';">' + Math.round(overallScore) + '<span style="font-size:18px;color:#6B7599;">/100</span></div>' +
        '</td></tr></table>';
    }

    // Build CORE score cards
    var coreKeys = [
      { key: 'credibility', label: 'Credibility' },
      { key: 'optimization', label: 'Optimization' },
      { key: 'reputation', label: 'Reputation' },
      { key: 'engagement', label: 'Engagement' }
    ];
    var scoreItems = [];
    coreKeys.forEach(function(k) {
      if (scores[k.key] !== undefined) {
        var v = Math.round(scores[k.key]);
        var color, bg, border;
        if (v < 50) { color = '#EF4444'; bg = 'rgba(239,68,68,.06)'; border = 'rgba(239,68,68,.18)'; }
        else if (v < 80) { color = '#F59E0B'; bg = 'rgba(245,158,11,.06)'; border = 'rgba(245,158,11,.18)'; }
        else { color = '#00b86c'; bg = 'rgba(0,212,126,.06)'; border = 'rgba(0,212,126,.18)'; }
        scoreItems.push({ value: String(v), label: k.label, color: color, bg: bg, border: border });
      }
    });

    var scoreCardsHtml = scoreItems.length > 0 ? email.statCards(scoreItems) : '';

    // Compose email
    var practiceRef = practiceName ? ' for <strong style="color:#1E2A5E;">' + email.esc(practiceName) + '</strong>' : '';
    var content = email.greeting(firstName || 'there') +
      email.p('Your CORE Entity Audit' + practiceRef + ' is ready. This report evaluates your practice\'s digital presence across four key areas: Credibility, Optimization, Reputation, and Engagement.') +
      overallHtml + scoreCardsHtml +
      email.p('Your scorecard includes a detailed breakdown of each area with specific findings and recommendations for improvement.') +
      email.cta(scorecardUrl, 'View Your Scorecard');

    var htmlBody = email.wrap({
      headerLabel: 'CORE Entity Audit', content: content,
      footerNote: '', year: new Date().getFullYear()
    });

    // Send via Resend
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email.FROM.audits, to: [contact.email], cc: ['scott@moonraker.ai'],
        subject: 'Your CORE Entity Audit is Ready' + (practiceName ? ' - ' + practiceName : ''),
        html: htmlBody
      })
    });

    var emailResult = await emailResp.json();
    if (!emailResp.ok) {
      console.error('Resend error:', emailResult);
      return res.status(500).json({ ok: false, error: 'Email send failed', detail: emailResult });
    }

    // Update audit status
    await sb.mutate('entity_audits?id=eq.' + auditId, 'PATCH', {
      status: 'delivered', sent_at: new Date().toISOString(), sent_to: contact.email
    }, 'return=minimal');

    return res.status(200).json({ ok: true, email_id: emailResult.id, sent_to: contact.email });

  } catch (err) {
    console.error('send-audit-email error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
