// api/admin/requeue-audit.js
// Manually requeue a terminally-failed entity audit.
//
// Only valid for rows currently in status=agent_error (retriable or not).
// Flips the row back to status=queued with agent_error_retriable=true so both
// the hourly auto-heal cron (check-surge-blocks) and the 30-min queue runner
// (process-audit-queue) will pick it up.
//
// Deliberate: does NOT clear last_agent_error / last_agent_error_at /
// last_agent_error_code / last_debug_path. We preserve the prior failure
// evidence so a subsequent failure can be compared against it and so the
// admin UI can still render the debug path while the row is queued.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var auditId = body.audit_id;

  if (!auditId || typeof auditId !== 'string' || !UUID_RE.test(auditId)) {
    return res.status(400).json({ error: 'audit_id (UUID) required' });
  }

  try {
    var current = await sb.one(
      'entity_audits?id=eq.' + auditId +
      '&select=id,status,agent_error_retriable,last_agent_error_code&limit=1'
    );

    if (!current) {
      return res.status(404).json({ error: 'Audit not found' });
    }

    if (current.status !== 'agent_error') {
      return res.status(409).json({
        error: 'Audit is not in agent_error state (current: ' + current.status + ')'
      });
    }

    var priorErrorCode = current.last_agent_error_code || null;

    var updated = await sb.mutate(
      'entity_audits?id=eq.' + auditId,
      'PATCH',
      {
        status: 'queued',
        agent_error_retriable: true,
        agent_task_id: null
      },
      'return=representation'
    );

    // Best-effort audit trail. monitor.warn writes to error_log with
    // severity=warning and also console.errors so the action is traceable
    // in both Vercel logs and the persistent error_log table.
    try {
      await monitor.warn('admin/requeue-audit', 'Audit requeued for retry', {
        detail: {
          audit_id: auditId,
          prior_error_code: priorErrorCode,
          requeued_by: user.email || user.id
        }
      });
    } catch (e) {
      // Swallow: audit-trail logging must never break the primary action
    }

    return res.status(200).json({
      ok: true,
      audit_id: auditId,
      prior_error_code: priorErrorCode,
      updated: Array.isArray(updated) ? (updated[0] || null) : updated
    });
  } catch (err) {
    monitor.logError('admin/requeue-audit', err, {
      detail: { audit_id: auditId, stage: 'handler' }
    });
    return res.status(500).json({ error: 'Requeue failed' });
  }
};
