// /api/admin/reprocess-entity-audit.js
//
// Recovery path for entity audits where the agent finished (raw Surge data
// captured + saved to entity_audits.surge_raw_data) but the downstream
// /api/process-entity-audit streaming call never landed the scores (e.g.
// client connection dropped, 2-4 min Claude call exceeded Vercel's serverless
// window for the invoking caller, etc.).
//
// Re-runs the post-Surge pipeline WITHOUT re-hitting Surge:
//   1. Reads surge_raw_data from the entity_audits row (must be non-null)
//   2. Calls /api/process-entity-audit server-side with that payload
//   3. Returns final scoring state (synchronous wait on NDJSON stream)
//
// Idempotency:
//   - Refuses if cres_score IS NOT NULL or total_tasks > 0, unless force=true.
//     This protects against double-scoring a completed audit.
//   - Safe to invoke repeatedly on a pending row with populated
//     surge_raw_data; each call re-runs Claude + re-writes scores.
//
// Auth: requireAdmin (JWT only, NOT AGENT_API_KEY -- this is a human-driven
// manual action and should not be reachable from the agent).
//
// POST /api/admin/reprocess-entity-audit
//   body: { audit_id: UUID, force?: boolean }
// Returns:
//   200 { ok: true, audit_id, scores, cres_score, total_tasks, status }
//   400 { error: 'audit_id required' }
//   404 { error: 'Audit not found' }
//   409 { error: 'Audit already scored -- pass force=true to overwrite' }
//   422 { error: 'surge_raw_data is null -- cannot reprocess' }
//   502 { error: 'process-entity-audit stream error', detail }

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var fetchT = require('../_lib/fetch-with-timeout');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Human-only (JWT admin). Do NOT accept AGENT_API_KEY: this is not a path
  // the agent should ever be invoking itself, it is the "something went
  // wrong, please re-score from the captured raw" lever the operator pulls.
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var auditId = body.audit_id;
  var force = body.force === true;

  if (!auditId || typeof auditId !== 'string' || !UUID_RE.test(auditId)) {
    return res.status(400).json({ error: 'audit_id (UUID) required' });
  }

  try {
    var current = await sb.one(
      'entity_audits?id=eq.' + auditId +
      '&select=id,status,cres_score,total_tasks,surge_raw_data&limit=1'
    );
    if (!current) return res.status(404).json({ error: 'Audit not found' });

    var alreadyScored = (current.cres_score !== null && current.cres_score !== undefined)
      || (current.total_tasks !== null && current.total_tasks > 0);

    if (alreadyScored && !force) {
      return res.status(409).json({
        error: 'Audit already scored -- pass force=true to overwrite',
        cres_score: current.cres_score,
        total_tasks: current.total_tasks,
        status: current.status
      });
    }

    if (!current.surge_raw_data) {
      return res.status(422).json({
        error: 'surge_raw_data is null -- cannot reprocess. Audit must be ' +
          're-run via /api/admin/requeue-audit to capture fresh Surge data.'
      });
    }

    var rawLen = current.surge_raw_data.length;

    // Call process-entity-audit with the existing raw payload. The handler
    // itself streams NDJSON; we consume the whole stream (blocking) and
    // surface the final `done` event (or the first `error` event) to the
    // operator. This is intentionally synchronous from the caller's
    // perspective -- the admin UI should show a spinner and not leave until
    // scoring either succeeds or fails loudly.
    //
    // Auth is AGENT_API_KEY because process-entity-audit expects the
    // agent-callback identity via requireAdminOrInternal. We are calling
    // internally on behalf of a human admin, but the downstream handler's
    // shape was designed around the agent's bearer token. The human-admin
    // gate is enforced at the top of THIS file.
    var agentKey = process.env.AGENT_API_KEY;
    if (!agentKey) {
      return res.status(500).json({ error: 'AGENT_API_KEY not configured' });
    }

    var baseUrl = 'https://clients.moonraker.ai';
    var upstream;
    try {
      // 280s ceiling: process-entity-audit's Vercel function config is
      // maxDuration=300, Claude call is ~2-4 min. 280s leaves headroom for
      // the downstream handler to flush its `done` event before our
      // AbortController fires.
      upstream = await fetchT(baseUrl + '/api/process-entity-audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + agentKey
        },
        body: JSON.stringify({ audit_id: auditId })
        // NB: NOT passing surge_data in the body. process-entity-audit
        // has a recovery branch that reads surge_raw_data from the row
        // when the body's surge_data is missing (see that handler's
        // line ~55). Relying on that branch keeps this shim small.
      }, 280000);
    } catch (fetchErr) {
      monitor.logError('admin/reprocess-entity-audit', fetchErr, {
        detail: { audit_id: auditId, stage: 'upstream_fetch', raw_len: rawLen }
      });
      return res.status(502).json({
        error: 'process-entity-audit upstream unreachable',
        detail: (fetchErr.message || '').substring(0, 300)
      });
    }

    if (!upstream.ok) {
      var upstreamBody = '';
      try { upstreamBody = (await upstream.text()).substring(0, 500); } catch (e) { /* noop */ }
      monitor.logError('admin/reprocess-entity-audit', new Error('upstream non-200'), {
        detail: { audit_id: auditId, status: upstream.status, body: upstreamBody }
      });
      return res.status(502).json({
        error: 'process-entity-audit returned HTTP ' + upstream.status,
        detail: upstreamBody
      });
    }

    // Consume the NDJSON stream and find the terminal event. We don't
    // forward intermediate events to our caller: this is an admin tool,
    // the spinner is acceptable, and avoiding the streaming dance
    // dramatically simplifies the client-side handler.
    var bodyText;
    try {
      bodyText = await upstream.text();
    } catch (streamErr) {
      monitor.logError('admin/reprocess-entity-audit', streamErr, {
        detail: { audit_id: auditId, stage: 'read_stream' }
      });
      return res.status(502).json({
        error: 'process-entity-audit stream read failed',
        detail: (streamErr.message || '').substring(0, 300)
      });
    }

    var lines = bodyText.split('\n').filter(function(l) { return l.trim(); });
    var events = [];
    for (var i = 0; i < lines.length; i++) {
      try { events.push(JSON.parse(lines[i])); } catch (e) { /* skip malformed */ }
    }

    var doneEvent = events.filter(function(e) { return e && e.step === 'done'; }).pop();
    var errEvents = events.filter(function(e) { return e && e.step === 'error'; });

    if (doneEvent) {
      // Best-effort audit trail so the operator knows a re-score happened.
      try {
        await monitor.warn('admin/reprocess-entity-audit', 'Audit reprocessed from raw', {
          detail: {
            audit_id: auditId,
            raw_len: rawLen,
            force_used: force,
            reprocessed_by: user.email || user.id,
            cres: (doneEvent.scores || {}).cres || null
          }
        });
      } catch (_e) { /* non-fatal */ }

      return res.status(200).json({
        ok: true,
        audit_id: auditId,
        scores: doneEvent.scores || null,
        task_counts: doneEvent.task_counts || null,
        checklist_items_created: doneEvent.checklist_items_created || 0,
        force_used: force,
        raw_len: rawLen,
        events_seen: events.length
      });
    }

    // No done event: surface the first error we saw (if any) or a
    // generic stream-truncation error.
    var errDetail = errEvents.length
      ? (errEvents[0].message || '').substring(0, 500)
      : 'stream ended without done event (last ' + events.length + ' events)';

    return res.status(502).json({
      error: 'process-entity-audit did not finish',
      detail: errDetail,
      events_seen: events.length
    });
  } catch (err) {
    monitor.logError('admin/reprocess-entity-audit', err, {
      detail: { audit_id: auditId, stage: 'handler' }
    });
    return res.status(500).json({
      error: 'Reprocess failed',
      detail: (err.message || '').substring(0, 300)
    });
  }
};
