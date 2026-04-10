// /api/send-followup-email.js
// Sends a single follow-up email for a proposal.
// Called by the cron job or manually.
// Checks contact status before sending - auto-cancels if prospect signed up.
//
// POST { followup_id, preview_only? }
//
// From: proposals@clients.moonraker.ai
// Reply-To: scott@moonraker.ai
// CC: chris@moonraker.ai, scott@moonraker.ai

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var resendKey = process.env.RESEND_API_KEY;
  var body = req.body || {};
  if (!resendKey && !body.preview_only) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var followupId = body.followup_id;
  if (!followupId) return res.status(400).json({ error: 'followup_id required' });

  // Load followup + proposal + contact
  var followup, proposal, contact;
  try {
    followup = await sb.one('proposal_followups?id=eq.' + followupId + '&select=*,proposals(*,contacts(*))&limit=1');
    if (!followup) return res.status(404).json({ error: 'Follow-up not found' });
    proposal = followup.proposals;
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load follow-up: ' + e.message });
  }

  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

  // Check if prospect has signed up (status moved past prospect)
  var cancelStatuses = ['onboarding', 'active'];
  if (cancelStatuses.indexOf(contact.status) !== -1 || contact.lost) {
    var reason = contact.lost ? 'lost' : 'signed_up';
    await cancelAllPending(proposal.id, reason);
    return res.status(200).json({
      ok: true, cancelled: true, reason: reason,
      message: 'Follow-up cancelled: prospect ' + (contact.lost ? 'marked as lost' : 'has signed up')
    });
  }

  // Preview mode
  if (body.preview_only) {
    return res.status(200).json({
      ok: true, preview: true,
      followup_id: followup.id, sequence_number: followup.sequence_number,
      day_offset: followup.day_offset, scheduled_for: followup.scheduled_for,
      to: contact.email, from: email.FROM.proposals,
      reply_to: 'scott@moonraker.ai', cc: 'chris@moonraker.ai, scott@moonraker.ai',
      subject: followup.subject, body_html: followup.body_html
    });
  }

  if (followup.status !== 'pending') {
    return res.status(400).json({ error: 'Follow-up status is "' + followup.status + '", expected "pending"' });
  }

  // Send via Resend
  try {
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: email.FROM.proposals,
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: followup.subject,
        html: followup.body_html
      })
    });
    var emailData = await emailResp.json();

    if (emailData.id) {
      await sb.mutate('proposal_followups?id=eq.' + followupId, 'PATCH', {
        status: 'sent', sent_at: new Date().toISOString()
      });
      return res.status(200).json({ ok: true, email_id: emailData.id, sequence_number: followup.sequence_number });
    } else {
      await sb.mutate('proposal_followups?id=eq.' + followupId, 'PATCH', {
        status: 'failed', error_message: JSON.stringify(emailData).substring(0, 500)
      });
      return res.status(500).json({ error: 'Resend error', details: emailData });
    }
  } catch (e) {
    await sb.mutate('proposal_followups?id=eq.' + followupId, 'PATCH', {
      status: 'failed', error_message: e.message
    });
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
};

async function cancelAllPending(proposalId, reason) {
  try {
    await sb.mutate('proposal_followups?proposal_id=eq.' + proposalId + '&status=eq.pending', 'PATCH', {
      status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason
    });
  } catch (e) {
    console.error('Failed to cancel followups:', e.message);
  }
}
