/**
 * /api/trigger-cms-scout.js
 * 
 * Triggers a CMS scout on the Moonraker Agent Service.
 * Dispatches to the correct agent endpoint based on website_platform.
 * 
 * POST body: { contact_id }
 * 
 * Supports: wordpress, squarespace, wix
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');
var crypt = require('./_lib/crypto');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
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
    var contact = await sb.one('contacts?id=eq.' + body.contact_id + '&select=id,slug,website_url,website_platform,practice_name');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.website_url) return res.status(400).json({ error: 'Website URL is required' });

    // Fetch encrypted CMS credentials from workspace_credentials.
    // Per security audit C8: CMS creds were migrated from contacts (plaintext)
    // to workspace_credentials (encrypted via _lib/crypto SENSITIVE_FIELDS).
    // Row may not exist if admin hasn't entered creds — scout falls back to public-only.
    var wsRow = await sb.one('workspace_credentials?contact_id=eq.' + contact.id
      + '&select=id,cms_login_url,cms_username,cms_password,cms_app_password&limit=1');
    var creds = {
      cms_login_url:    (wsRow && wsRow.cms_login_url) || '',
      cms_username:     wsRow && wsRow.cms_username     ? crypt.decrypt(wsRow.cms_username)     : '',
      cms_password:     wsRow && wsRow.cms_password     ? crypt.decrypt(wsRow.cms_password)     : '',
      cms_app_password: wsRow && wsRow.cms_app_password ? crypt.decrypt(wsRow.cms_app_password) : ''
    };
    // workspace_credentials.id keys the agent's persistent Chromium profile
    // dir at /data/profiles/<credential_id>. One row per site+platform pair,
    // so multi-site clients (e.g. Kelly Chisholm's two WP sites) naturally
    // get two profiles. Null when admin hasn't entered creds yet.
    var credentialId = wsRow && wsRow.id ? wsRow.id : null;

    var platform = (contact.website_platform || '').toLowerCase();
    var agentEndpoint = '';
    var payload = {};

    // ── Build platform-specific payload ──────────────────────────
    if (platform === 'wordpress') {
      agentEndpoint = '/tasks/wp-scout';
      var adminUrl = creds.cms_login_url || (contact.website_url.replace(/\/$/, '') + '/wp-admin');
      payload = {
        wp_admin_url: adminUrl,
        wp_username: creds.cms_username || '',
        wp_password: creds.cms_app_password || creds.cms_password || '',
        client_slug: contact.slug,
        callback_url: CLIENT_HQ_URL + '/api/ingest-cms-scout'
      };
      // WP scout can run public-only if no credentials, but REST API needs app password
      if (!payload.wp_username || !payload.wp_password) {
        // Still allow it - the scout will try public endpoints
        payload.wp_username = payload.wp_username || 'agent';
        payload.wp_password = payload.wp_password || 'none';
      }
      // Opt into Patchright + persistent Chromium profile when we have a
      // credentials row. Agent accepts or ignores; unknown IDs create empty
      // profile dirs that simply cache this run's session.
      if (credentialId) payload.credential_id = credentialId;

    } else if (platform === 'squarespace') {
      agentEndpoint = '/tasks/sq-scout';
      payload = {
        website_url: contact.website_url,
        client_slug: contact.slug,
        callback_url: CLIENT_HQ_URL + '/api/ingest-cms-scout'
      };
      // Add SQ credentials if available
      if (creds.cms_username && creds.cms_password) {
        payload.sq_email = creds.cms_username;
        payload.sq_password = creds.cms_password;
      }
      // Opt into Patchright + persistent Chromium profile. SQSP's contributor
      // model lets one Moonraker-admin login access many client sites; a
      // shared credential row across clients is fine — the profile dir just
      // caches that shared session.
      if (credentialId) payload.credential_id = credentialId;

    } else if (platform === 'wix') {
      agentEndpoint = '/tasks/wix-scout';
      payload = {
        website_url: contact.website_url,
        client_slug: contact.slug,
        callback_url: CLIENT_HQ_URL + '/api/ingest-cms-scout'
      };

    } else {
      return res.status(400).json({
        error: 'Unsupported platform: ' + (platform || 'none') + '. Set website_platform to wordpress, squarespace, or wix.'
      });
    }

    // ── Trigger agent ────────────────────────────────────────────
    var agentResp = await fetch(AGENT_URL + agentEndpoint, {
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
      return res.status(502).json({ error: 'Agent returned ' + agentResp.status, detail: errText.substring(0, 300) });
    }

    var agentResult = await agentResp.json();

    // ── Create scout record ──────────────────────────────────────
    await sb.mutate('cms_scouts', 'POST', {
      contact_id: contact.id,
      client_slug: contact.slug,
      platform: platform,
      agent_task_id: agentResult.task_id,
      status: 'running'
    });

    return res.json({
      success: true,
      task_id: agentResult.task_id,
      platform: platform,
      message: platform.charAt(0).toUpperCase() + platform.slice(1) + ' scout started'
    });

  } catch (err) {
    console.error('trigger-cms-scout error:', err);
    monitor.logError('trigger-cms-scout', err, {
      detail: { stage: 'trigger_handler' }
    });
    return res.status(500).json({ error: 'Failed to trigger CMS scout' });
  }
};
