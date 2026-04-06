// /api/approve-audit-followups.js
// Approves draft audit follow-up emails by scheduling them relative to now.
// Sets status to 'pending' and calculates scheduled_for from day_offset.
//
// POST { audit_id }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var auditId = (req.body || {}).audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  try {
    // Load draft followups
    var resp = await fetch(
      sbUrl + '/rest/v1/audit_followups?audit_id=eq.' + auditId + '&status=eq.draft&order=sequence_number.asc',
      { headers: sbHeaders() }
    );
    var drafts = await resp.json();

    if (!drafts || drafts.length === 0) {
      return res.status(400).json({ error: 'No draft follow-ups to approve' });
    }

    // Schedule each email: now + day_offset days, at 10:00 AM ET (14:00 UTC)
    var now = new Date();
    var scheduled = 0;

    for (var i = 0; i < drafts.length; i++) {
      var fu = drafts[i];
      var sendDate = new Date(now);
      sendDate.setDate(sendDate.getDate() + fu.day_offset);
      sendDate.setUTCHours(14, 0, 0, 0); // 10am ET

      await fetch(sbUrl + '/rest/v1/audit_followups?id=eq.' + fu.id, {
        method: 'PATCH',
        headers: sbHeaders('return=minimal'),
        body: JSON.stringify({
          status: 'pending',
          scheduled_for: sendDate.toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      scheduled++;
    }

    return res.status(200).json({ ok: true, scheduled: scheduled });
  } catch (err) {
    console.error('approve-audit-followups error:', err);
    return res.status(500).json({ error: err.message });
  }
};
