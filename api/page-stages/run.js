// /api/page-stages/run.js
// Single-run detail endpoint. The list endpoint trims html_before/html_after
// out of its payload to keep the card list cheap; the expanded stage panel
// fetches one run at a time via this endpoint when the operator opens a tab
// that needs the full HTML.
//
// GET  /api/page-stages/run?id=<run_id>
//   → { id, content_page_id, stage, run_status, html_before, html_after,
//        diff_summary, findings, findings_summary, operator_notes, operator_id,
//        error_message, error_detail, created_at, started_at, completed_at,
//        accepted_at, rejected_at, input_tokens, output_tokens, duration_ms,
//        claude_request_id, model }
//
// Auth: admin JWT or CRON_SECRET (parity with rest of /api/page-stages/*).

var auth = require('../_lib/auth');
var sb   = require('../_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var runId = (req.query && req.query.id) || '';
  if (!runId) return res.status(400).json({ error: 'id required' });
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return res.status(400).json({ error: 'invalid id' });

  try {
    var run = await sb.one(
      'page_stage_runs?id=eq.' + runId +
      '&select=*&limit=1'
    );
    if (!run) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ run: run });
  } catch (e) {
    console.error('[page-stages/run]', e.message);
    return res.status(500).json({ error: 'Fetch failed', detail: e.message });
  }
};
