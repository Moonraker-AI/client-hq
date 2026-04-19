// /api/deploy-endorsement-page.js
// Deploys the endorsement collection page for a client.
//
// Phase 4 Session 7: now mints an endorsement-scoped page_token for the
// client and substitutes it into the template's {{PAGE_TOKEN}} placeholder
// before pushing. The deployed HTML carries the token in a <script> constant
// which the page's JS reads when POSTing to /api/submit-endorsement.
//
// The token binds the page to a specific contact_id for 180 days (per-scope
// default in _lib/page-token.js). After expiry, redeploy to re-mint.

var gh        = require('./_lib/github');
var auth      = require('./_lib/auth');
var sb        = require('./_lib/supabase');
var monitor   = require('./_lib/monitor');
var pageToken = require('./_lib/page-token');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!gh.isConfigured())        return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sb.isConfigured())        return res.status(500).json({ error: 'Supabase not configured' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'PAGE_TOKEN_SECRET not configured' });

  var slug = req.body && req.body.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  try {
    // 1. Resolve contact by slug — the token binds to contact_id, not slug,
    //    so even if a client slug ever changes the token keeps working.
    var contactRows = await sb.query(
      'contacts?slug=eq.' + encodeURIComponent(slug) +
      '&select=id,slug&limit=1'
    );
    if (!contactRows || contactRows.length === 0) {
      return res.status(404).json({ error: 'Contact not found for slug ' + slug });
    }
    var contact = contactRows[0];

    // Post-C6: endorsement pages no longer carry baked-in tokens. The deployed
    // template calls /api/page-token/request on load to mint a cookie. Deploy
    // the template byte-for-byte.
    var html = await gh.readTemplate('endorsements.html');
    var destPath = slug + '/endorsements/index.html';
    await gh.pushFile(destPath, html, 'Deploy endorsement page for ' + slug);

    return res.status(200).json({
      success: true,
      url:  'https://clients.moonraker.ai/' + slug + '/endorsements/',
      path: destPath,
      contact_id: contact.id
    });
  } catch (err) {
    monitor.logError('deploy-endorsement-page', err, {
      client_slug: slug,
      detail: { stage: 'deploy_endorsement' }
    });
    return res.status(500).json({ error: 'Failed to deploy endorsement page' });
  }
};
