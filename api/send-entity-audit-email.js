// /api/send-entity-audit-email.js
// Sends the entity audit scorecard email to the lead/prospect via Resend.
// From: audits@clients.moonraker.ai
// Reply-To: scott@moonraker.ai
// CC: chris@moonraker.ai, scott@moonraker.ai
//
// POST { audit_id, subject?, body_html?, preview_only? }
//   - If subject/body_html omitted, generates a default email
//   - If preview_only=true, returns the email without sending
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  var body = req.body || {};
  var auditId = body.audit_id;
  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  // Load audit + contact
  var audit, contact;
  try {
    var aResp = await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId + '&select=*', { headers: sbHeaders() });
    var audits = await aResp.json();
    if (!audits || audits.length === 0) return res.status(404).json({ error: 'Audit not found' });
    audit = audits[0];

    var cResp = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + audit.contact_id + '&select=*', { headers: sbHeaders() });
    var contacts = await cResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found' });
    contact = contacts[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load audit: ' + e.message });
  }

  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

  var firstName = contact.first_name || 'there';
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var slug = contact.slug;
  var scorecardUrl = 'https://clients.moonraker.ai/' + slug + '/entity-audit';
  var scores = audit.scores || {};

  // Build default email if not provided
  var subject = body.subject || 'Your CORE Entity Audit Results Are Ready';
  var bodyHtml = body.body_html || buildDefaultEmail(firstName, practiceName, scorecardUrl, scores);

  // Preview mode
  if (body.preview_only) {
    return res.status(200).json({
      ok: true,
      preview: true,
      to: contact.email,
      from: 'audits@clients.moonraker.ai',
      reply_to: 'scott@moonraker.ai',
      cc: 'chris@moonraker.ai, scott@moonraker.ai',
      subject: subject,
      body_html: bodyHtml
    });
  }

  // Send via Resend
  try {
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Moonraker AI <audits@clients.moonraker.ai>',
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: subject,
        html: bodyHtml
      })
    });
    var emailData = await emailResp.json();

    if (emailData.id) {
      // Update audit record: flip to delivered + save email metadata
      await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId, {
        method: 'PATCH', headers: sbHeaders(),
        body: JSON.stringify({
          status: 'delivered',
          sent_at: new Date().toISOString(),
          sent_to: contact.email,
          email_subject: subject,
          email_body: bodyHtml
        })
      });

      return res.status(200).json({ ok: true, email_id: emailData.id });
    } else {
      return res.status(500).json({ error: 'Resend error', details: emailData });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Email send failed: ' + e.message });
  }
};

function buildDefaultEmail(firstName, practiceName, scorecardUrl, scores) {
  var cred = scores.credibility || 0;
  var opt = scores.optimization || 0;
  var rep = scores.reputation || 0;
  var eng = scores.engagement || 0;
  var avg = ((cred + opt + rep + eng) / 4).toFixed(1);

  function scoreColor(v) {
    if (v <= 3) return '#EF4444';
    if (v <= 6) return '#F59E0B';
    return '#00D47E';
  }

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7fdfb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:2rem 1.5rem;">

<div style="text-align:center;margin-bottom:2rem;">
  <img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" alt="Moonraker" style="height:40px;">
</div>

<div style="background:#ffffff;border-radius:12px;padding:2rem;border:1px solid #e2e8f0;">
  <h1 style="font-family:'Outfit',sans-serif;font-size:1.5rem;color:#1E2A5E;margin:0 0 1rem;">Hi ${firstName},</h1>

  <p style="color:#333F70;font-size:.95rem;line-height:1.7;margin:0 0 1rem;">
    Your CORE Entity Audit for <strong>${practiceName}</strong> is ready. We analyzed how AI platforms and search engines currently understand and represent your practice online.
  </p>

  <div style="background:#f7fdfb;border:1px solid #e2e8f0;border-radius:10px;padding:1.25rem;margin:1.25rem 0;text-align:center;">
    <div style="font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6B7599;margin-bottom:.75rem;">Your CORE Scores</div>
    <div style="display:inline-flex;gap:.5rem;">
      <div style="display:inline-block;padding:.35rem .75rem;border-radius:8px;font-weight:700;font-size:1rem;background:${scoreColor(cred)}22;color:${scoreColor(cred)};">C: ${cred}</div>
      <div style="display:inline-block;padding:.35rem .75rem;border-radius:8px;font-weight:700;font-size:1rem;background:${scoreColor(opt)}22;color:${scoreColor(opt)};">O: ${opt}</div>
      <div style="display:inline-block;padding:.35rem .75rem;border-radius:8px;font-weight:700;font-size:1rem;background:${scoreColor(rep)}22;color:${scoreColor(rep)};">R: ${rep}</div>
      <div style="display:inline-block;padding:.35rem .75rem;border-radius:8px;font-weight:700;font-size:1rem;background:${scoreColor(eng)}22;color:${scoreColor(eng)};">E: ${eng}</div>
    </div>
    <div style="font-size:.82rem;color:#6B7599;margin-top:.5rem;">Average: ${avg}/10</div>
  </div>

  <p style="color:#333F70;font-size:.95rem;line-height:1.7;margin:0 0 1.25rem;">
    Your scorecard includes a breakdown of findings across all four pillars, along with the first fix in each area you can implement right away.
  </p>

  <div style="text-align:center;margin:1.5rem 0;">
    <a href="${scorecardUrl}" style="display:inline-block;padding:.75rem 2rem;background:#00D47E;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:.95rem;">View Your Full Scorecard</a>
  </div>

  <p style="color:#333F70;font-size:.95rem;line-height:1.7;margin:0 0 .5rem;">
    If you have any questions about the results, or want to discuss what a full CORE Marketing System campaign would look like for your practice, we would love to chat.
  </p>

  <div style="text-align:center;margin:1.25rem 0;">
    <a href="https://msg.moonraker.ai/widget/bookings/moonraker-free-strategy-call" style="display:inline-block;padding:.6rem 1.5rem;border:1px solid #00D47E;color:#00D47E;text-decoration:none;border-radius:8px;font-weight:600;font-size:.9rem;">Book a Free Strategy Call</a>
  </div>
</div>

<div style="text-align:center;margin-top:2rem;padding-top:1.5rem;border-top:1px solid #e2e8f0;">
  <p style="font-size:.78rem;color:#6B7599;margin:0;">Moonraker AI &middot; Digital Marketing for Therapy Practices</p>
  <p style="font-size:.72rem;color:#6B7599;margin:.25rem 0 0;">
    <a href="https://moonraker.ai" style="color:#00D47E;text-decoration:none;">moonraker.ai</a>
  </p>
</div>

</div>
</body>
</html>`;
}
