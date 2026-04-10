// /api/generate-audit-followups.js
// Generates 3 follow-up email drafts for a delivered entity audit.
// Emails are personalized from the CORE scores and findings data.
// Schedule: Day 2, Day 7, Day 14 after audit delivery.
//
// POST { audit_id }

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

var FOOTER_NOTE = 'Questions? Reply to this email or <a href="' + email.CALENDAR_URL + '" style="font-family:Inter,sans-serif;color:#00D47E;text-decoration:none;font-weight:500;">book a call with Scott</a>.';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var auditId = (req.body || {}).audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });


  try {
    // Load audit + contact
    var auditResp = await fetch(
      sb.url() + '/rest/v1/entity_audits?id=eq.' + auditId + '&select=*,contacts(id,slug,first_name,last_name,practice_name,email,city,state_province)&limit=1',
      { headers: sb.headers() }
    );
    var audits = await auditResp.json();
    if (!audits || audits.length === 0) return res.status(404).json({ error: 'Audit not found' });

    var audit = audits[0];
    var contact = audit.contacts;
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Check for existing followups
    var existCheck = await fetch(
      sb.url() + '/rest/v1/audit_followups?audit_id=eq.' + auditId + '&limit=1',
      { headers: sb.headers() }
    );
    var existing = await existCheck.json();
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Follow-ups already exist for this audit. Delete them first to regenerate.' });
    }

    // Extract scores and findings
    var scores = audit.scores || {};
    var firstName = contact.first_name || '';
    var practiceName = contact.practice_name || '';
    var slug = contact.slug;
    var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';
    var bookingUrl = 'https://msg.moonraker.ai/widget/bookings/moonraker-free-strategy-call';

    // Find weakest and strongest areas
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

    // Extract tasks/findings if available
    var tasks = audit.tasks || [];
    var weakestTasks = tasks.filter(function(t) { return t.category && t.category.toLowerCase().indexOf(weakest.key) > -1; }).slice(0, 3);
    var secondTasks = tasks.filter(function(t) { return t.category && t.category.toLowerCase().indexOf(secondWeakest.key) > -1; }).slice(0, 2);

    // Build 3 emails
    var emails = [
      buildEmail1(firstName, practiceName, overall, weakest, scorecardUrl, bookingUrl),
      buildEmail2(firstName, practiceName, weakest, secondWeakest, weakestTasks, secondTasks, scorecardUrl, bookingUrl),
      buildEmail3(firstName, practiceName, overall, strongest, weakest, bookingUrl)
    ];

    // Insert as drafts
    var rows = emails.map(function(e, i) {
      return {
        audit_id: auditId,
        contact_id: contact.id,
        sequence_number: i + 1,
        day_offset: e.dayOffset,
        status: 'draft',
        subject: e.subject,
        body_html: e.html
      };
    });

    var insertResp = await fetch(sb.url() + '/rest/v1/audit_followups', {
      method: 'POST',
      headers: sb.headers('return=representation'),
      body: JSON.stringify(rows)
    });
    var inserted = await insertResp.json();

    return res.status(200).json({ ok: true, count: rows.length, followups: inserted });

  } catch (err) {
    console.error('generate-audit-followups error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ── Signature block appended to all emails ──

function signoff(text) {
  return email.p(text) +
    '<p style="font-family:Inter,sans-serif;font-size:15px;color:#1E2A5E;line-height:1.7;margin:0;">Scott Pope</p>' +
    '<p style="font-family:Inter,sans-serif;font-size:13px;color:#6B7599;line-height:1.5;margin:0;">Director of Growth, Moonraker AI</p>';
}

function wrapEmail(content) {
  return email.wrap({
    headerLabel: 'CORE Entity Audit',
    content: content,
    footerNote: FOOTER_NOTE,
    year: new Date().getFullYear()
  });
}

// ── Email Builders ──

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

  return { dayOffset: 2, subject: 'Did you get a chance to review your CORE Score?', html: wrapEmail(content) };
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

  return { dayOffset: 7, subject: 'What your CORE audit means for ' + (practiceName || 'your practice'), html: wrapEmail(content) };
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

  return { dayOffset: 14, subject: 'A quick roadmap for ' + (practiceName || 'your practice'), html: wrapEmail(content) };
}
