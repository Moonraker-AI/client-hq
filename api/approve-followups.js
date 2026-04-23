// /api/approve-followups.js
// Approves a proposal's follow-up sequence and schedules send dates.
// Calculates scheduled_for based on proposal.sent_at + day_offset.
//
// POST { proposal_id }
// Moves all 'draft' followups to 'pending' with scheduled dates.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  try {
    // Load proposal to get sent_at
    var proposal = await sb.one('proposals?id=eq.' + proposalId + '&select=id,sent_at,status&limit=1');
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!proposal.sent_at) return res.status(400).json({ error: 'Proposal has not been sent yet. Cannot schedule follow-ups.' });

    var sentAt = new Date(proposal.sent_at);

    // Load draft followups
    var followups = await sb.query('proposal_followups?proposal_id=eq.' + proposalId + '&status=eq.draft&order=sequence_number.asc');
    if (!followups || followups.length === 0) {
      return res.status(400).json({ error: 'No draft follow-ups found. Generate them first.' });
    }

    // Schedule each one: sent_at + day_offset days, at 10:00 AM ET
    var updated = 0;
    for (var i = 0; i < followups.length; i++) {
      var fu = followups[i];
      var scheduledDate = new Date(sentAt);
      scheduledDate.setDate(scheduledDate.getDate() + fu.day_offset);
      // Set to 10:00 AM Eastern (UTC-4 or UTC-5 depending on DST)
      // Use 14:00 UTC as a safe approximation (10 AM ET during EDT)
      scheduledDate.setUTCHours(14, 0, 0, 0);

      // If the scheduled date is in the past, skip to avoid sending immediately
      var now = new Date();
      if (scheduledDate <= now) {
        // Push to tomorrow at 10 AM ET
        scheduledDate = new Date(now);
        scheduledDate.setDate(scheduledDate.getDate() + 1);
        scheduledDate.setUTCHours(14, 0, 0, 0);
      }

      await sb.mutate('proposal_followups?id=eq.' + fu.id, 'PATCH', {
        status: 'pending',
        scheduled_for: scheduledDate.toISOString(),
        updated_at: new Date().toISOString()
      });
      updated++;
    }

    return res.status(200).json({
      ok: true,
      scheduled: updated,
      message: 'Approved and scheduled ' + updated + ' follow-up emails.'
    });
  } catch (e) {
    monitor.logError('approve-followups', e, { detail: { stage: 'approve_handler', proposal_id: proposalId } });
    return res.status(500).json({ error: 'Failed to approve followups' });
  }
};
