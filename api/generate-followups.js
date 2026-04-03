// /api/generate-followups.js
// Generates a 4-email follow-up sequence for a sent proposal.
// Uses smart templates personalized with proposal + contact data.
//
// POST { proposal_id }
// Returns the draft sequence for preview before approval.
//
// Sequence:
//   1. Day 3  - Check-in: did you get a chance to review?
//   2. Day 7  - Value-add: concrete tip relevant to their practice
//   3. Day 14 - Social proof: results from similar practices
//   4. Day 21 - Graceful close: have your priorities shifted?

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  // Load proposal + contact
  var proposal, contact;
  try {
    var pResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1', { headers: sbHeaders() });
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
    var existResp = await fetch(sbUrl + '/rest/v1/proposal_followups?proposal_id=eq.' + proposalId + '&select=id&limit=1', { headers: sbHeaders() });
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
      body_html: buildEmail3(firstName, practiceName, proposalUrl)
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
    var insertResp = await fetch(sbUrl + '/rest/v1/proposal_followups', {
      method: 'POST',
      headers: sbHeaders('return=representation'),
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


// ---- Email templates ----

function emailWrap(content) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f7fdfb;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">'
    + '<div style="max-width:600px;margin:0 auto;padding:2rem 1.5rem;">'
    + '<div style="text-align:center;margin-bottom:2rem;">'
    + '<img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" alt="Moonraker" style="height:40px;">'
    + '</div>'
    + '<div style="background:#ffffff;border-radius:12px;padding:2rem;border:1px solid #e2e8f0;">'
    + content
    + '</div>'
    + '<div style="text-align:center;padding:1.5rem 0;color:#6B7599;font-size:.8rem;">'
    + '<p style="margin:0;">Moonraker AI &middot; moonraker.ai</p>'
    + '</div></div></body></html>';
}

function ctaButton(url, text) {
  return '<div style="text-align:center;margin:2rem 0;">'
    + '<a href="' + url + '" style="display:inline-block;background:#00D47E;color:#ffffff;padding:.75rem 2rem;border-radius:8px;font-weight:600;font-size:1rem;text-decoration:none;">' + text + '</a>'
    + '</div>';
}

function bookingLink() {
  return '<div style="text-align:center;margin:1.5rem 0;">'
    + '<a href="https://msg.moonraker.ai/widget/bookings/scott-pope-calendar" style="display:inline-block;border:1px solid #00D47E;color:#00D47E;padding:.5rem 1.5rem;border-radius:8px;font-weight:500;font-size:.9rem;text-decoration:none;">Book a Call with Scott</a>'
    + '</div>';
}

function p(text) {
  return '<p style="color:#333F70;line-height:1.7;margin-bottom:1rem;">' + text + '</p>';
}

function greeting(name) {
  return '<h1 style="font-family:\'Outfit\',sans-serif;font-size:1.5rem;color:#1E2A5E;margin:0 0 1rem;">Hi ' + name + ',</h1>';
}

// Email 1: Day 3 - Check-in
function buildEmail1(firstName, practiceName, proposalUrl) {
  return emailWrap(
    greeting(firstName)
    + p('I wanted to follow up and make sure you had a chance to look over the growth proposal we put together for ' + practiceName + '. We spent time analyzing your current digital presence, and I think you will find some of the insights valuable regardless of what you decide.')
    + p('If you have not had a chance to open it yet, here is the link again:')
    + ctaButton(proposalUrl, 'View Your Proposal')
    + p('If anything in the proposal raised questions or if you would like to talk through any of the recommendations, I am happy to hop on a quick call.')
    + bookingLink()
    + p('No rush at all. Just wanted to make sure it did not get buried in your inbox.')
  );
}

// Email 2: Day 7 - Value-add tip
function buildEmail2(firstName, practiceName, proposalUrl, location) {
  var locationNote = location ? ' in ' + location : '';
  return emailWrap(
    greeting(firstName)
    + p('I was thinking about ' + practiceName + ' and wanted to share something that has been making a real difference for practices' + locationNote + '.')
    + p('One of the biggest shifts we are seeing right now is how AI platforms like ChatGPT and Google AI Overviews are changing the way potential clients find therapists. People are increasingly asking AI for recommendations instead of scrolling through search results, and most practices are not set up to appear in those responses.')
    + p('Your proposal includes a breakdown of where ' + practiceName + ' stands in both traditional search and AI visibility. Even if you are not ready to move forward with us, understanding this shift can help you make better decisions about your marketing.')
    + ctaButton(proposalUrl, 'Review Your Visibility Analysis')
    + p('Happy to answer any questions if something in the analysis catches your eye.')
    + bookingLink()
  );
}

// Email 3: Day 14 - Social proof
function buildEmail3(firstName, practiceName, proposalUrl) {
  return emailWrap(
    greeting(firstName)
    + p('I wanted to share a quick note about something we are seeing with practices similar to ' + practiceName + '.')
    + p('The practices that tend to see the fastest growth are the ones that invest in building a strong, verified digital foundation early. Things like consistent business listings, a well-structured website, and a presence across the platforms where potential clients are searching (including AI platforms) all compound over time.')
    + p('Many of the practices we work with started in a similar position to where ' + practiceName + ' is today, and the results have been really encouraging. We would love to share some specific examples if you are curious.')
    + ctaButton(proposalUrl, 'Revisit Your Proposal')
    + p('If you would like to hear more about what has worked for similar practices, Scott would be happy to walk you through a few examples.')
    + bookingLink()
  );
}

// Email 4: Day 21 - Graceful close
function buildEmail4(firstName, practiceName, proposalUrl) {
  return emailWrap(
    greeting(firstName)
    + p('I wanted to reach out one last time about the growth proposal we put together for ' + practiceName + '.')
    + p('I completely understand that priorities shift, and the timing might not be right. That is perfectly okay. If your focus has moved elsewhere, just know that your proposal will stay available whenever you are ready to revisit it.')
    + ctaButton(proposalUrl, 'Your Proposal')
    + p('If anything has changed and you would like to pick the conversation back up, we are here. And if you have decided to go a different direction, I would genuinely appreciate hearing what factored into that decision. It helps us get better.')
    + '<p style="color:#333F70;line-height:1.7;margin-bottom:1rem;">Either way, I wish you and ' + practiceName + ' all the best.</p>'
    + '<p style="color:#333F70;line-height:1.7;margin-bottom:0;">Warmly,<br>The Moonraker Team</p>'
  );
}
