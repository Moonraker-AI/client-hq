// api/admin/deploy-to-r2.js
// Deploys a page to Cloudflare R2 via the client-sites-worker.
// Used by Pagemaster to push generated HTML to moonraker-hosted client sites.

var sb = require('../_lib/supabase');
var { requireAdmin } = require('../_lib/auth');
var crypto = require('crypto');

var WORKER_URL = 'https://client-sites-worker.chris-b0d.workers.dev';
var DEPLOY_SECRET = process.env.CF_R2_DEPLOY_SECRET;

// Loud module-load warning so config issues surface in Vercel logs before the first deploy attempt.
// Mirrors the C5 pattern used in api/_lib/crypto.js.
if (!DEPLOY_SECRET) {
  console.error('[deploy-to-r2] CRITICAL: CF_R2_DEPLOY_SECRET is not set. R2 deploys will return 500 until the env var is configured.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var admin = await requireAdmin(req, res);
  if (!admin) return;

  if (!DEPLOY_SECRET) {
    return res.status(500).json({ error: 'Deploy secret not configured' });
  }

  try {
    var { site_id, page_path, html, content_page_id, deployed_by } = req.body;

    if (!site_id || !page_path || !html) {
      return res.status(400).json({ error: 'site_id, page_path, and html are required' });
    }

    // Look up site config
    var site = await sb.one('client_sites?id=eq.' + site_id + '&select=*');
    if (!site) return res.status(404).json({ error: 'Site not found' });

    if (site.hosting_type !== 'moonraker') {
      return res.status(400).json({ error: 'Site hosting_type is "' + site.hosting_type + '", not moonraker. Only moonraker-hosted sites can deploy to R2.' });
    }

    if (site.status !== 'active') {
      return res.status(400).json({ error: 'Site status is "' + site.status + '". Must be active to deploy.' });
    }

    // Normalize path
    var normalizedPath = page_path.replace(/^\/+/, '');
    if (!normalizedPath.includes('.')) {
      normalizedPath = normalizedPath.replace(/\/+$/, '') + '/index.html';
    }
    if (!normalizedPath) normalizedPath = 'index.html';

    // Deploy to R2 via Worker
    var r2Key = site.domain + '/' + normalizedPath;
    var contentHash = crypto.createHash('sha256').update(html).digest('hex').substring(0, 16);

    var workerResp = await fetch(WORKER_URL + '/_deploy', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DEPLOY_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        domain: site.domain,
        path: normalizedPath,
        content: html,
        content_type: 'text/html; charset=utf-8'
      })
    });

    var workerResult = await workerResp.json();

    if (!workerResp.ok || !workerResult.success) {
      return res.status(502).json({ error: 'R2 deploy failed', detail: workerResult });
    }

    // Upsert deployment record
    // Delete existing record for this path then insert (PostgREST upsert with composite unique)
    await sb.mutate(
      'site_deployments?site_id=eq.' + site_id + '&page_path=eq.' + encodeURIComponent(normalizedPath),
      'DELETE',
      null,
      'return=minimal'
    );

    var deployment = await sb.mutate('site_deployments', 'POST', {
      site_id: site_id,
      page_path: normalizedPath,
      content_page_id: content_page_id || null,
      r2_key: r2Key,
      content_hash: contentHash,
      deployed_by: deployed_by || 'pagemaster',
      deployed_at: new Date().toISOString()
    }, 'return=representation');

    return res.status(200).json({
      success: true,
      r2_key: r2Key,
      content_hash: contentHash,
      deployment: Array.isArray(deployment) ? deployment[0] : deployment,
      live_url: 'https://' + site.domain + '/' + normalizedPath.replace(/\/index\.html$/, '')
    });

  } catch (err) {
    console.error('[deploy-to-r2] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
