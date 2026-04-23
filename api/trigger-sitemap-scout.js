/**
 * /api/trigger-sitemap-scout.js
 *
 * Triggers the sitemap scout on the Moonraker Agent Service.
 * Tier 1 task — HTTP-only discovery + categorization, no browser, runs
 * immediately alongside other tasks.
 *
 * POST body: { contact_id }
 * Auth: admin JWT or CRON_SECRET (for stripe-webhook auto-trigger on
 *       prospect -> onboarding flip).
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  var CLIENT_HQ_URL = process.env.CLIENT_HQ_URL || 'https://clients.moonraker.ai';

  if (!AGENT_URL || !AGENT_KEY) return res.status(500).json({ error: 'Agent service not configured' });

  var body = req.body;
  if (!body || !body.contact_id) {
    return res.status(400).json({ error: 'contact_id required' });
  }

  try {
    // Fetch contact
    var contact = await sb.one('contacts?id=eq.' + encodeURIComponent(body.contact_id) + '&select=id,slug,website_url,practice_name');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.website_url) return res.status(400).json({ error: 'Website URL is required' });

    // Normalize: strip trailing slash, ensure scheme
    var rootUrl = contact.website_url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(rootUrl)) rootUrl = 'https://' + rootUrl;

    var payload = {
      root_url: rootUrl,
      client_slug: contact.slug,
      callback_url: CLIENT_HQ_URL + '/api/ingest-sitemap-scout'
    };

    // ── Trigger agent ────────────────────────────────────────────
    var agentResp = await fetch(AGENT_URL + '/tasks/sitemap-scout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}
      monitor.logError('trigger-sitemap-scout', new Error('Agent returned ' + agentResp.status), {
        client_slug: contact.slug,
        detail: { stage: 'agent_post', status: agentResp.status, body: errText.substring(0, 300) }
      });
      return res.status(502).json({ error: 'Agent returned ' + agentResp.status, detail: errText.substring(0, 300) });
    }

    var agentResult = await agentResp.json();

    // ── Create scout record ──────────────────────────────────────
    await sb.mutate('sitemap_scouts', 'POST', {
      contact_id: contact.id,
      client_slug: contact.slug,
      root_url: rootUrl,
      agent_task_id: agentResult.task_id,
      status: 'running',
      started_at: new Date().toISOString()
    });

    return res.json({
      success: true,
      task_id: agentResult.task_id,
      message: 'Sitemap scout started'
    });

  } catch (err) {
    console.error('trigger-sitemap-scout error:', err);
    monitor.logError('trigger-sitemap-scout', err, {
      client_slug: (req.body && req.body.contact_id) || null,
      detail: { stage: 'trigger_handler' }
    });
    return res.status(500).json({ error: 'Failed to trigger sitemap scout' });
  }
};
