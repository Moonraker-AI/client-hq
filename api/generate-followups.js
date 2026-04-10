// /api/generate-followups.js
// Generates a 4-email follow-up sequence for a sent proposal.
// Uses shared email template for consistent branding.
//
// POST { proposal_id }
// Returns the draft sequence for preview before approval.
//
// Sequence:
//   1. Day 3  - Check-in: did you get a chance to review?
//   2. Day 7  - Value-add: concrete tip relevant to their practice
//   3. Day 14 - Social proof: results from similar practices
//   4. Day 21 - Graceful close: have your priorities shifted?

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });


  // Load proposal + contact
  var proposal, contact;
  try {
    var pResp = await fetch(sb.url() + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1', { headers: sb.headers() });
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    proposal = proposals[0];
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load proposal: ' + e.message });
  }

  if (proposal.status === 'draft') return res.status(400).json({ error: 'Proposal has not been sent yet' });
  if (!proposal.proposal_url) return res.status(400).json({ error: 'Proposal has no URL' });

  // Check if followups already exist
  try {
    var existResp = await fetch(sb.url() + '/rest/v1/proposal_followups?proposal_id=eq.' + proposalId + '&select=id&limit=1', { headers: sb.headers() });
    var existing = await existResp.json();
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Follow-ups already exist for this proposal. Delete existing ones first.' });
    }
  } catch (e) { /* proceed */ }

  var firstName = contact.first_name || 'there';
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var proposalUrl = proposal.proposal_url;
  var city = contact.city || '';
  var stateProvince = contact.state_province || '';
  var location = [city, stateProvince].filter(Boolean).join(', ');

  // Load practice_type for results personalization
  var practiceType = 'group'; // default
  try {
    var pdResp = await fetch(sb.url() + '/rest/v1/practice_details?contact_id=eq.' + contact.id + '&select=practice_type&limit=1', { headers: sb.headers() });
    var pdRows = await pdResp.json();
    if (pdRows && pdRows.length > 0 && pdRows[0].practice_type) {
      practiceType = pdRows[0].practice_type;
    }
  } catch (e) { /* default to group */ }

  // Build the 4-email sequence
  var sequence = [
    {
      sequence_number: 1,
      day_offset: 3,
      subject: 'Quick follow-up on your growth proposal',
      body_html: buildEmail1(firstName, practiceName, proposalUrl)
    },
    {
      sequence_number: 2,
      day_offset: 7,
      subject: 'A quick tip for ' + practiceName,
      body_html: buildEmail2(firstName, practiceName, proposalUrl, location)
    },
    {
      sequence_number: 3,
      day_offset: 14,
      subject: 'How practices like yours are growing online',
      body_html: buildEmail3(firstName, practiceName, proposalUrl, practiceType)
    },
    {
      sequence_number: 4,
      day_offset: 21,
      subject: 'Still thinking it over?',
      body_html: buildEmail4(firstName, practiceName, proposalUrl)
    }
  ];

  // Insert all 4 as drafts
  var rows = sequence.map(function(s) {
    return {
      proposal_id: proposalId,
      sequence_number: s.sequence_number,
      day_offset: s.day_offset,
      status: 'draft',
      subject: s.subject,
      body_html: s.body_html
    };
  });

  try {
    var insertResp = await fetch(sb.url() + '/rest/v1/proposal_followups', {
      method: 'POST',
      headers: sb.headers('return=representation'),
      body: JSON.stringify(rows)
    });
    var inserted = await insertResp.json();

    return res.status(200).json({
      ok: true,
      followups: inserted,
      message: 'Generated ' + inserted.length + ' follow-up emails. Preview and approve to schedule.'
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save followups: ' + e.message });
  }
};


// ---- Email templates (using shared branded wrapper) ----

var FOOTER_NOTE = 'Questions? Reply to this email or <a href="' + email.CALENDAR_URL + '" style="font-family:Inter,sans-serif;color:#00D47E;text-decoration:none;font-weight:500;">book a call with Scott</a>.';

function followupWrap(content) {
  return email.wrap({
    headerLabel: 'Growth Proposal',
    footerNote: FOOTER_NOTE,
    content: content
  });
}

// Email 1: Day 3 - Check-in
function buildEmail1(firstName, practiceName, proposalUrl) {
  return followupWrap(
    email.greeting(firstName) +
    email.p('I wanted to follow up and make sure you had a chance to look over the growth proposal we put together for ' + email.esc(practiceName) + '. We spent time analyzing your current digital presence, and I think you will find some of the insights valuable regardless of what you decide.') +
    email.p('If you have not had a chance to open it yet, here is the link again:') +
    email.cta(proposalUrl, 'View Your Proposal') +
    email.p('If anything in the proposal raised questions or if you would like to talk through any of the recommendations, I am happy to hop on a quick call.') +
    email.bookingButton() +
    email.p('No rush at all. Just wanted to make sure it did not get buried in your inbox.')
  );
}

// Email 2: Day 7 - Value-add tip
function buildEmail2(firstName, practiceName, proposalUrl, location) {
  var locationNote = location ? ' in ' + email.esc(location) : '';
  return followupWrap(
    email.greeting(firstName) +
    email.p('I was thinking about ' + email.esc(practiceName) + ' and wanted to share something that has been making a real difference for practices' + locationNote + '.') +
    email.p('One of the biggest shifts we are seeing right now is how AI platforms like ChatGPT and Google AI Overviews are changing the way potential clients find therapists. People are increasingly asking AI for recommendations instead of scrolling through search results, and most practices are not set up to appear in those responses.') +
    email.p('Your proposal includes a breakdown of where ' + email.esc(practiceName) + ' stands in both traditional search and AI visibility. Even if you are not ready to move forward with us, understanding this shift can help you make better decisions about your marketing.') +
    email.cta(proposalUrl, 'Review Your Visibility Analysis') +
    email.p('Happy to answer any questions if something in the analysis catches your eye.') +
    email.bookingButton()
  );
}

// Email 3: Day 14 - Social proof (practice-type aware)
function buildEmail3(firstName, practiceName, proposalUrl, practiceType) {
  var isSolo = practiceType === 'solo';
  var topStat = isSolo
    ? 'our top solo therapist saw a 308% increase in organic visibility in just 3 months'
    : 'our top group practice saw a 213% increase in organic visibility in just 6 months';
  var typeLabel = isSolo ? 'solo therapists' : 'group practices';

  return followupWrap(
    email.greeting(firstName) +
    email.p('I wanted to share a quick note about something we are seeing with practices similar to ' + email.esc(practiceName) + '.') +
    email.p('The practices that tend to see the fastest growth are the ones that invest in building a strong, verified digital foundation early. Things like consistent business listings, a well-structured website, and a presence across the platforms where potential clients are searching (including AI platforms) all compound over time.') +
    email.p('To put some numbers behind it: ' + topStat + '. Across all 22 of our clients, the average increase in Google Search Console visibility is 115%.') +
    email.p('Rather than take our word for it, here are real Google Search Console results from ' + typeLabel + ' and more:') +
    email.cta('https://clients.moonraker.ai/results', 'See Client Results') +
    email.p('Every result on that page is verified data pulled directly from Google Search Console. No vanity metrics, just real growth numbers.') +
    email.cta(proposalUrl, 'Revisit Your Proposal') +
    email.p('If you would like to hear more about what has worked for similar practices, Scott would be happy to walk you through a few examples.') +
    email.bookingButton()
  );
}

// Email 4: Day 21 - Graceful close
function buildEmail4(firstName, practiceName, proposalUrl) {
  return followupWrap(
    email.greeting(firstName) +
    email.p('I wanted to reach out one last time about the growth proposal we put together for ' + email.esc(practiceName) + '.') +
    email.p('I completely understand that priorities shift, and the timing might not be right. That is perfectly okay. If your focus has moved elsewhere, just know that your proposal will stay available whenever you are ready to revisit it.') +
    email.cta(proposalUrl, 'Your Proposal') +
    email.p('If anything has changed and you would like to pick the conversation back up, we are here. And if you have decided to go a different direction, I would genuinely appreciate hearing what factored into that decision. It helps us get better.') +
    email.p('Either way, I wish you and ' + email.esc(practiceName) + ' all the best.') +
    '<p style="font-family:Inter,sans-serif;font-size:15px;color:#333F70;line-height:1.7;margin:0;">Warmly,<br>The Moonraker Team</p>'
  );
}
