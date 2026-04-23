// /api/admin/probe-drive-folders.js
// TEMPORARY probe — remove after audit.
// Auth: CRON_SECRET Bearer (internal only).
// Read-only. For each contact_id in body, probes Drive API to determine:
//   - Does drive_folder_id exist and match "Creative" subfolder convention?
//   - What's the parent folder (practice name)?
//   - Which top-level branches (Creative / Docs / Optimization / Web Design) exist under parent?
//   - Any children in Creative subbranches?
//
// POST { contact_ids: [uuid, ...] }

var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var google = require('../_lib/google-delegated');

var DRIVE_API = 'https://www.googleapis.com/drive/v3';
var EXPECTED_BRANCHES = ['Creative', 'Docs', 'Optimization', 'Web Design'];
var EXPECTED_CREATIVE_CHILDREN = ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'];
var EXPECTED_DOCS_CHILDREN = ['GBP Posts', 'Press Releases'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var authz = req.headers.authorization || '';
  var token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var ids = (req.body && req.body.contact_ids) || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'contact_ids[] required' });
  }

  var saToken;
  try {
    saToken = await google.getDelegatedAccessToken(
      'support@moonraker.ai',
      'https://www.googleapis.com/auth/drive'
    );
  } catch (e) {
    return res.status(500).json({ error: 'Drive token failed: ' + e.message });
  }
  var headers = { 'Authorization': 'Bearer ' + saToken };

  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var cid = ids[i];
    try {
      var c = await sb.one('contacts?id=eq.' + cid + '&select=slug,practice_name,drive_folder_id,drive_folder_url');
      if (!c) { out.push({ contact_id: cid, error: 'contact not found' }); continue; }

      var entry = {
        contact_id: cid,
        slug: c.slug,
        practice_name: c.practice_name,
        drive_folder_id: c.drive_folder_id,
        stored_folder: null,
        is_creative_convention: null,
        parent_folder: null,
        parent_branches: null,
        missing_branches: null,
        creative_children: null,
        missing_creative_children: null,
        creative_file_count: null
      };

      if (!c.drive_folder_id) {
        entry.stored_folder = { exists: false, reason: 'no drive_folder_id' };
        out.push(entry);
        continue;
      }

      // Probe stored folder
      var probe = await fetch(DRIVE_API + '/files/' + c.drive_folder_id +
        '?fields=id,name,trashed,parents&supportsAllDrives=true', { headers: headers });
      if (!probe.ok) {
        entry.stored_folder = { exists: false, status: probe.status };
        out.push(entry);
        continue;
      }
      var pdata = await probe.json();
      entry.stored_folder = { id: pdata.id, name: pdata.name, trashed: !!pdata.trashed, parents: pdata.parents || [] };
      entry.is_creative_convention = (pdata.name === 'Creative');

      // Walk up to parent (practice name folder)
      var parentId = (pdata.parents && pdata.parents[0]) || null;
      if (!parentId) { out.push(entry); continue; }

      var parent = await fetch(DRIVE_API + '/files/' + parentId +
        '?fields=id,name,trashed,parents&supportsAllDrives=true', { headers: headers });
      if (parent.ok) {
        var parentData = await parent.json();
        entry.parent_folder = { id: parentData.id, name: parentData.name, trashed: !!parentData.trashed };

        // List branches under parent
        var branchList = await listChildren(parentId, headers);
        var branchNames = branchList.map(function (f) { return f.name; });
        entry.parent_branches = branchNames;
        entry.missing_branches = EXPECTED_BRANCHES.filter(function (b) { return branchNames.indexOf(b) === -1; });
      }

      // List Creative subfolder children
      var creativeChildren = await listChildren(c.drive_folder_id, headers);
      var creativeChildNames = creativeChildren.map(function (f) { return f.name; });
      entry.creative_children = creativeChildNames;
      entry.missing_creative_children = EXPECTED_CREATIVE_CHILDREN.filter(function (cc) { return creativeChildNames.indexOf(cc) === -1; });

      // Count actual files (not folders) recursively under Creative (one level deep)
      var fileCount = 0;
      for (var k = 0; k < creativeChildren.length; k++) {
        var child = creativeChildren[k];
        if (child.mimeType === 'application/vnd.google-apps.folder') {
          var subItems = await listChildren(child.id, headers);
          fileCount += subItems.filter(function (s) { return s.mimeType !== 'application/vnd.google-apps.folder'; }).length;
        } else {
          fileCount += 1;
        }
      }
      entry.creative_file_count = fileCount;

      out.push(entry);
    } catch (err) {
      monitor.logError('admin-probe-drive-folders', err, { detail: { contact_id: cid } });
      out.push({ contact_id: cid, error: err.message });
    }
  }

  return res.status(200).json({ success: true, probed: out.length, results: out });
};

async function listChildren(folderId, headers) {
  var q = encodeURIComponent("'" + folderId + "' in parents and trashed = false");
  var url = DRIVE_API + '/files?q=' + q + '&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true';
  var resp = await fetch(url, { headers: headers });
  if (!resp.ok) return [];
  var data = await resp.json();
  return data.files || [];
}
