// /api/deploy-content-preview.js
// Deploys a content preview page for client review.
// Reads _templates/content-preview.html, fills placeholders, pushes to /{slug}/content/{page-slug}/index.html
// Updates content_pages status to client_review.

var sb = require('./_lib/supabase');
var gh = require('./_lib/github');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!gh.isConfigured()) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var contentPageId = body.content_page_id;
  if (!contentPageId) return res.status(400).json({ error: 'content_page_id required' });

  try {
    // 1. Fetch the content page
    var cp = await sb.one('content_pages?id=eq.' + contentPageId + '&limit=1');
    if (!cp) return res.status(404).json({ error: 'Content page not found' });
    if (!cp.generated_html) return res.status(400).json({ error: 'No generated HTML to deploy. Generate the page first.' });

    var clientSlug = cp.client_slug;
    var pageSlug = cp.page_slug;
    var pageName = cp.page_name;

    // 2. Read template and fill placeholders
    var templateHtml = await gh.readTemplate('content-preview.html');
    var html = templateHtml
      .replace(/\{\{CONTENT_PAGE_ID\}\}/g, contentPageId)
      .replace(/\{\{CLIENT_SLUG\}\}/g, clientSlug)
      .replace(/\{\{PAGE_NAME\}\}/g, escHtml(pageName))
      .replace(/\{\{PAGE_SLUG\}\}/g, pageSlug);

    // 3. Push to GitHub
    var destPath = clientSlug + '/content/' + pageSlug + '/index.html';
    await gh.pushFile(destPath, html, 'Deploy content preview: ' + pageName + ' for ' + clientSlug);

    // 4. Update content_pages status and set preview_url on linked deliverable
    var previewUrl = '/' + clientSlug + '/content/' + pageSlug + '/';
    await sb.mutate('content_pages?id=eq.' + contentPageId, 'PATCH', { status: 'client_review' }, 'return=minimal');
    await sb.mutate('deliverables?content_page_id=eq.' + contentPageId, 'PATCH', { preview_url: previewUrl }, 'return=minimal');

    return res.status(200).json({
      success: true,
      preview_url: previewUrl,
      full_url: 'https://clients.moonraker.ai' + previewUrl,
      dest_path: destPath
    });

  } catch (err) {
    console.error('Deploy content preview error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
