// /api/delete-entity-audit.js
// Deletes an entity audit record from Supabase and removes the deployed
// scorecard and checkout pages from GitHub.
//
// POST { audit_id, slug }

var sb = require('./_lib/supabase');
var gh = require('./_lib/github');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!gh.isConfigured()) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  var body = req.body || {};
  var auditId = body.audit_id;
  var slug = body.slug;

  if (!auditId || !slug) return res.status(400).json({ error: 'audit_id and slug required' });

  var results = { supabase: false, pages: [] };

  try {
    // Step 1: Delete entity audit record from Supabase
    await sb.mutate('entity_audits?id=eq.' + auditId, 'DELETE', null, 'return=minimal');
    results.supabase = true;

    // Step 2: Delete deployed pages from GitHub
    var pagePaths = [
      slug + '/entity-audit/index.html',
      slug + '/entity-audit-checkout/index.html'
    ];

    for (var i = 0; i < pagePaths.length; i++) {
      var path = pagePaths[i];
      try {
        var deleted = await gh.deleteFile(path, null, 'Delete entity audit page for ' + slug);
        results.pages.push({ path: path, status: deleted ? 'deleted' : 'not_found' });
        // Small delay between GitHub operations
        if (i < pagePaths.length - 1) {
          await new Promise(function(resolve) { setTimeout(resolve, 600); });
        }
      } catch (ghErr) {
        results.pages.push({ path: path, status: 'error', detail: ghErr.message });
      }
    }

    return res.status(200).json({ success: true, results: results });
  } catch (err) {
    monitor.logError('delete-entity-audit', err, { client_slug: slug, detail: { stage: 'delete_handler', audit_id: auditId } });
    return res.status(500).json({ error: 'Delete failed', results: results });
  }
};
