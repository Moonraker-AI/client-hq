// /api/cron/trigger-quarterly-audits.js
// Runs daily. Finds active clients where next_audit_due <= today,
// creates entity_audit rows, triggers the agent, bumps next_audit_due by 3 months,
// and sends a single consolidated team notification.
//
// Vercel cron: daily at 7:00 AM ET (11:00 UTC)

var sb = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  var resendKey = process.env.RESEND_API_KEY;

  try {
    // Find active clients with audits due today or earlier
    var today = new Date().toISOString().split('T')[0];
    var dueClients = await sb.query(
      'contacts?status=eq.active&next_audit_due=lte.' + today +
      '&select=id,slug,first_name,last_name,practice_name,website_url,email,city,state_province,next_audit_due' +
      '&order=next_audit_due.asc&limit=20'
    );

    if (!dueClients || dueClients.length === 0) {
      return res.status(200).json({ message: 'No quarterly audits due today.', triggered: 0 });
    }

    var results = [];

    for (var i = 0; i < dueClients.length; i++) {
      var contact = dueClients[i];
      var result = { slug: contact.slug, name: contact.practice_name || (contact.first_name + ' ' + contact.last_name) };

      try {
        // Determine audit_period label based on previous audits
        var prevAudits = await sb.query(
          'entity_audits?contact_id=eq.' + contact.id +
          '&select=id,audit_period,audit_date,cres_score&order=audit_date.desc&limit=1'
        );
        var prevAudit = prevAudits && prevAudits.length > 0 ? prevAudits[0] : null;

        // Calculate period label: months since first audit
        var allAudits = await sb.query(
          'entity_audits?contact_id=eq.' + contact.id +
          '&select=audit_date&order=audit_date.asc&limit=1'
        );
        var firstAuditDate = allAudits && allAudits.length > 0 ? new Date(allAudits[0].audit_date) : new Date();
        var monthsSinceFirst = Math.round((new Date() - firstAuditDate) / (1000 * 60 * 60 * 24 * 30.44));
        var nearestQuarter = Math.max(3, Math.round(monthsSinceFirst / 3) * 3);
        var auditPeriod = 'month_' + nearestQuarter;

        var brandQuery = contact.practice_name || (contact.first_name + ' ' + contact.last_name);
        var geoTarget = '';
        if (contact.city || contact.state_province) {
          geoTarget = (contact.city || '') + (contact.city && contact.state_province ? ', ' : '') + (contact.state_province || '');
        }

        // Create entity_audits row
        var auditRows = await sb.mutate('entity_audits', 'POST', {
          contact_id: contact.id,
          client_slug: contact.slug,
          audit_tier: 'none',
          brand_query: brandQuery,
          homepage_url: contact.website_url,
          status: 'pending',
          audit_period: auditPeriod,
          audit_scope: 'homepage',
          geo_target: geoTarget || null
        });

        var audit = auditRows[0];
        result.audit_id = audit.id;
        result.period = auditPeriod;

        // Trigger agent
        if (AGENT_URL && AGENT_KEY) {
          var agentResp = await fetch(AGENT_URL + '/tasks/surge-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AGENT_KEY },
            body: JSON.stringify({
              audit_id: audit.id,
              practice_name: brandQuery,
              website_url: contact.website_url,
              city: contact.city || '',
              state: contact.state_province || '',
              geo_target: geoTarget,
              client_slug: contact.slug
            })
          });

          if (agentResp.ok) {
            var agentResult = await agentResp.json();
            await sb.mutate('entity_audits?id=eq.' + audit.id, 'PATCH', {
              status: 'agent_running',
              agent_task_id: agentResult.task_id
            }, 'return=minimal');
            result.agent_triggered = true;
          } else {
            result.agent_triggered = false;
            result.agent_error = 'Status ' + agentResp.status;
          }
        } else {
          result.agent_triggered = false;
          result.agent_error = 'Agent not configured';
        }

        // Bump next_audit_due by 3 months
        var nextDue = new Date(contact.next_audit_due);
        nextDue.setMonth(nextDue.getMonth() + 3);
        await sb.mutate('contacts?id=eq.' + contact.id, 'PATCH', {
          next_audit_due: nextDue.toISOString().split('T')[0]
        }, 'return=minimal');
        result.next_due = nextDue.toISOString().split('T')[0];
        result.success = true;

      } catch (clientErr) {
        result.success = false;
        result.error = clientErr.message;
      }

      results.push(result);

      // Rate limit between agent triggers
      if (i < dueClients.length - 1) {
        await new Promise(function(r) { setTimeout(r, 1000); });
      }
    }

    // Send consolidated team notification
    var successCount = results.filter(function(r) { return r.success; }).length;
    var failCount = results.length - successCount;

    if (resendKey && results.length > 0) {
      var tableRows = results.map(function(r) {
        var statusBadge = r.success
          ? '<span style="color:#00D47E;">Triggered</span>'
          : '<span style="color:#EF4444;">Failed: ' + (r.error || r.agent_error || 'Unknown') + '</span>';
        return '<tr><td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + r.name + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + (r.period || '-') + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + statusBadge + '</td>' +
          '<td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;">' + (r.next_due || '-') + '</td></tr>';
      }).join('');

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
          to: ['notifications@clients.moonraker.ai'],
          subject: 'Quarterly Audits Triggered: ' + successCount + ' clients',
          html: '<div style="font-family:Inter,sans-serif;max-width:600px;">' +
            '<h2 style="font-family:Outfit,sans-serif;color:#1E2A5E;">Quarterly Entity Audits</h2>' +
            '<p>' + successCount + ' audit' + (successCount !== 1 ? 's' : '') + ' triggered' +
            (failCount > 0 ? ', ' + failCount + ' failed' : '') + '.</p>' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">' +
            '<thead><tr style="background:#F7FDFB;">' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Client</th>' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Period</th>' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Status</th>' +
            '<th style="padding:8px 12px;text-align:left;font-weight:600;">Next Due</th></tr></thead>' +
            '<tbody>' + tableRows + '</tbody></table>' +
            '<p style="margin-top:16px;"><a href="https://clients.moonraker.ai/admin/audits" style="color:#00D47E;">View in Admin</a></p>' +
            '</div>'
        })
      });
    }

    return res.status(200).json({
      message: successCount + ' quarterly audit(s) triggered, ' + failCount + ' failed.',
      triggered: successCount,
      failed: failCount,
      results: results
    });

  } catch (err) {
    console.error('trigger-quarterly-audits error:', err);
    return res.status(500).json({ error: err.message });
  }
};
