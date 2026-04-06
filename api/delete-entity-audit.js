// /api/delete-entity-audit.js
// Deletes an entity audit record from Supabase and removes the deployed
// scorecard and checkout pages from GitHub.
//
// POST { audit_id, slug }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var ghToken = process.env.GITHUB_PAT;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  var body = req.body || {};
  var auditId = body.audit_id;
  var slug = body.slug;

  if (!auditId || !slug) {
    return res.status(400).json({ error: 'audit_id and slug required' });
  }

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var results = { supabase: false, pages: [] };

  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  try {
    // Step 1: Delete entity audit record from Supabase
    var delResp = await fetch(
      sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId,
      {
        method: 'DELETE',
        headers: {
          'apikey': sbKey,
          'Authorization': 'Bearer ' + sbKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        }
      }
    );
    results.supabase = delResp.ok;

    // Step 2: Delete deployed pages from GitHub
    var pagePaths = [
      slug + '/entity-audit/index.html',
      slug + '/entity-audit-checkout/index.html'
    ];

    for (var i = 0; i < pagePaths.length; i++) {
      var path = pagePaths[i];
      try {
        // Get file SHA first
        var fileResp = await fetch(
          'https://api.github.com/repos/' + REPO + '/contents/' + path + '?ref=' + BRANCH,
          { headers: ghHeaders() }
        );

        if (fileResp.status === 404) {
          results.pages.push({ path: path, status: 'not_found' });
          continue;
        }

        var fileData = await fileResp.json();
        var sha = fileData.sha;

        if (!sha) {
          results.pages.push({ path: path, status: 'no_sha' });
          continue;
        }

        // Delete the file
        var deleteResp = await fetch(
          'https://api.github.com/repos/' + REPO + '/contents/' + path,
          {
            method: 'DELETE',
            headers: ghHeaders(),
            body: JSON.stringify({
              message: 'Delete entity audit page for ' + slug,
              sha: sha,
              branch: BRANCH
            })
          }
        );

        results.pages.push({
          path: path,
          status: deleteResp.ok ? 'deleted' : 'failed',
          code: deleteResp.status
        });

        // Small delay between GitHub operations
        await new Promise(function(resolve) { setTimeout(resolve, 600); });

      } catch (ghErr) {
        results.pages.push({ path: path, status: 'error', detail: ghErr.message });
      }
    }

    return res.status(200).json({ success: true, results: results });

  } catch (err) {
    return res.status(500).json({ error: 'Delete failed', detail: err.message, results: results });
  }
};
