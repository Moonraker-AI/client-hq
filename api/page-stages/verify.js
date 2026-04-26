// /api/page-stages/verify.js — automated audit re-run after the clarify
// stage, used as a gate before promoting a page to ready_for_contract
// (homepage) or ready_for_client (subsequent pages).
//
// Unlike the other stage routes, accepting a 'verify' run advances status
// to ready_for_contract / ready_for_client (route-specific transition),
// not to a 'verified' status (no such status exists in the enum).
//
// A run is auto-acceptable if findings_summary shows zero P0/P1 findings.
// Otherwise the admin must explicitly accept (overriding the gate) or rerun
// the offending upstream stage with operator_notes.

var auth      = require('../_lib/auth');
var sb        = require('../_lib/supabase');
var monitor   = require('../_lib/monitor');
var pageStage = require('../_lib/page-stage');

module.exports = async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (req.method === 'POST') return runHandler(req, res);
  if (req.method === 'PATCH') return acceptHandler(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};

async function runHandler(req, res) {
  var body = req.body || {};
  var contentPageId = body.content_page_id;
  if (!contentPageId) return res.status(400).json({ error: 'content_page_id required' });

  try {
    var run = await pageStage.runStage('verify', {
      contentPageId: contentPageId,
      operatorNotes: body.operator_notes,
      operatorId: req.user && req.user.sub,
      previewUrl: body.preview_url,
      baseUrl: getBaseUrl(req),
      cronSecret: process.env.CRON_SECRET,
      viewportWidth: body.viewport_width,
      viewportHeight: body.viewport_height,
      timeoutMs: body.timeout_ms
    });

    // Compute gate verdict: pass if zero P0+P1, fail otherwise.
    var counts = (run.findings_summary && run.findings_summary.counts) || {};
    var blocking = (counts.P0 || 0) + (counts.P1 || 0);
    var gateStatus = blocking === 0 ? 'pass' : 'fail';

    return res.status(200).json({
      success: true,
      run: run,
      gate: { status: gateStatus, blocking_findings: blocking }
    });
  } catch (e) {
    if (e.code === 'STATUS_MISMATCH') {
      return res.status(409).json({ error: e.message });
    }
    console.error('[page-stages/verify]', e.message);
    return res.status(500).json({ error: 'Verify run failed', detail: e.message });
  }
}

async function acceptHandler(req, res) {
  var runId = (req.query && req.query.run_id) || (req.body && req.body.run_id);
  var action = (req.query && req.query.action) || (req.body && req.body.action) || 'accept';
  var override = (req.body && req.body.override) === true;
  if (!runId) return res.status(400).json({ error: 'run_id required' });
  if (action !== 'accept') return res.status(400).json({ error: 'unsupported action' });

  try {
    var run = await sb.one('page_stage_runs?id=eq.' + runId + '&select=*&limit=1');
    if (!run) return res.status(404).json({ error: 'run not found' });
    if (run.stage !== 'verify') return res.status(400).json({ error: 'not a verify run' });
    if (run.run_status !== 'complete') {
      return res.status(409).json({ error: 'verify run not complete: ' + run.run_status });
    }

    // Gate enforcement: block accept if blocking findings exist and operator
    // didn't explicitly override. The override flag exists for cases where
    // the admin reviewed each finding and decided to ship anyway.
    var counts = (run.findings_summary && run.findings_summary.counts) || {};
    var blocking = (counts.P0 || 0) + (counts.P1 || 0);
    if (blocking > 0 && !override) {
      return res.status(409).json({
        error: 'Verify gate failed: ' + blocking + ' blocking findings. Re-run prior stages or pass override=true.',
        blocking_findings: blocking
      });
    }

    var nowIso = new Date().toISOString();

    // Reject any other unaccepted verify runs for this page.
    await sb.mutate(
      'page_stage_runs?content_page_id=eq.' + run.content_page_id +
      '&stage=eq.verify&id=neq.' + runId +
      '&accepted_at=is.null&rejected_at=is.null',
      'PATCH',
      { rejected_at: nowIso, run_status: 'rejected' },
      'return=minimal'
    ).catch(function(){});

    await sb.mutate(
      'page_stage_runs?id=eq.' + runId,
      'PATCH',
      { accepted_at: nowIso },
      'return=minimal'
    );

    // Determine next status for the content_page:
    // homepage → ready_for_contract  (contract extractor will run next)
    // subsequent → ready_for_client  (queued for admin to release to client)
    var page = await sb.one('content_pages?id=eq.' + run.content_page_id + '&select=page_type&limit=1');
    var nextStatus = page && page.page_type === 'homepage' ? 'ready_for_contract' : 'ready_for_client';

    await sb.mutate(
      'content_pages?id=eq.' + run.content_page_id,
      'PATCH',
      { status: nextStatus, updated_at: nowIso },
      'return=minimal'
    );

    return res.status(200).json({
      success: true,
      run_id: runId,
      content_page_id: run.content_page_id,
      next_status: nextStatus,
      override_used: blocking > 0
    });
  } catch (e) {
    monitor.logError('page-stages/verify accept', e);
    return res.status(500).json({ error: 'Accept failed', detail: e.message });
  }
}

function getBaseUrl(req) {
  var host = req.headers && req.headers.host;
  if (!host) return 'https://clients.moonraker.ai';
  return 'https://' + host;
}
