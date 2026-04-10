// /api/delete-client.js
// Fully deletes a client: explicitly deletes all child tables in dependency order,
// then deletes the contact, then removes all GitHub files for the slug.
// All FKs are CASCADE, so the contact delete would cascade anyway, but explicit
// deletion gives us per-table success/failure reporting.

var sb = require('./_lib/supabase');
var gh = require('./_lib/github');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!gh.isConfigured()) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var slug = body.slug;
  var contactId = body.contact_id;

  if (!slug || !contactId) return res.status(400).json({ error: 'slug and contact_id required' });

  var results = { supabase: [], github: [] };

  try {
    // ============================================================
    // STEP 1: Cascade delete Supabase tables
    // ============================================================
    // All child tables in dependency order. Explicit deletion is
    // belt-and-suspenders (CASCADE FKs provide a safety net).
    // Order matters: children before parents, join tables before either side.
    var tables = [
      // Deep children first (FK chains)
      { table: 'content_chat_messages', filter: 'content_page_id=in.(select id from content_pages where contact_id=eq.' + contactId + ')' },
      { table: 'content_page_versions', filter: 'content_page_id=in.(select id from content_pages where contact_id=eq.' + contactId + ')' },
      { table: 'activity_log', filter: 'contact_id=eq.' + contactId },
      { table: 'audit_followups', filter: 'contact_id=eq.' + contactId },
      { table: 'proposal_followups', filter: 'proposal_id=in.(select id from proposals where contact_id=eq.' + contactId + ')' },
      { table: 'checklist_items', filter: 'client_slug=eq.' + slug },
      { table: 'entity_audits', filter: 'contact_id=eq.' + contactId },
      { table: 'proposals', filter: 'contact_id=eq.' + contactId },
      { table: 'endorsements', filter: 'contact_id=eq.' + contactId },
      { table: 'content_pages', filter: 'contact_id=eq.' + contactId },
      { table: 'deliverables', filter: 'contact_id=eq.' + contactId },
      // Direct children of contacts
      { table: 'intro_call_steps', filter: 'contact_id=eq.' + contactId },
      { table: 'onboarding_steps', filter: 'contact_id=eq.' + contactId },
      { table: 'bio_materials', filter: 'contact_id=eq.' + contactId },
      { table: 'social_platforms', filter: 'contact_id=eq.' + contactId },
      { table: 'social_profiles', filter: 'contact_id=eq.' + contactId },
      { table: 'directory_listings', filter: 'contact_id=eq.' + contactId },
      { table: 'signed_agreements', filter: 'contact_id=eq.' + contactId },
      { table: 'practice_details', filter: 'contact_id=eq.' + contactId },
      { table: 'account_access', filter: 'contact_id=eq.' + contactId },
      { table: 'workspace_credentials', filter: 'contact_id=eq.' + contactId },
      { table: 'scheduled_touchpoints', filter: 'contact_id=eq.' + contactId },
      { table: 'payments', filter: 'contact_id=eq.' + contactId },
      { table: 'performance_guarantees', filter: 'contact_id=eq.' + contactId },
      { table: 'design_specs', filter: 'contact_id=eq.' + contactId },
      { table: 'neo_images', filter: 'contact_id=eq.' + contactId },
      { table: 'tracked_keywords', filter: 'contact_id=eq.' + contactId },
      // Slug-keyed reporting tables
      { table: 'report_queue', filter: 'client_slug=eq.' + slug },
      { table: 'report_snapshots', filter: 'client_slug=eq.' + slug },
      { table: 'report_highlights', filter: 'client_slug=eq.' + slug },
      { table: 'report_configs', filter: 'client_slug=eq.' + slug }
    ];

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      try {
        var delResp = await fetch(sb.url() + '/rest/v1/' + t.table + '?' + t.filter, {
          method: 'DELETE', headers: sb.headers('return=minimal')
        });
        results.supabase.push({ table: t.table, ok: delResp.ok });
      } catch (e) {
        results.supabase.push({ table: t.table, ok: false, error: e.message });
      }
    }

    // Delete the contact itself
    try {
      var contactDel = await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contactId, {
        method: 'DELETE', headers: sb.headers('return=minimal')
      });
      results.supabase.push({ table: 'contacts', ok: contactDel.ok });
    } catch (e) {
      results.supabase.push({ table: 'contacts', ok: false, error: e.message });
    }

    // ============================================================
    // STEP 2: Delete all GitHub files under the slug directory
    // ============================================================
    var ghToken = process.env.GITHUB_PAT;
    var REPO = 'Moonraker-AI/client-hq';
    var BRANCH = 'main';
    var ghHeaders = {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    var treeResp = await fetch('https://api.github.com/repos/' + REPO + '/git/trees/' + BRANCH + '?recursive=1', {
      headers: ghHeaders
    });

    if (treeResp.ok) {
      var treeData = await treeResp.json();
      var slugFiles = (treeData.tree || []).filter(function(item) {
        return item.type === 'blob' && item.path.startsWith(slug + '/');
      });

      for (var j = 0; j < slugFiles.length; j++) {
        var filePath = slugFiles[j].path;
        try {
          await gh.deleteFile(filePath, null, 'Delete ' + filePath + ' (client removed)');
          results.github.push({ path: filePath, ok: true });
        } catch (e) {
          results.github.push({ path: filePath, ok: false, error: e.message });
        }
      }

      if (slugFiles.length === 0) {
        results.github.push({ path: slug + '/', ok: true, note: 'No files found' });
      }
    } else {
      results.github.push({ error: 'Failed to read repo tree' });
    }

    return res.status(200).json({
      success: true,
      results: results,
      deleted_supabase_tables: results.supabase.filter(function(r) { return r.ok; }).length,
      deleted_github_files: results.github.filter(function(r) { return r.ok; }).length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, results: results });
  }
};
