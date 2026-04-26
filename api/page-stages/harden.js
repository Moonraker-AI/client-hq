// /api/page-stages/harden.js — harden stage entry point.
// POST                              — run the harden stage on a content_page.
// PATCH ?run_id=...&action=accept   — accept a completed run.
//
// Auth: admin JWT (admin UI) or CRON_SECRET (chain orchestrator / internal).
// See api/_lib/page-stage.js for the underlying logic.

var auth      = require('../_lib/auth');
var pageStage = require('../_lib/page-stage');

module.exports = async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (req.method === 'POST') {
    return runHandler(req, res);
  }
  if (req.method === 'PATCH') {
    return acceptHandler(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed' });
};

async function runHandler(req, res) {
  var body = req.body || {};
  var contentPageId = body.content_page_id;
  if (!contentPageId) return res.status(400).json({ error: 'content_page_id required' });

  try {
    var run = await pageStage.runStage('harden', {
      contentPageId: contentPageId,
      operatorNotes: body.operator_notes,
      operatorId: req.user && req.user.sub,
      previewUrl: body.preview_url,            // optional: detector target URL
      baseUrl: getBaseUrl(req),
      cronSecret: process.env.CRON_SECRET,
      viewportWidth: body.viewport_width,
      viewportHeight: body.viewport_height,
      timeoutMs: body.timeout_ms
    });
    return res.status(200).json({ success: true, run: run });
  } catch (e) {
    if (e.code === 'STATUS_MISMATCH') {
      return res.status(409).json({ error: e.message });
    }
    console.error('[page-stages/harden]', e.message);
    return res.status(500).json({ error: 'Stage run failed', detail: e.message });
  }
}

async function acceptHandler(req, res) {
  var runId = (req.query && req.query.run_id) || (req.body && req.body.run_id);
  var action = (req.query && req.query.action) || (req.body && req.body.action) || 'accept';
  if (!runId) return res.status(400).json({ error: 'run_id required' });
  if (action !== 'accept') return res.status(400).json({ error: 'unsupported action' });

  try {
    var accepted = await pageStage.acceptRun(runId);
    return res.status(200).json({ success: true, run: accepted });
  } catch (e) {
    console.error('[page-stages/harden accept]', e.message);
    return res.status(500).json({ error: 'Accept failed', detail: e.message });
  }
}

function getBaseUrl(req) {
  var host = req.headers && req.headers.host;
  if (!host) return 'https://clients.moonraker.ai';
  return 'https://' + host;
}
