// /api/convert-to-prospect.js
// Manual fallback for converting a lead to prospect WITHOUT generating a proposal.
// Flips Supabase status, seeds onboarding steps, creates Google Drive folder hierarchy.
// NOTE: generate-proposal.js is the primary conversion path and handles everything
// including page deployment. This endpoint is for edge cases only (e.g. manual
// conversion from the admin client deep-dive).
//
// POST { slug, contact_id }

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var slug = body.slug;
  var contactId = body.contact_id;

  if (!slug || !contactId) {
    return res.status(400).json({ error: 'slug and contact_id required' });
  }

  var CLIENTS_FOLDER_ID = '1dymrrowTe1szsOJJPf45x4qDUit6J5jB';
  var sbHeaders = sb.headers('return=representation');

  var results = { supabase: {}, drive: {} };

  try {
    // ============================================================
    // STEP 0: Fetch contact for practice_name + existing drive_folder_id
    // ============================================================
    var contactResp = await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contactId + '&select=practice_name,drive_folder_id', {
      headers: sb.headers()
    });
    var contactData = await contactResp.json();
    var practiceName = (contactData && contactData[0] && contactData[0].practice_name) || slug;
    var existingDriveFolder = contactData && contactData[0] && contactData[0].drive_folder_id;

    // ============================================================
    // STEP 1: Flip contact status to prospect
    // ============================================================
    var patchResp = await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contactId, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({
        status: 'prospect',
        converted_from_lead_at: new Date().toISOString()
      })
    });
    if (!patchResp.ok) {
      var patchErr = await patchResp.json();
      return res.status(500).json({ error: 'Failed to update contact', detail: patchErr });
    }
    results.supabase.status = 'prospect';

    // ============================================================
    // STEP 2: Seed 9 onboarding steps (idempotent: delete first)
    // ============================================================
    var steps = [
      { contact_id: contactId, step_key: 'confirm_info', label: 'Confirm Info', status: 'pending', sort_order: 1 },
      { contact_id: contactId, step_key: 'sign_agreement', label: 'Sign Agreement', status: 'pending', sort_order: 2 },
      { contact_id: contactId, step_key: 'book_intro_call', label: 'Book Intro Call', status: 'pending', sort_order: 3 },
      { contact_id: contactId, step_key: 'connect_accounts', label: 'Connect Accounts', status: 'pending', sort_order: 4 },
      { contact_id: contactId, step_key: 'practice_details', label: 'Practice Details', status: 'pending', sort_order: 5 },
      { contact_id: contactId, step_key: 'bio_materials', label: 'Bio Materials', status: 'pending', sort_order: 6 },
      { contact_id: contactId, step_key: 'social_profiles', label: 'Social Profiles', status: 'pending', sort_order: 7 },
      { contact_id: contactId, step_key: 'checkins_and_drive', label: 'Google Drive', status: 'pending', sort_order: 8 },
      { contact_id: contactId, step_key: 'performance_guarantee', label: 'Performance Guarantee', status: 'pending', sort_order: 9 }
    ];

    await fetch(sb.url() + '/rest/v1/onboarding_steps?contact_id=eq.' + contactId, {
      method: 'DELETE',
      headers: sbHeaders
    });

    var seedResp = await fetch(sb.url() + '/rest/v1/onboarding_steps', {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify(steps)
    });
    results.supabase.onboarding_steps = seedResp.ok ? 9 : 'failed';

    // ============================================================
    // STEP 3: Create Google Drive folder hierarchy (skip if exists)
    // ============================================================
    if (existingDriveFolder) {
      results.drive.skipped = 'Drive folder already exists: ' + existingDriveFolder;
    } else if (saJson) {
      try {
        var driveToken = await getDelegatedToken(saJson, 'support@moonraker.ai', 'https://www.googleapis.com/auth/drive');
        if (driveToken && typeof driveToken === 'string') {
          var driveHeaders = {
            'Authorization': 'Bearer ' + driveToken,
            'Content-Type': 'application/json'
          };

          // Create parent folder: Drive > Clients > [Practice Name]
          var parentFolder = await createDriveFolder(practiceName, CLIENTS_FOLDER_ID, driveHeaders);
          if (parentFolder && parentFolder.id) {
            results.drive.parent = { id: parentFolder.id, name: practiceName };

            var folderTree = [
              { name: 'Creative', children: ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'] },
              { name: 'Docs', children: ['GBP Posts', 'Press Releases'] },
              { name: 'Optimization', children: [] },
              { name: 'Web Design', children: [] }
            ];

            var createdSubs = [];
            var creativeFolderId = null;

            for (var f = 0; f < folderTree.length; f++) {
              var node = folderTree[f];
              var subFolder = await createDriveFolder(node.name, parentFolder.id, driveHeaders);
              if (subFolder && subFolder.id) {
                createdSubs.push(node.name);
                if (node.name === 'Creative') creativeFolderId = subFolder.id;

                for (var ch = 0; ch < node.children.length; ch++) {
                  var childFolder = await createDriveFolder(node.children[ch], subFolder.id, driveHeaders);
                  if (childFolder && childFolder.id) {
                    createdSubs.push(node.name + '/' + node.children[ch]);
                  }
                }
              }
            }
            results.drive.subfolders = createdSubs;

            if (creativeFolderId) {
              await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contactId, {
                method: 'PATCH',
                headers: sbHeaders,
                body: JSON.stringify({
                  drive_folder_id: creativeFolderId,
                  drive_folder_url: 'https://drive.google.com/drive/folders/' + creativeFolderId
                })
              });
              results.drive.creative_folder = 'https://drive.google.com/drive/folders/' + creativeFolderId;
            }
          } else {
            results.drive.error = 'Failed to create parent folder: ' + JSON.stringify(parentFolder);
          }
        } else {
          results.drive.error = 'Failed to get Drive token: ' + (driveToken && driveToken.error ? driveToken.error : 'unknown');
        }
      } catch (driveErr) {
        results.drive.error = driveErr.message || String(driveErr);
      }
    } else {
      results.drive.skipped = 'GOOGLE_SERVICE_ACCOUNT_JSON not configured';
    }

    return res.status(200).json({ success: true, results: results });

  } catch (err) {
    return res.status(500).json({ error: err.message, results: results });
  }
};


// ═══════════════════════════════════════════════════════════════════
// Helper: Get access token via domain-wide delegation
// ═══════════════════════════════════════════════════════════════════
async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('SA JSON missing private_key or client_email');
    }
    var crypto = require('crypto');
var auth = require('./_lib/auth');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: impersonateEmail,
      scope: scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })).toString('base64url');

    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');

    var jwt = signable + '.' + signature;

    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    }
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Create a folder in Google Drive
// ═══════════════════════════════════════════════════════════════════
async function createDriveFolder(name, parentId, headers) {
  try {
    var resp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });
    if (!resp.ok) {
      var errBody = await resp.text();
      return { error: 'Drive API ' + resp.status + ': ' + errBody };
    }
    return await resp.json();
  } catch (e) {
    return { error: e.message || String(e) };
  }
}
