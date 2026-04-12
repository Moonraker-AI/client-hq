// /api/send-audit-email.js
// Sends a branded entity audit delivery email to the client via Resend.
// Also updates entity_audits status to 'delivered' and records sent_at/sent_to.
// After delivery, auto-generates and auto-schedules the 3-email follow-up sequence.
//
// POST { audit_id }

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var FOOTER_NOTE = 'Questions? Reply to this email or <a href="' + email.CALENDAR_URL + '" style="font-family:Inter,sans-serif;color:#00D47E;text-decoration:none;font-weight:500;">book a call with Scott</a>.';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var auditId = (req.body || {}).audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  try {
    // Load audit + contact
    var audit = await sb.one('entity_audits?id=eq.' + auditId + '&select=*,contacts!contact_id(id,slug,first_name,last_name,practice_name,email,city,state_province)&limit=1');
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

    // ── Auto-generate and schedule follow-up sequence ──
    var followupsScheduled = 0;
    try {
      var existingFus = await sb.query('audit_followups?audit_id=eq.' + auditId + '&limit=1');
      if (!existingFus || existingFus.length === 0) {
        var fuEmails = buildFollowupSequence(audit, contact);
        var now = new Date();
        var rows = fuEmails.map(function(e, i) {
          var sendDate = new Date(now);
          sendDate.setDate(sendDate.getDate() + e.dayOffset);
          sendDate.setUTCHours(14, 0, 0, 0); // 10am ET
          return {
            audit_id: auditId,
            contact_id: contact.id,
            sequence_number: i + 1,
            day_offset: e.dayOffset,
            status: 'pending',
            subject: e.subject,
            body_html: e.html,
            scheduled_for: sendDate.toISOString()
          };
        });
        await sb.mutate('audit_followups', 'POST', rows, 'return=minimal');
        followupsScheduled = rows.length;
        console.log('Auto-scheduled ' + followupsScheduled + ' follow-ups for audit ' + auditId);
      }
    } catch (fuErr) {
      console.error('Auto follow-up generation failed (non-critical):', fuErr.message);
    }

    return res.status(200).json({ ok: true, email_id: emailResult.id, sent_to: contact.email, followups_scheduled: followupsScheduled });

  } catch (err) {
    console.error('send-audit-email error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// ── Follow-up email builders ──

function signoff(text) {
  return email.p(text) +
    '<p style="font-family:Inter,sans-serif;font-size:15px;color:#1E2A5E;line-height:1.7;margin:0;">Scott Pope</p>' +
    '<p style="font-family:Inter,sans-serif;font-size:13px;color:#6B7599;line-height:1.5;margin:0;">Director of Growth, Moonraker AI</p>';
}

function wrapFollowup(content) {
  return email.wrap({
    headerLabel: 'CORE Entity Audit',
    content: content,
    footerNote: FOOTER_NOTE,
    year: new Date().getFullYear()
  });
}

function buildFollowupSequence(audit, contact) {
  var scores = audit.scores || {};
  var firstName = contact.first_name || '';
  var practiceName = contact.practice_name || '';
  var slug = contact.slug;
  var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';
  var bookingUrl = 'https://msg.moonraker.ai/widget/bookings/moonraker-free-strategy-call';

  var areas = [
    { key: 'credibility', label: 'Credibility', score: scores.credibility || 0 },
    { key: 'optimization', label: 'Optimization', score: scores.optimization || 0 },
    { key: 'reputation', label: 'Reputation', score: scores.reputation || 0 },
    { key: 'engagement', label: 'Engagement', score: scores.engagement || 0 }
  ];
  areas.sort(function(a, b) { return a.score - b.score; });
  var weakest = areas[0];
  var secondWeakest = areas[1];
  var strongest = areas[areas.length - 1];
  var overall = scores.overall || 0;

  var tasks = audit.tasks || [];
  var weakestTasks = tasks.filter(function(t) { return t.category && t.category.toLowerCase().indexOf(weakest.key) > -1; }).slice(0, 3);
  var secondTasks = tasks.filter(function(t) { return t.category && t.category.toLowerCase().indexOf(secondWeakest.key) > -1; }).slice(0, 2);

  return [
    buildEmail1(firstName, practiceName, overall, weakest, scorecardUrl, bookingUrl),
    buildEmail2(firstName, practiceName, weakest, secondWeakest, weakestTasks, secondTasks, scorecardUrl, bookingUrl),
    buildEmail3(firstName, practiceName, overall, strongest, weakest, bookingUrl)
  ];
}

function buildEmail1(firstName, practiceName, overall, weakest, scorecardUrl, bookingUrl) {
  var scoreColor = overall >= 80 ? '#00D47E' : overall >= 50 ? '#F59E0B' : '#EF4444';
  var weakColor = weakest.score >= 80 ? '#00D47E' : weakest.score >= 50 ? '#F59E0B' : '#EF4444';

  var content = email.greeting(firstName || 'there') +
    email.p('I wanted to follow up and make sure you had a chance to look over the entity audit we put together for ' + email.esc(practiceName || 'your practice') + '.') +
    email.p('Your overall CORE Score came in at <strong style="color:' + scoreColor + ';">' + Math.round(overall) + '/100</strong>. The area with the most room for improvement is <strong>' + email.esc(weakest.label) + '</strong>, which scored <strong style="color:' + weakColor + ';">' + Math.round(weakest.score) + '/100</strong>.') +
    email.p('This is actually one of the most common patterns we see with therapy practices. The good news is that ' + email.esc(weakest.label).toLowerCase() + ' improvements tend to show measurable results within the first 60 to 90 days.') +
    email.p('If you have any questions about the scorecard, I am happy to walk through it with you:') +
    email.cta(scorecardUrl, 'View Your Scorecard') +
    email.p('Or if you would prefer to discuss it live:') +
    email.secondaryCta(bookingUrl, 'Book a Free Strategy Call') +
    signoff('Talk soon,');

  return { dayOffset: 2, subject: 'Did you get a chance to review your CORE Score?', html: wrapFollowup(content) };
}

function buildEmail2(firstName, practiceName, weakest, secondWeakest, weakTasks, secondTasks, scorecardUrl, bookingUrl) {
  var findingsHtml = '';
  if (weakTasks.length > 0 || secondTasks.length > 0) {
    findingsHtml = email.p('Here are a couple of specific things we found:');
    findingsHtml += email.sectionHeading(email.esc(weakest.label) + ' (' + Math.round(weakest.score) + '/100)');
    if (weakTasks.length > 0) {
      weakTasks.forEach(function(t) {
        findingsHtml += email.p('&bull; ' + email.esc(t.title || t.description || ''));
      });
    } else {
      findingsHtml += email.p('&bull; This area needs attention based on our analysis');
    }
    if (secondTasks.length > 0) {
      findingsHtml += email.sectionHeading(email.esc(secondWeakest.label) + ' (' + Math.round(secondWeakest.score) + '/100)');
      secondTasks.forEach(function(t) {
        findingsHtml += email.p('&bull; ' + email.esc(t.title || t.description || ''));
      });
    }
  }

  var content = email.greeting(firstName || 'there') +
    email.p('I wanted to share a bit more context on what we found in your entity audit.') +
    findingsHtml +
    email.p('The reason this matters: when AI platforms like Google AI Overviews, ChatGPT, and Gemini recommend therapists, they pull from the same signals we measured in your audit. A lower ' + email.esc(weakest.label).toLowerCase() + ' score means those platforms have less confidence when deciding whether to recommend your practice.') +
    email.p('We have seen practices go from not appearing in AI results at all to being recommended consistently within 3 to 4 months of addressing these areas.') +
    email.p('Would it be helpful to walk through exactly what we would prioritize if we were working together?') +
    email.cta(bookingUrl, 'Book a Free Strategy Call') +
    signoff('Best,');

  return { dayOffset: 7, subject: 'What your CORE audit means for ' + (practiceName || 'your practice'), html: wrapFollowup(content) };
}

function buildEmail3(firstName, practiceName, overall, strongest, weakest, bookingUrl) {
  var content = email.greeting(firstName || 'there') +
    email.p('I know things get busy, so I will keep this short.') +
    email.p('Based on your audit, here is what the first 90 days would look like if we worked together:') +
    email.sectionHeading('Month 1: Foundation') +
    email.p('We would address the ' + email.esc(weakest.label).toLowerCase() + ' gaps that are currently holding back your visibility. This includes the technical setup that tells Google and AI platforms you are a legitimate, qualified practice.') +
    email.sectionHeading('Month 2: Authority') +
    email.p('We would start creating and distributing content that establishes you as an expert in your specialties. Your ' + email.esc(strongest.label).toLowerCase() + ' score of ' + Math.round(strongest.score) + ' shows you already have a strong base to build on.') +
    email.sectionHeading('Month 3: Optimize') +
    email.p('By this point, most practices start seeing movement in their local search rankings, AI visibility, and new patient inquiries.') +
    email.p('We back this with a performance guarantee for annual clients: if we do not hit our shared goal in 12 months, we continue working for free until you get there.') +
    email.p('If you are interested in learning more, I would love to chat:') +
    email.cta(bookingUrl, 'Book a Free Strategy Call') +
    signoff('All the best,');

  return { dayOffset: 14, subject: 'A quick roadmap for ' + (practiceName || 'your practice'), html: wrapFollowup(content) };
}
