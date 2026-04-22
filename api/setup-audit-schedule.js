// /api/setup-audit-schedule.js
// Called when a client transitions to active (or manually from admin).
// Handles the "adopt or pull fresh" baseline logic and sets next_audit_due.
// When adopting a lead audit, also deploys the campaign audit suite
// (diagnosis, action-plan, progress) that leads don't get.
//
// POST { contact_id }
//
// Logic:
// 1. Check for existing "initial" audit within the last 30 days
// 2. If found: promote audit_period to "baseline", deploy campaign suite, set next_audit_due
// 3. If not found: create new baseline entity_audit row, trigger agent, set next_audit_due
//
// Idempotent: skips if next_audit_due is already set.

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var contactId = (req.body || {}).contact_id;
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  try {
    var contact = await sb.one('contacts?id=eq.' + contactId + '&select=*&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Idempotent guard: skip if already scheduled
    if (contact.next_audit_due) {
      return res.status(200).json({
        message: 'Audit schedule already set.',
        next_audit_due: contact.next_audit_due,
        action: 'skipped'
      });
    }

    var threeMothsOut = new Date();
    threeMothsOut.setMonth(threeMothsOut.getMonth() + 3);
    var nextDue = threeMothsOut.toISOString().split('T')[0];

    // Check for recent initial audit (within 30 days)
    var thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    var cutoff = thirtyDaysAgo.toISOString().split('T')[0];

    var recentAudits = await sb.query(
      'entity_audits?contact_id=eq.' + contactId +
      '&audit_period=eq.initial&audit_date=gte.' + cutoff +
      '&status=in.(complete,delivered)' +
      '&select=id,audit_date,cres_score,status' +
      '&order=audit_date.desc&limit=1'
    );

    var action;
    var auditId;

    if (recentAudits && recentAudits.length > 0) {
      // Adopt: promote initial audit to baseline
      var adopted = recentAudits[0];
      await sb.mutate('entity_audits?id=eq.' + adopted.id, 'PATCH', {
        audit_period: 'baseline'
      }, 'return=minimal');

      auditId = adopted.id;
      action = 'adopted';

      // 2026-04-23: per-client audit-suite deploys removed. The
      // /audits/{diagnosis,action-plan,progress} pages are served
      // directly from /_templates/<page>.html via Vercel rewrites.
      // Templates hydrate per-client data at request time via
      // /api/public-contact (and /api/progress-update + the
      // cookie-based page-token flow for progress writes). No
      // per-client static copies are pushed; eliminates the
      // file-system shadow that masked future template edits.

      // Create checklist_items from the audit's tasks JSONB
      // (Leads don't get checklist items; they're created here when the lead converts)
      try {
        var fullAudit = await sb.one('entity_audits?id=eq.' + adopted.id + '&select=tasks,audit_period&limit=1');
        var tasks = (fullAudit && fullAudit.tasks) || [];
        if (tasks.length > 0) {
          // Clear any existing (shouldn't be any for leads, but safe)
          await sb.mutate('checklist_items?audit_id=eq.' + adopted.id, 'DELETE', null, 'return=minimal');

          function sevToPri(sev) { return sev === 'critical' ? 'P1' : sev === 'warning' ? 'P2' : 'P3'; }
          function pillarToCat(p) {
            if (p === 'credibility') return 'Credibility + Entity Identity';
            if (p === 'optimization') return 'Optimization + Content';
            if (p === 'reputation') return 'Reputation + Citations';
            return 'Engagement + UX';
          }
          function pillarToPhase(p, pri) {
            if (pri === 'P1') return 'Entity Identity + Schema';
            if (pri === 'P2') return 'Content Structure';
            return 'Growth + Amplification';
          }

          var rows = tasks.map(function(t, idx) {
            var pri = sevToPri(t.severity);
            return {
              id: adopted.id + '-' + String(idx + 1).padStart(3, '0'),
              client_slug: contact.slug,
              audit_id: adopted.id,
              audit_period: fullAudit.audit_period || 'baseline',
              task_id: String(idx + 1),
              priority: pri,
              category: pillarToCat(t.pillar),
              scope: t.scope || 'on-page',
              title: t.title,
              description: (t.detail || '') + (t.fix ? '\n\n' + t.fix : ''),
              owner: t.owner || 'Moonraker',
              status: t.severity === 'positive' ? 'complete' : 'not_started',
              phase: pillarToPhase(t.pillar, pri),
              web_visible: true,
              sort_order: idx + 1,
              notes: ''
            };
          });

          await sb.mutate('checklist_items', 'POST', rows, 'return=minimal');
        }
      } catch (clErr) {
        console.log('Checklist creation warning:', clErr.message);
      }

    } else {
      // Pull fresh: create new baseline audit and trigger agent
      var brandQuery = contact.practice_name || (contact.first_name + ' ' + contact.last_name);
      var geoTarget = '';
      if (contact.city || contact.state_province) {
        geoTarget = (contact.city || '') + (contact.city && contact.state_province ? ', ' : '') + (contact.state_province || '');
      }

      var auditRows = await sb.mutate('entity_audits', 'POST', {
        contact_id: contactId,
        client_slug: contact.slug,
        audit_tier: 'none',
        brand_query: brandQuery,
        homepage_url: contact.website_url,
        status: 'pending',
        audit_period: 'baseline',
        audit_scope: 'homepage',
        geo_target: geoTarget || null
      });

      var audit = auditRows[0];
      auditId = audit.id;
      action = 'created';

      // Trigger agent
      var AGENT_URL = process.env.AGENT_SERVICE_URL;
      var AGENT_KEY = process.env.AGENT_API_KEY;

      if (AGENT_URL && AGENT_KEY) {
        try {
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
          }
        } catch (agentErr) {
          console.error('Agent trigger failed for baseline audit:', agentErr.message);
        }
      }
    }

    // Set next_audit_due on the contact
    await sb.mutate('contacts?id=eq.' + contactId, 'PATCH', {
      next_audit_due: nextDue
    }, 'return=minimal');

    return res.status(200).json({
      success: true,
      action: action,
      audit_id: auditId,
      next_audit_due: nextDue,
      message: action === 'adopted'
        ? 'Recent initial audit promoted to baseline. Next quarterly audit scheduled for ' + nextDue + '.'
        : 'New baseline audit created and agent triggered. Next quarterly audit scheduled for ' + nextDue + '.'
    });

  } catch (err) {
    console.error('setup-audit-schedule error:', err);
    monitor.logError('setup-audit-schedule', err, {
      detail: { stage: 'setup_handler' }
    });
    return res.status(500).json({ error: 'Failed to set up audit schedule' });
  }
};
