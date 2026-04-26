// /api/design-audit.js
// Synchronous design audit proxy. Admin → CHQ → agent.
//
// POST body: {
//   url: string,                       // required, http(s) only
//   viewport_width?: number,           // 320..3840, default 1440
//   viewport_height?: number,          // 320..3840, default 900
//   wait_for_selector?: string,        // optional CSS selector to await before scan
//   timeout_seconds?: number           // 5..60, default 30
// }
//
// Response: agent's design audit result (stateless — nothing is persisted).
//   {
//     status: 'complete',
//     url, scanned_at, viewport, duration_ms,
//     findings: [ { id, severity, category, detail, selector, tagName, rect, isPageLevel } ],
//     summary: { total, by_severity: { absolute, strong, advisory }, by_category: { ... } }
//   }
//
// The agent runs Playwright + the upstream impeccable browser detector against
// any URL, so this works on R2 deploys, WordPress, Squarespace, Wix, or any
// other live page. See agent/tasks/design_audit.py.

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var fetchT = require('./_lib/fetch-with-timeout');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: 'Agent service not configured' });
  }

  var body = req.body || {};
  var url = body.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }

  // Pass-through with light validation. Agent re-validates server-side.
  var payload = { url: url };
  if (body.viewport_width != null) payload.viewport_width = body.viewport_width;
  if (body.viewport_height != null) payload.viewport_height = body.viewport_height;
  if (body.wait_for_selector) payload.wait_for_selector = String(body.wait_for_selector).slice(0, 200);
  if (body.timeout_seconds != null) payload.timeout_seconds = body.timeout_seconds;

  // Allow up to 70s end-to-end: agent's hard cap is 60, plus browser_lock wait
  // and network. Vercel Pro default function maxDuration is 60s — this route
  // needs an entry in vercel.json bumping it to 75s to avoid 504s on slow
  // sites. (Tracked as a follow-up; see docs/impeccable-step-3.md.)
  var clientTimeoutMs = 70000;

  try {
    var agentResp = await fetchT(AGENT_URL + '/tasks/design-audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify(payload)
    }, clientTimeoutMs);

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}
      monitor.logError('design-audit', new Error('Agent ' + agentResp.status), {
        detail: { url: url, status: agentResp.status, body: errText.slice(0, 300) }
      });
      // Map common agent statuses through transparently
      if (agentResp.status === 504) {
        return res.status(504).json({ error: 'Audit timed out', detail: errText.slice(0, 300) });
      }
      return res.status(502).json({
        error: 'Agent returned ' + agentResp.status,
        detail: errText.slice(0, 300)
      });
    }

    var result = await agentResp.json();
    return res.status(200).json(result);

  } catch (err) {
    monitor.logError('design-audit', err, {
      detail: { stage: 'proxy_call', url: url }
    });
    // fetchT throws on its own timeout
    if (err && /timeout/i.test(err.message || '')) {
      return res.status(504).json({ error: 'Audit timed out before agent responded' });
    }
    return res.status(500).json({ error: 'Design audit failed' });
  }
};
