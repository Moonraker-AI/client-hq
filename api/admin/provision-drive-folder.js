// /api/admin/provision-drive-folder.js
// Ensures a contact has a working Google Drive folder hierarchy.
// - If drive_folder_id is set: probe Drive API to verify it still exists.
// - If not set, or exists but API probe 404s: build the full hierarchy
//   (Clients > [Practice Name] > Creative/Headshots+Logos+Pics+Vids+Other,
//    Docs/GBP Posts+Press Releases, Optimization, Web Design) and link the
//    Creative subfolder to contacts.drive_folder_id / drive_folder_url.
// Mirrors the folder logic in /api/convert-to-prospect.js but is safe to
// call mid-onboarding (no status flips, no onboarding_steps wipes).
//
// POST { contact_id, force?: boolean }
//   force=true will rebuild even if the current folder probes OK.

var sb = require('../_lib/supabase');
var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var google = require('../_lib/google-delegated');

var CLIENTS_FOLDER_ID = '1dymrrowTe1szsOJJPf45x4qDUit6J5jB';
var DRIVE_API = 'https://www.googleapis.com/drive/v3';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });
  }

  var body = req.body || {};
  var contactId = body.contact_id;
  var force = !!body.force;

  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  var results = { probe: null, created: null };

  try {
    var contact = await sb.one(
      'contacts?id=eq.' + contactId +
      '&select=slug,practice_name,drive_folder_id,drive_folder_url'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    var practiceName = contact.practice_name || contact.slug;

    var token;
    try {
      token = await google.getDelegatedAccessToken(
        'support@moonraker.ai',
        'https://www.googleapis.com/auth/drive'
      );
    } catch (e) {
      monitor.logError('admin-provision-drive-folder', e, { detail: { stage: 'drive_token', contact_id: contactId } });
      return res.status(500).json({ error: 'Drive token failed' });
    }

    var headers = {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    };

    // Probe existing folder if we have one and not forcing
    var existing = contact.drive_folder_id;
    var existingOk = false;
    if (existing) {
      var probe = await fetch(
        DRIVE_API + '/files/' + existing + '?fields=id,name,trashed',
        { headers: headers }
      );
      if (probe.ok) {
        var pdata = await probe.json();
        existingOk = !pdata.trashed;
        results.probe = { id: existing, name: pdata.name, trashed: !!pdata.trashed };
      } else {
        results.probe = { id: existing, exists: false, status: probe.status };
      }
    } else {
      results.probe = { exists: false, reason: 'no drive_folder_id on contact' };
    }

    if (existingOk && !force) {
      return res.status(200).json({
        success: true,
        action: 'verified_existing',
        contact: { id: contactId, slug: contact.slug },
        drive_folder_id: existing,
        drive_folder_url: contact.drive_folder_url,
        results: results
      });
    }

    // Build hierarchy
    var parent = await createFolder(practiceName, CLIENTS_FOLDER_ID, headers);
    if (!parent || !parent.id) {
      return res.status(500).json({ error: 'Failed to create parent folder', detail: parent });
    }

    var tree = [
      { name: 'Creative', children: ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'] },
      { name: 'Docs', children: ['GBP Posts', 'Press Releases'] },
      { name: 'Optimization', children: [] },
      { name: 'Web Design', children: [] }
    ];

    var created = { parent: { id: parent.id, name: practiceName }, subfolders: [] };
    var creativeFolderId = null;

    for (var i = 0; i < tree.length; i++) {
      var node = tree[i];
      var sub = await createFolder(node.name, parent.id, headers);
      if (sub && sub.id) {
        created.subfolders.push(node.name);
        if (node.name === 'Creative') creativeFolderId = sub.id;
        for (var j = 0; j < node.children.length; j++) {
          var child = await createFolder(node.children[j], sub.id, headers);
          if (child && child.id) created.subfolders.push(node.name + '/' + node.children[j]);
        }
      }
    }

    results.created = created;

    if (creativeFolderId) {
      await sb.mutate('contacts?id=eq.' + contactId, 'PATCH', {
        drive_folder_id: creativeFolderId,
        drive_folder_url: 'https://drive.google.com/drive/folders/' + creativeFolderId
      });
    }

    return res.status(200).json({
      success: true,
      action: force ? 'rebuilt' : 'created',
      contact: { id: contactId, slug: contact.slug },
      drive_folder_id: creativeFolderId,
      drive_folder_url: creativeFolderId
        ? 'https://drive.google.com/drive/folders/' + creativeFolderId
        : null,
      parent_folder_id: parent.id,
      results: results
    });

  } catch (err) {
    monitor.logError('admin-provision-drive-folder', err, { detail: { stage: 'provision_handler', contact_id: contactId } });
    return res.status(500).json({ error: 'Provision failed' });
  }
};

async function createFolder(name, parentId, headers) {
  try {
    var resp = await fetch(DRIVE_API + '/files', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });
    if (!resp.ok) {
      var t = await resp.text();
      return { error: 'HTTP ' + resp.status + ' ' + t.substring(0, 200) };
    }
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
}
