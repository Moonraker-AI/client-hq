// /api/convert-to-prospect.js
// Converts a lead to a prospect: flips Supabase status, seeds onboarding steps,
// deploys router/proposal/checkout/onboarding pages from templates to GitHub,
// and creates Google Drive folder hierarchy for the client.
// Drive structure: Client Name > Creative (Headshots, Logos, Pics, Vids, Other),
//                                Docs (GBP Posts, Press Releases), Optimization, Web Design
// NOTE: generate-proposal.js now handles the full conversion flow automatically.
// This endpoint remains as a manual fallback for cases where conversion is needed
// without proposal generation.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var ghToken = process.env.GITHUB_PAT;
  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var slug = body.slug;
  var contactId = body.contact_id;

  if (!slug || !contactId) {
    return res.status(400).json({ error: 'slug and contact_id required' });
  }

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var CLIENTS_FOLDER_ID = '1dymrrowTe1szsOJJPf45x4qDUit6J5jB';
  var DRIVE_SUBFOLDERS = [
    { name: 'Creative', children: ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'] },
    { name: 'Docs', children: ['GBP Posts', 'Press Releases'] },
    { name: 'Optimization', children: [] },
    { name: 'Web Design', children: [] }
  ];
  var sbHeaders = {
    'apikey': sbKey,
    'Authorization': 'Bearer ' + sbKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  var results = { supabase: {}, github: [], drive: {} };

  try {
    // ============================================================
    // STEP 0: Fetch contact practice_name for Drive folder naming
    // ============================================================
    var contactResp = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + contactId + '&select=practice_name', {
      headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
    });
    var contactData = await contactResp.json();
    var practiceName = (contactData && contactData[0] && contactData[0].practice_name) || slug;

    // ============================================================
    // STEP 1: Flip contact status to prospect
    // ============================================================
    var patchResp = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + contactId, {
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
    // STEP 2: Seed 8 onboarding steps
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

    // Delete any existing steps for this contact first (idempotent)
    await fetch(sbUrl + '/rest/v1/onboarding_steps?contact_id=eq.' + contactId, {
      method: 'DELETE',
      headers: sbHeaders
    });

    var seedResp = await fetch(sbUrl + '/rest/v1/onboarding_steps', {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify(steps)
    });
    results.supabase.onboarding_steps = seedResp.ok ? 9 : 'failed';

    // ============================================================
    // STEP 3: Deploy 4 template files to GitHub
    // ============================================================
    var templates = [
      { src: '_templates/router.html', dest: slug + '/index.html' },
      { src: '_templates/proposal.html', dest: slug + '/proposal/index.html' },
      { src: '_templates/checkout.html', dest: slug + '/checkout/index.html' },
      { src: '_templates/onboarding.html', dest: slug + '/onboarding/index.html' }
    ];

    var ghHeaders = {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];

      // Read template content (base64)
      var srcResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + t.src + '?ref=' + BRANCH, {
        headers: ghHeaders
      });
      if (!srcResp.ok) {
        results.github.push({ path: t.dest, ok: false, error: 'Template not found: ' + t.src });
        continue;
      }
      var srcData = await srcResp.json();

      // Check if destination exists (need SHA for update)
      var sha = null;
      var checkResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + t.dest + '?ref=' + BRANCH, {
        headers: ghHeaders
      });
      if (checkResp.ok) {
        var checkData = await checkResp.json();
        sha = checkData.sha;
      }

      // Push file
      var pushBody = {
        message: 'Deploy ' + t.dest + ' for prospect ' + slug,
        content: srcData.content.replace(/\n/g, ''), // GitHub returns base64 with newlines
        branch: BRANCH
      };
      if (sha) pushBody.sha = sha;

      var pushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + t.dest, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify(pushBody)
      });
      results.github.push({ path: t.dest, ok: pushResp.ok });
    }

    // ============================================================
    // STEP 4: Also deploy entity-audit-checkout if lead has entity audit
    // ============================================================
    var eaCheck = await fetch(sbUrl + '/rest/v1/entity_audits?contact_id=eq.' + contactId + '&limit=1', {
      headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
    });
    var eaData = await eaCheck.json();
    if (eaData && eaData.length > 0) {
      // Deploy entity audit checkout page too
      var eaSrc = await fetch('https://api.github.com/repos/' + REPO + '/contents/_templates/entity-audit-checkout.html?ref=' + BRANCH, {
        headers: ghHeaders
      });
      if (eaSrc.ok) {
        var eaSrcData = await eaSrc.json();
        var eaDest = slug + '/entity-audit-checkout/index.html';
        var eaSha = null;
        var eaDestCheck = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + eaDest + '?ref=' + BRANCH, {
          headers: ghHeaders
        });
        if (eaDestCheck.ok) eaSha = (await eaDestCheck.json()).sha;

        var eaPush = {
          message: 'Deploy entity-audit-checkout for ' + slug,
          content: eaSrcData.content.replace(/\n/g, ''),
          branch: BRANCH
        };
        if (eaSha) eaPush.sha = eaSha;

        var eaPushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + eaDest, {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify(eaPush)
        });
        results.github.push({ path: eaDest, ok: eaPushResp.ok });
      }
    }

    // ============================================================
    // STEP 5: Create Google Drive folder hierarchy
    // ============================================================
    if (saJson) {
      try {
        var driveToken = await getDelegatedToken(saJson, 'support@moonraker.ai', 'https://www.googleapis.com/auth/drive');
        if (driveToken && typeof driveToken === 'string') {
          var driveHeaders = {
            'Authorization': 'Bearer ' + driveToken,
            'Content-Type': 'application/json'
          };

          // Create parent folder named after the practice
          var parentFolder = await createDriveFolder(practiceName, CLIENTS_FOLDER_ID, driveHeaders);
          if (parentFolder && parentFolder.id) {
            results.drive.parent = { id: parentFolder.id, name: practiceName };

            // Create all subfolders with nested children
            var createdSubs = [];
            var creativeFolderId = null;
            var creativeFolderUrl = null;

            for (var s = 0; s < DRIVE_SUBFOLDERS.length; s++) {
              var node = DRIVE_SUBFOLDERS[s];
              var subFolder = await createDriveFolder(node.name, parentFolder.id, driveHeaders);
              if (subFolder && subFolder.id) {
                createdSubs.push(node.name);
                if (node.name === 'Creative') {
                  creativeFolderId = subFolder.id;
                  creativeFolderUrl = 'https://drive.google.com/drive/folders/' + subFolder.id;
                }
                // Create children inside this subfolder
                for (var ch = 0; ch < node.children.length; ch++) {
                  var childFolder = await createDriveFolder(node.children[ch], subFolder.id, driveHeaders);
                  if (childFolder && childFolder.id) {
                    createdSubs.push(node.name + '/' + node.children[ch]);
                  }
                }
              }
            }
            results.drive.subfolders = createdSubs;

            // Write Creative folder link to contacts for onboarding page
            if (creativeFolderId) {
              await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + contactId, {
                method: 'PATCH',
                headers: sbHeaders,
                body: JSON.stringify({
                  drive_folder_id: creativeFolderId,
                  drive_folder_url: creativeFolderUrl
                })
              });
              results.drive.creative_folder = creativeFolderUrl;
            }
          } else {
            results.drive.error = 'Failed to create parent folder: ' + JSON.stringify(parentFolder);
          }
        } else {
          results.drive.error = 'Failed to get Drive token: ' + (driveToken && driveToken.error ? driveToken.error : 'unknown');
        }
      } catch (driveErr) {
        // Drive folder creation is non-blocking: log error but don't fail the whole conversion
        results.drive.error = driveErr.message || String(driveErr);
      }
    } else {
      results.drive.skipped = 'GOOGLE_SERVICE_ACCOUNT_JSON not configured';
    }

    // Build URLs
    results.urls = {
      router: 'https://clients.moonraker.ai/' + slug,
      proposal: 'https://clients.moonraker.ai/' + slug + '/proposal',
      checkout: 'https://clients.moonraker.ai/' + slug + '/checkout',
      onboarding: 'https://clients.moonraker.ai/' + slug + '/onboarding'
    };

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

