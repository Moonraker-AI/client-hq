// rebuild trigger
// /api/admin/fix-drive-folders.js
// TEMPORARY one-shot fixes for Derek + Monique.
// Auth: CRON_SECRET Bearer.
// Actions:
//   - Derek: untrash Creative folder, create missing subfolders, move 4 loose certs into Other.
//   - Monique: find Creative subfolder under her parent, update drive_folder_id in contacts.

var sb = require('../_lib/supabase');
var google = require('../_lib/google-delegated');

var DRIVE_API = 'https://www.googleapis.com/drive/v3';

var DEREK_CONTACT_ID = 'fcb7af1b-1dc4-45a5-ab2a-daf8f38ec247';
var DEREK_CREATIVE_ID = '1h0c9g-OnDXKC0nNfWv_RE_lo3HSC6etv';
var MONIQUE_CONTACT_ID = '84912790-bbbc-4ab4-b0c9-9ed1eed0308b';
var MONIQUE_PARENT_ID = '1VZEW2KFhJhug2QM0YKE_w_KHRP4n-4mU';

var DEFAULT_CREATIVE_CHILDREN = ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var authz = req.headers.authorization || '';
  var token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var action = (req.body && req.body.action) || '';
  if (action !== 'derek' && action !== 'monique') {
    return res.status(400).json({ error: 'action must be "derek" or "monique"' });
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
  var H = { 'Authorization': 'Bearer ' + saToken, 'Content-Type': 'application/json' };

  try {
    if (action === 'derek') return res.status(200).json(await fixDerek(H));
    if (action === 'monique') return res.status(200).json(await fixMonique(H));
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};

async function fixDerek(H) {
  var log = [];

  // 1. Untrash Creative
  var untrash = await fetch(DRIVE_API + '/files/' + DEREK_CREATIVE_ID + '?supportsAllDrives=true',
    { method: 'PATCH', headers: H, body: JSON.stringify({ trashed: false }) });
  if (!untrash.ok) throw new Error('untrash failed: ' + untrash.status + ' ' + (await untrash.text()));
  log.push('untrashed Creative folder');

  // 2. List current children, figure out which files are loose and which standard subfolders exist
  var kidsResp = await fetch(DRIVE_API + '/files?q=' + encodeURIComponent("'" + DEREK_CREATIVE_ID + "' in parents and trashed = false") +
    '&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true',
    { headers: H });
  var kidsData = await kidsResp.json();
  var kids = kidsData.files || [];

  var existingFolderNames = kids.filter(k => k.mimeType === 'application/vnd.google-apps.folder').map(k => k.name);
  var looseFiles = kids.filter(k => k.mimeType !== 'application/vnd.google-apps.folder');
  log.push('found ' + kids.length + ' children: ' + existingFolderNames.length + ' folders, ' + looseFiles.length + ' loose files');

  // 3. Create any missing standard Creative children
  var created = {};
  for (var i = 0; i < DEFAULT_CREATIVE_CHILDREN.length; i++) {
    var name = DEFAULT_CREATIVE_CHILDREN[i];
    if (existingFolderNames.indexOf(name) !== -1) continue;
    var c = await fetch(DRIVE_API + '/files?supportsAllDrives=true', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder', parents: [DEREK_CREATIVE_ID] })
    });
    if (!c.ok) throw new Error('create ' + name + ' failed: ' + c.status + ' ' + (await c.text()));
    var cdata = await c.json();
    created[name] = cdata.id;
    log.push('created ' + name + ' (' + cdata.id + ')');
  }

  // 4. Find the "Other" folder id (either created or existing)
  var otherId = created['Other'];
  if (!otherId) {
    var existingOther = kids.find(k => k.mimeType === 'application/vnd.google-apps.folder' && k.name === 'Other');
    if (existingOther) otherId = existingOther.id;
  }
  if (!otherId) throw new Error('Could not resolve Other folder id');

  // 5. Move loose files into Other
  var moves = [];
  for (var j = 0; j < looseFiles.length; j++) {
    var f = looseFiles[j];
    var mv = await fetch(DRIVE_API + '/files/' + f.id +
      '?addParents=' + otherId + '&removeParents=' + DEREK_CREATIVE_ID + '&supportsAllDrives=true',
      { method: 'PATCH', headers: H, body: JSON.stringify({}) });
    if (!mv.ok) {
      moves.push({ file: f.name, ok: false, status: mv.status, body: await mv.text() });
    } else {
      moves.push({ file: f.name, ok: true });
      log.push('moved ' + f.name + ' into Other');
    }
  }

  return { success: true, action: 'derek', log: log, moves: moves, creative_folder_id: DEREK_CREATIVE_ID, other_folder_id: otherId };
}

async function fixMonique(H) {
  var log = [];

  // 1. List children of Monique's current drive_folder_id (which is actually her parent folder)
  var kidsResp = await fetch(DRIVE_API + '/files?q=' + encodeURIComponent("'" + MONIQUE_PARENT_ID + "' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = 'Creative'") +
    '&fields=files(id,name)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true',
    { headers: H });
  var kidsData = await kidsResp.json();
  var kids = kidsData.files || [];

  if (kids.length === 0) throw new Error('No Creative subfolder found under Monique parent');
  if (kids.length > 1) log.push('WARN: ' + kids.length + ' Creative folders found, using first');

  var creativeId = kids[0].id;
  log.push('resolved Creative folder: ' + creativeId);

  // 2. Ensure the 5 standard children exist inside Creative
  var existingResp = await fetch(DRIVE_API + '/files?q=' + encodeURIComponent("'" + creativeId + "' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'") +
    '&fields=files(id,name)&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true',
    { headers: H });
  var existingData = await existingResp.json();
  var existingNames = (existingData.files || []).map(f => f.name);
  log.push('existing Creative subfolders: ' + JSON.stringify(existingNames));

  var createdChildren = [];
  for (var i = 0; i < DEFAULT_CREATIVE_CHILDREN.length; i++) {
    var name = DEFAULT_CREATIVE_CHILDREN[i];
    if (existingNames.indexOf(name) !== -1) continue;
    var c = await fetch(DRIVE_API + '/files?supportsAllDrives=true', {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder', parents: [creativeId] })
    });
    if (!c.ok) throw new Error('create ' + name + ' failed: ' + c.status + ' ' + (await c.text()));
    var cdata = await c.json();
    createdChildren.push(name + '(' + cdata.id + ')');
    log.push('created ' + name);
  }

  // 3. Update DB
  await sb.mutate('contacts?id=eq.' + MONIQUE_CONTACT_ID, 'PATCH', {
    drive_folder_id: creativeId,
    drive_folder_url: 'https://drive.google.com/drive/folders/' + creativeId
  });
  log.push('updated contacts.drive_folder_id -> ' + creativeId);

  return { success: true, action: 'monique', log: log, new_drive_folder_id: creativeId, created_children: createdChildren };
}
