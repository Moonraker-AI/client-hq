// /api/upload-image-init.js
//
// Pagemaster v2 image upload — Step 1 of 2.
//
// Flow:
//   1. Client posts {contact_id, category, filename, mime_type, bytes, bio_material_id?}
//   2. We create a 'pending' client_image_pool row + a Supabase Storage signed
//      upload URL.
//   3. Client PUTs the file directly to that signed URL (skips our function entirely).
//   4. Client posts to /api/upload-image-complete to mark the row 'pending' →
//      processing pickup. Cron then runs sharp on it.
//
// Why signed URL instead of file-through-Vercel:
//   - Vercel Pro request body limit is 4.5MB. iPhone photos are routinely 8-12MB.
//   - Direct upload skips function execution time and memory cost.
//   - Standard pattern for blob storage everywhere.
//
// Auth: dual mode
//   - Admin (cookie / bearer) for admin-side uploads
//   - Page-token scope='onboarding' for client-side uploads during onboarding

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');
var sanitizer = require('./_lib/html-sanitizer');
var crypto = require('crypto');

var ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
var MAX_BYTES = 25 * 1024 * 1024;  // 25MB hard cap; sharp will resize down
var ALLOWED_CATEGORIES = ['practice', 'logo', 'headshot', 'credential', 'hero', 'misc'];
var ALLOWED_SOURCES = ['client', 'admin', 'system'];
var BUCKET = 'images';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  var category = body.category || 'practice';
  var filenameRaw = body.filename || '';
  var mimeType = body.mime_type || '';
  var bytes = parseInt(body.bytes, 10);
  var bioMaterialId = body.bio_material_id || null;

  // Basic validation
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });
  if (!filenameRaw) return res.status(400).json({ error: 'filename required' });
  if (!mimeType) return res.status(400).json({ error: 'mime_type required' });
  if (!bytes || bytes <= 0) return res.status(400).json({ error: 'bytes required' });

  if (ALLOWED_MIMES.indexOf(mimeType.toLowerCase()) === -1) {
    return res.status(400).json({ error: 'Unsupported file type. Use JPEG, PNG, WebP, or HEIC.' });
  }
  if (bytes > MAX_BYTES) {
    return res.status(400).json({ error: 'File too large. Maximum 25MB.' });
  }
  if (ALLOWED_CATEGORIES.indexOf(category) === -1) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact_id' });
  }
  if (bioMaterialId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bioMaterialId)) {
    return res.status(400).json({ error: 'Invalid bio_material_id' });
  }

  try {
    // Auth: page-token (onboarding) bound to contact, OR admin
    var uploadedBy = 'system';
    var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
    var token = null;
    if (tokenStr) { try { token = pageToken.verify(tokenStr, 'onboarding'); } catch (_) { token = null; } }
    if (token && token.contact_id === contactId) {
      uploadedBy = 'client';
    } else {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;  // requireAdmin* writes 401 to res
      uploadedBy = (admin.role === 'internal' || admin.role === 'agent') ? 'system' : 'admin';
    }

    // Look up contact for slug + practice_name (used in filename)
    var contact = await sb.one(
      'contacts?id=eq.' + encodeURIComponent(contactId) +
      '&select=id,slug,practice_name,first_name,last_name,lost,status&limit=1'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost === true || contact.status === 'lost') {
      return res.status(403).json({ error: 'Contact not active' });
    }

    // Compose filename. Slug-safe, no spaces, deterministic but unique.
    var ext = guessExt(mimeType, filenameRaw);
    var practiceSlug = slugify(contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() || contact.slug);
    var shortId = crypto.randomBytes(3).toString('hex');  // 6 hex chars
    var sourceTag = sourceTagFor(category);
    var filename = (practiceSlug + '-' + sourceTag + '-' + shortId + '.' + ext).toLowerCase();
    var storagePath = contact.slug + '/pool/' + filename;

    // Create the pending row first. If signed-URL request fails, we have
    // a stuck pending row that the cron will eventually mark 'failed'.
    var poolRow = await sb.mutate('client_image_pool', 'POST', {
      contact_id: contactId,
      client_slug: contact.slug,
      category: category,
      bio_material_id: bioMaterialId,
      source_type: 'upload',
      storage_path: storagePath,
      hosted_url: '',  // populated post-upload by cron
      filename: filename,
      mime_type: mimeType,
      bytes: bytes,
      status: 'pending',
      uploaded_by: uploadedBy,
      metadata_json: {
        original_filename: sanitizer.sanitizeText(filenameRaw, 200),
        upload_init_at: new Date().toISOString(),
      },
    }, 'return=representation');
    var pool = Array.isArray(poolRow) ? poolRow[0] : poolRow;

    if (!pool || !pool.id) {
      monitor.logError('upload-image-init', new Error('Pool row insert returned empty'), {
        client_slug: contact.slug,
        detail: { stage: 'pool_insert' },
      });
      return res.status(500).json({ error: 'Could not create pool row' });
    }

    // Request a Supabase Storage signed upload URL
    var SB_URL = sb.url();
    var SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    var signResp = await fetch(SB_URL + '/storage/v1/object/upload/sign/' + BUCKET + '/' + storagePath, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!signResp.ok) {
      var errText = await signResp.text();
      // Mark pool row failed, return error
      await sb.mutate('client_image_pool?id=eq.' + pool.id, 'PATCH', {
        status: 'failed',
        metadata_json: Object.assign({}, pool.metadata_json || {}, {
          sign_error: errText.substring(0, 200),
        }),
      }, 'return=minimal').catch(function(){});
      monitor.logError('upload-image-init', new Error('Sign URL failed'), {
        client_slug: contact.slug,
        detail: { stage: 'sign_url', status: signResp.status, body: errText.substring(0, 300) },
      });
      return res.status(502).json({ error: 'Upload URL request failed' });
    }

    var signData = await signResp.json();
    // signData = { url: '/object/upload/sign/...?token=...', token: '...' }
    var uploadUrl = SB_URL + '/storage/v1' + signData.url;

    return res.status(200).json({
      pool_id: pool.id,
      storage_path: storagePath,
      filename: filename,
      upload_url: uploadUrl,
      upload_token: signData.token,
      mime_type: mimeType,
    });

  } catch (err) {
    monitor.logError('upload-image-init', err, {
      detail: { stage: 'init_handler' },
    });
    return res.status(500).json({ error: 'Upload init failed' });
  }
};

// ── helpers ──────────────────────────────────────────────────

function guessExt(mime, filename) {
  var m = (mime || '').toLowerCase();
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/heic' || m === 'image/heif') return 'heic';
  // Fallback: filename extension
  var f = (filename || '').toLowerCase().match(/\.([a-z0-9]{2,4})$/);
  return (f && f[1]) || 'jpg';
}

function slugify(s) {
  return String(s || 'practice').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 40) || 'practice';
}

function sourceTagFor(category) {
  // Short category-derived tag for filename
  var map = {
    practice: 'photo',
    logo: 'logo',
    headshot: 'headshot',
    credential: 'credential',
    hero: 'hero',
    misc: 'misc',
  };
  return map[category] || 'photo';
}
