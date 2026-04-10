// /api/cron/process-followups.js
// Runs daily via Vercel Cron. Finds pending follow-ups where scheduled_for <= now,
// checks if the prospect has signed up or been marked lost, then sends or cancels.
// Processes up to 10 followups per run to stay within function timeout.

var email = require('../_lib/email-template');
var sb = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var auth = req.headers['authorization'];
    var querySecret = req.query && req.query.secret;
    if (auth !== 'Bearer ' + cronSecret && querySecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var resendKey = process.env.RESEND_API_KEY;

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  function sbHeaders(prefer) {
    var h = { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
    if (prefer) h['Prefer'] = prefer;
    return h;
  }

  var now = new Date().toISOString();
  var results = { proposal: { sent: 0, cancelled: 0, failed: 0 }, audit: { sent: 0, cancelled: 0, failed: 0 } };

  try {
    // ── PART 1: Process proposal follow-ups ──
    var qResp = await fetch(
      sb.url() + '/rest/v1/proposal_followups?status=eq.pending&scheduled_for=lte.' + now
        + '&order=scheduled_for.asc&limit=10'
        + '&select=*,proposals(id,sent_at,status,contacts(id,email,first_name,last_name,practice_name,status,lost))',
      { headers: sbHeaders() }
    );
    var followups = await qResp.json();

    for (var i = 0; i < (followups || []).length; i++) {
      var fu = followups[i];
      var proposal = fu.proposals;
      var contact = proposal ? proposal.contacts : null;

      if (!contact || !contact.email) {
        await patchRecord(sbUrl, sbHeaders, 'proposal_followups', fu.id, {
          status: 'failed', error_message: 'No contact email found', updated_at: now
        });
        results.proposal.failed++;
        continue;
      }

      var cancelStatuses = ['onboarding', 'active'];
      if (cancelStatuses.indexOf(contact.status) !== -1 || contact.lost) {
        var reason = contact.lost ? 'lost' : 'signed_up';
        await fetch(
          sb.url() + '/rest/v1/proposal_followups?proposal_id=eq.' + proposal.id + '&status=eq.pending',
          {
            method: 'PATCH', headers: sbHeaders('return=representation'),
            body: JSON.stringify({ status: 'cancelled', cancelled_at: now, cancel_reason: reason, updated_at: now })
          }
        );
        results.proposal.cancelled++;
        continue;
      }

      var sent = await sendFollowupEmail(resendKey, contact, fu, email.FROM.proposals);
      if (sent) {
        await patchRecord(sbUrl, sbHeaders, 'proposal_followups', fu.id, { status: 'sent', sent_at: now, updated_at: now });
        results.proposal.sent++;
      } else {
        await patchRecord(sbUrl, sbHeaders, 'proposal_followups', fu.id, { status: 'failed', error_message: 'Send failed', updated_at: now });
        results.proposal.failed++;
      }
    }

    // ── PART 2: Process audit follow-ups ──
    var aqResp = await fetch(
      sb.url() + '/rest/v1/audit_followups?status=eq.pending&scheduled_for=lte.' + now
        + '&order=scheduled_for.asc&limit=10'
        + '&select=*,contacts(id,email,first_name,last_name,practice_name,status,lost)',
      { headers: sbHeaders() }
    );
    var auditFollowups = await aqResp.json();

    for (var j = 0; j < (auditFollowups || []).length; j++) {
      var afu = auditFollowups[j];
      var ac = afu.contacts;

      if (!ac || !ac.email) {
        await patchRecord(sbUrl, sbHeaders, 'audit_followups', afu.id, {
          status: 'failed', error_message: 'No contact email found', updated_at: now
        });
        results.audit.failed++;
        continue;
      }

      // Audit followups cancel when lead becomes prospect (or beyond) or lost
      var auditCancelStatuses = ['prospect', 'onboarding', 'active'];
      if (auditCancelStatuses.indexOf(ac.status) !== -1 || ac.lost) {
        var aReason = ac.lost ? 'lost' : 'converted_to_prospect';
        await fetch(
          sb.url() + '/rest/v1/audit_followups?audit_id=eq.' + afu.audit_id + '&status=eq.pending',
          {
            method: 'PATCH', headers: sbHeaders('return=representation'),
            body: JSON.stringify({ status: 'cancelled', cancelled_at: now, cancel_reason: aReason, updated_at: now })
          }
        );
        results.audit.cancelled++;
        continue;
      }

      var aSent = await sendFollowupEmail(resendKey, ac, afu, email.FROM.audits);
      if (aSent) {
        await patchRecord(sbUrl, sbHeaders, 'audit_followups', afu.id, { status: 'sent', sent_at: now, updated_at: now });
        results.audit.sent++;
      } else {
        await patchRecord(sbUrl, sbHeaders, 'audit_followups', afu.id, { status: 'failed', error_message: 'Send failed', updated_at: now });
        results.audit.failed++;
      }
    }

    return res.status(200).json({ ok: true, results: results });
  } catch (e) {
    return res.status(500).json({ error: 'Cron failed: ' + e.message, results: results });
  }
};

async function sendFollowupEmail(resendKey, contact, followup, fromAddress) {
  try {
    var emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddress,
        to: [contact.email],
        cc: ['chris@moonraker.ai', 'scott@moonraker.ai'],
        reply_to: 'scott@moonraker.ai',
        subject: followup.subject,
        html: followup.body_html
      })
    });
    var emailData = await emailResp.json();
    return !!emailData.id;
  } catch (e) {
    return false;
  }
}

async function patchRecord(sbUrl, sbHeaders, table, id, data) {
  await fetch(sb.url() + '/rest/v1/' + table + '?id=eq.' + id, {
    method: 'PATCH',
    headers: sbHeaders('return=representation'),
    body: JSON.stringify(data)
  });
}
