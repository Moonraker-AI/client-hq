// /api/endorse-headshot.js
// Issues a signed upload URL for an endorser headshot, scoped to a single
// path under the existing 'images' bucket. The browser uses the signed URL
// to PUT the file directly to Supabase Storage — never streams bytes through
// this function, which avoids serverless body-size limits and saves
// invocation time.
//
// Two endpoints in one route:
//   POST /api/endorse-headshot         (action='sign', default)
//     → Validates declared filename + content_type + size, allocates a
//       client_image_pool row in 'pending' status with a unique
//       storage_path, requests a signed upload URL from Supabase Storage,
//       returns { image_id, hosted_url, upload_url, upload_method } to the
//       client.
//
//   POST /api/endorse-headshot         (action='complete')
//     → Body: { image_id }. Verifies the file actually arrived in Storage
//       (HEAD), stamps metadata_json.upload_complete_at so the
//       process-image-pool cron picks it up, and returns the eventual
//       hosted URL.
//
// Auth: cookie 'mr_pt_endorsement' from /api/endorse-init.
// Rate limit: 10 sign + 10 complete per hour per IP — generous (each
// submission is one image), tight enough to block abuse.

var sb        = require('./_lib/supabase');
var pageToken = require('./_lib/page-token');
var rateLimit = require('./_lib/rate-limit');
var monitor   = require('./_lib/monitor');
var fetchT    = require('./_lib/fetch-with-timeout');

var BUCKET = 'images';
var MAX_BYTES = 5 * 1024 * 1024;   // 5MB ceiling pre-optimization
var ALLOWED_MIMES = ['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif'];
var EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif'
};
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://clients.moonraker.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var origin = req.headers.origin || '';
  if (origin && origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!sb.isConfigured())        return res.status(500).json({ error: 'Service unavailable' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'Service unavailable' });

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: 'Storage not configured' });

  // ── Auth ───────────────────────────────────────────────────────
  var token = pageToken.getTokenFromRequest(req, 'endorsement');
  if (!token) return res.status(403).json({ error: 'Page token required' });
  var tokenData;
  try {
    tokenData = pageToken.verify(token, 'endorsement');
  } catch (e) {
    monitor.logError('endorse-headshot', e, { detail: { stage: 'token_verify' } });
    return res.status(500).json({ error: 'Token verification unavailable' });
  }
  if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
  var contactId = tokenData.contact_id;

  var body = req.body || {};
  var action = String(body.action || 'sign').toLowerCase();

  // ── Rate limit ─────────────────────────────────────────────────
  var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  var rlKey = 'endorse-headshot:' + action + ':ip:' + ip;
  var rl = await rateLimit.check(rlKey, 10, 3600, { failClosed: true });
  rateLimit.setHeaders(res, rl, 10);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // ── Look up contact (slug binding + practice gate) ─────────────
  var contact;
  try {
    contact = await sb.one(
      'contacts?id=eq.' + encodeURIComponent(contactId) +
      '&select=id,slug,status&limit=1'
    );
  } catch (e) {
    return res.status(500).json({ error: 'Lookup failed' });
  }
  if (!contact) return res.status(403).json({ error: 'Contact not found' });
  if (['prospect','onboarding','active'].indexOf(contact.status) === -1) {
    return res.status(403).json({ error: 'Endorsements not enabled' });
  }

  if (action === 'sign')     return signUpload(req, res, contact, body, serviceKey);
  if (action === 'complete') return completeUpload(req, res, contact, body, serviceKey);
  return res.status(400).json({ error: 'Unknown action' });
};

// ── Sign: allocate row + signed URL ─────────────────────────────
async function signUpload(req, res, contact, body, serviceKey) {
  var contentType = String(body.content_type || '').toLowerCase().trim();
  var declaredBytes = Number(body.bytes);
  var bioMaterialId = body.bio_material_id ? String(body.bio_material_id) : null;

  if (ALLOWED_MIMES.indexOf(contentType) === -1) {
    return res.status(400).json({ error: 'Unsupported file type. Use JPG, PNG, WEBP, or HEIC.' });
  }
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0 || declaredBytes > MAX_BYTES) {
    return res.status(400).json({ error: 'File is too large. Maximum 5MB.' });
  }
  if (bioMaterialId && !UUID_RE.test(bioMaterialId)) {
    return res.status(400).json({ error: 'Invalid bio_material_id' });
  }

  // Verify bio_material_id belongs to this contact (if supplied — optional
  // because the endorser might not yet know which clinician they're picking).
  if (bioMaterialId) {
    try {
      var bm = await sb.one(
        'bio_materials?id=eq.' + encodeURIComponent(bioMaterialId) +
        '&contact_id=eq.' + encodeURIComponent(contact.id) +
        '&select=id&limit=1'
      );
      if (!bm) bioMaterialId = null;  // silently drop
    } catch (e) { bioMaterialId = null; }
  }

  // Allocate a storage path. Pattern matches existing pool conventions:
  // <contact_id>/<category>/<row_uuid>.<ext>
  // We let Postgres generate the row's UUID, then use it as the filename so
  // the path and id are 1:1.
  var ext = EXT_BY_MIME[contentType] || 'jpg';

  // Insert pool row first (without storage_path — set on UPDATE once we
  // know the row id). Use a two-step so we can use the row's own id in
  // the path. Alternative: gen_random_uuid() in app layer; but matching
  // existing-DB-as-source-of-truth is cleaner.
  var poolRow;
  try {
    var rows = await sb.mutate('client_image_pool', 'POST', {
      contact_id: contact.id,
      client_slug: contact.slug,
      category: 'endorser_headshot',
      bio_material_id: bioMaterialId,  // may be null — that's fine
      source_type: 'upload',
      mime_type: contentType,
      bytes: declaredBytes,
      status: 'pending',
      storage_path: 'pending',  // placeholder; updated below
      uploaded_by: 'endorser_form',
      metadata_json: { uploaded_via: 'endorse-headshot' },
    });
    poolRow = Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    monitor.logError('endorse-headshot', e, {
      client_slug: contact.slug,
      detail: { stage: 'pool_insert' }
    });
    return res.status(500).json({ error: 'Could not start upload' });
  }
  if (!poolRow || !poolRow.id) {
    return res.status(500).json({ error: 'Could not start upload' });
  }

  var storagePath = contact.id + '/endorser_headshot/' + poolRow.id + '.' + ext;

  // Update the row with the real storage_path
  try {
    await sb.mutate('client_image_pool?id=eq.' + poolRow.id, 'PATCH', {
      storage_path: storagePath
    }, 'return=minimal');
  } catch (e) {
    monitor.logError('endorse-headshot', e, {
      client_slug: contact.slug,
      detail: { stage: 'pool_path_update', pool_id: poolRow.id }
    });
    return res.status(500).json({ error: 'Could not start upload' });
  }

  // Request signed upload URL from Supabase Storage. 2-hour fixed expiry.
  // x-upsert: true — if the endorser uploads, fails partway, then retries
  // (using a new sign request, new path) we don't strictly need upsert. But
  // if their browser retries the same signed URL within 2h after a partial
  // upload we want the second attempt to succeed cleanly.
  var SB_URL = sb.url();
  var signResp;
  try {
    signResp = await fetchT(
      SB_URL + '/storage/v1/object/upload/sign/' + BUCKET + '/' + storagePath,
      {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          'x-upsert': 'true'
        },
        body: JSON.stringify({}),
      },
      10000
    );
  } catch (e) {
    monitor.logError('endorse-headshot', e, {
      client_slug: contact.slug,
      detail: { stage: 'storage_sign_request', pool_id: poolRow.id }
    });
    return res.status(500).json({ error: 'Could not start upload' });
  }
  if (!signResp.ok) {
    var errBody = '';
    try { errBody = await signResp.text(); } catch (_) {}
    monitor.logError('endorse-headshot', new Error('Storage sign failed'), {
      client_slug: contact.slug,
      detail: { stage: 'storage_sign_response', pool_id: poolRow.id, status: signResp.status, body: String(errBody).substring(0, 200) }
    });
    return res.status(500).json({ error: 'Could not start upload' });
  }
  var signData;
  try { signData = await signResp.json(); } catch (e) { signData = null; }
  if (!signData || !signData.url) {
    return res.status(500).json({ error: 'Could not start upload' });
  }

  // signData.url is e.g. "/object/upload/sign/<path>?token=<...>" (relative
  // to /storage/v1). Build the absolute URL the browser will PUT to.
  var uploadUrl = SB_URL + '/storage/v1' + signData.url;
  var hostedUrl = SB_URL + '/storage/v1/object/public/' + BUCKET + '/' + storagePath;

  return res.status(200).json({
    ok: true,
    image_id: poolRow.id,
    storage_path: storagePath,
    upload_url: uploadUrl,
    upload_method: 'PUT',
    content_type: contentType,
    hosted_url: hostedUrl,
    max_bytes: MAX_BYTES
  });
}

// ── Complete: confirm bytes arrived, mark pool row ready for cron ──
async function completeUpload(req, res, contact, body, serviceKey) {
  var imageId = body.image_id ? String(body.image_id) : null;
  if (!imageId || !UUID_RE.test(imageId)) {
    return res.status(400).json({ error: 'image_id required' });
  }

  var poolRow;
  try {
    poolRow = await sb.one(
      'client_image_pool?id=eq.' + encodeURIComponent(imageId) +
      '&contact_id=eq.' + encodeURIComponent(contact.id) +
      '&category=eq.endorser_headshot' +
      '&select=id,storage_path,status,metadata_json&limit=1'
    );
  } catch (e) {
    return res.status(500).json({ error: 'Lookup failed' });
  }
  if (!poolRow) return res.status(404).json({ error: 'Upload not found' });

  // HEAD the storage object to confirm bytes actually arrived. Without this
  // an attacker could call /complete without ever uploading and produce a
  // pool row that the cron will fail on.
  var SB_URL = sb.url();
  var headResp;
  try {
    headResp = await fetchT(
      SB_URL + '/storage/v1/object/' + BUCKET + '/' + poolRow.storage_path,
      {
        method: 'HEAD',
        headers: {
          'apikey': serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
        }
      },
      10000
    );
  } catch (e) {
    return res.status(500).json({ error: 'Verification failed' });
  }
  if (headResp.status === 404) {
    return res.status(400).json({ error: 'Upload not received yet. Please retry.' });
  }
  if (!headResp.ok) {
    return res.status(500).json({ error: 'Verification failed' });
  }

  // Stamp upload_complete_at so process-image-pool picks it up. If the row
  // is already 'ready' (cron already ran), surface the hosted_url right
  // away — the form layer can use it for instant preview.
  if (poolRow.status === 'pending') {
    try {
      await sb.mutate('client_image_pool?id=eq.' + imageId, 'PATCH', {
        metadata_json: Object.assign({}, poolRow.metadata_json || {}, {
          upload_complete_at: new Date().toISOString()
        })
      }, 'return=minimal');
    } catch (e) {
      monitor.logError('endorse-headshot', e, {
        client_slug: contact.slug,
        detail: { stage: 'mark_complete', pool_id: imageId }
      });
      return res.status(500).json({ error: 'Could not finalize upload' });
    }
  }

  // Refetch the latest hosted_url (set by cron once optimization completes;
  // may still be empty if cron hasn't run yet — caller falls back to the
  // public URL of the original upload, which works because the cron writes
  // to the same path).
  var fresh = await sb.one(
    'client_image_pool?id=eq.' + encodeURIComponent(imageId) +
    '&select=id,hosted_url,storage_path,status&limit=1'
  );

  var hostedUrl = (fresh && fresh.hosted_url)
    || (SB_URL + '/storage/v1/object/public/' + BUCKET + '/' + poolRow.storage_path);

  return res.status(200).json({
    ok: true,
    image_id: imageId,
    hosted_url: hostedUrl,
    status: fresh ? fresh.status : 'pending'
  });
}
