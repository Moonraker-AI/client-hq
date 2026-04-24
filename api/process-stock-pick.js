// /api/process-stock-pick.js
//
// Pagemaster v2: clone a stock_images row into client_image_pool.
// Used by the pool picker UI when the client/admin selects "Pick from library".
//
// POST { contact_id, stock_image_ids: [int|string, ...], category? }
//
// Per stock pick:
//   1. Fetch stock_images row (must have hosted_url)
//   2. Download bytes from hosted_url
//   3. Upload to images bucket at <slug>/pool/<filename>
//   4. Create client_image_pool row with status='pending', source_type='stock'
//      (cron will then EXIF-strip + IPTC-inject the same way as uploaded files)
//
// Returns { items: [{ stock_image_id, pool_id, ok, error? }, ...] }
//
// Idempotency: if a stock image was already picked for this contact, returns
// the existing pool row instead of creating a duplicate.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');
var crypto = require('crypto');

var BUCKET = 'images';
var ALLOWED_CATEGORIES = ['practice', 'logo', 'headshot', 'credential', 'hero', 'misc'];
var MAX_BATCH = 25;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  var ids = body.stock_image_ids || [];
  var category = body.category || 'practice';

  if (!contactId || !UUID_RE.test(contactId)) return res.status(400).json({ error: 'Invalid contact_id' });
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'stock_image_ids required' });
  if (ids.length > MAX_BATCH) return res.status(400).json({ error: 'Too many ids; max ' + MAX_BATCH });
  if (ALLOWED_CATEGORIES.indexOf(category) === -1) return res.status(400).json({ error: 'Invalid category' });

  // Coerce all ids to integers (stock_images.id is integer)
  var stockIds = [];
  for (var i = 0; i < ids.length; i++) {
    var n = parseInt(ids[i], 10);
    if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'Invalid stock id: ' + ids[i] });
    stockIds.push(n);
  }

  try {
    // Auth: page-token first (typical), admin fallback
    var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
    var token = null;
    if (tokenStr) { try { token = pageToken.verify(tokenStr, 'onboarding'); } catch (_) { token = null; } }
    var actor;
    if (token && token.contact_id === contactId) {
      actor = 'client';
    } else {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
      actor = (admin.role === 'internal' || admin.role === 'agent') ? 'system' : 'admin';
    }

    // Look up contact
    var contact = await sb.one(
      'contacts?id=eq.' + encodeURIComponent(contactId) +
      '&select=id,slug,practice_name,first_name,last_name,lost,status&limit=1'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost === true || contact.status === 'lost') {
      return res.status(403).json({ error: 'Contact not active' });
    }

    var practiceSlug = slugify(contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() || contact.slug);

    // Fetch all stock rows in one query
    var stockInList = '(' + stockIds.join(',') + ')';
    var stockRows = await sb.query(
      'stock_images?id=in.' + stockInList +
      '&select=id,asset_id,rich_description,mood_tags,hosted_url,drive_download_url'
    );
    var stockById = {};
    for (var s = 0; s < (stockRows || []).length; s++) {
      stockById[stockRows[s].id] = stockRows[s];
    }

    // Look up existing pool rows from prior picks (idempotency)
    var existing = await sb.query(
      'client_image_pool?contact_id=eq.' + encodeURIComponent(contactId) +
      '&source_type=eq.stock' +
      '&select=id,source_ref,status,hosted_url'
    );
    var existingByStockId = {};
    for (var e = 0; e < (existing || []).length; e++) {
      var ref = existing[e].source_ref;
      if (ref) existingByStockId[ref] = existing[e];
    }

    var results = [];

    for (var k = 0; k < stockIds.length; k++) {
      var stockId = stockIds[k];
      var stock = stockById[stockId];
      if (!stock) {
        results.push({ stock_image_id: stockId, ok: false, error: 'Stock image not found' });
        continue;
      }

      // Idempotency check
      var prior = existingByStockId[String(stockId)];
      if (prior) {
        results.push({
          stock_image_id: stockId,
          pool_id: prior.id,
          status: prior.status,
          hosted_url: prior.hosted_url || null,
          ok: true,
          existing: true,
        });
        continue;
      }

      var sourceUrl = stock.hosted_url || stock.drive_download_url;
      if (!sourceUrl) {
        results.push({ stock_image_id: stockId, ok: false, error: 'No source URL on stock row' });
        continue;
      }

      try {
        var pickResult = await pickOne({
          contactId: contactId,
          slug: contact.slug,
          practiceSlug: practiceSlug,
          stock: stock,
          category: category,
          sourceUrl: sourceUrl,
          actor: actor,
        });
        results.push({
          stock_image_id: stockId,
          pool_id: pickResult.pool_id,
          status: 'pending',
          ok: true,
        });
      } catch (perStockErr) {
        results.push({
          stock_image_id: stockId,
          ok: false,
          error: String(perStockErr.message || perStockErr).substring(0, 200),
        });
        monitor.logError('process-stock-pick', perStockErr, {
          client_slug: contact.slug,
          detail: { stage: 'pick_one', stock_image_id: stockId },
        });
      }
    }

    return res.status(200).json({ items: results });

  } catch (err) {
    monitor.logError('process-stock-pick', err, { detail: { stage: 'handler' } });
    return res.status(500).json({ error: 'Stock pick failed' });
  }
};

// ── per-pick worker ──────────────────────────────────────────

async function pickOne(args) {
  var SB_URL = sb.url();
  var SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 1. Download the stock image bytes
  var dl = await fetch(args.sourceUrl);
  if (!dl.ok) throw new Error('Source download failed: ' + dl.status);
  var buf = Buffer.from(await dl.arrayBuffer());
  var mimeType = dl.headers.get('content-type') || 'image/jpeg';
  // Some content-type headers include charset; strip
  mimeType = mimeType.split(';')[0].trim();

  // 2. Compose filename + storage path
  var ext = guessExt(mimeType, args.sourceUrl);
  var shortId = crypto.randomBytes(3).toString('hex');
  var sourceTag = sourceTagFor(args.category);
  var filename = (args.practiceSlug + '-' + sourceTag + '-' + shortId + '.' + ext).toLowerCase();
  var storagePath = args.slug + '/pool/' + filename;

  // 3. Upload to Storage (raw — cron will process with sharp)
  var upResp = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': mimeType,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!upResp.ok) {
    var upErr = await upResp.text();
    throw new Error('Storage upload failed: ' + upResp.status + ' / ' + upErr.substring(0, 200));
  }

  // 4. Pull a few useful tags for the pool row metadata
  var tags = [];
  if (args.stock.mood_tags) {
    var t = String(args.stock.mood_tags).split(/[,;|]/).map(function(x) { return x.trim().toLowerCase(); }).filter(Boolean);
    tags = t.slice(0, 12);
  }

  // 5. Create pool row, marked upload-complete so the cron will pick it up
  var poolRow = await sb.mutate('client_image_pool', 'POST', {
    contact_id: args.contactId,
    client_slug: args.slug,
    category: args.category,
    source_type: 'stock',
    source_ref: String(args.stock.id),
    storage_path: storagePath,
    hosted_url: '',  // populated post-processing by cron
    filename: filename,
    mime_type: mimeType,
    bytes: buf.length,
    tags: tags,
    status: 'pending',
    uploaded_by: args.actor,
    metadata_json: {
      stock_image_id: args.stock.id,
      stock_asset_id: args.stock.asset_id,
      stock_rich_description: args.stock.rich_description || null,
      original_filename: filename,
      upload_complete_at: new Date().toISOString(),
      origin: 'stock_pick',
    },
  }, 'return=representation');
  var pool = Array.isArray(poolRow) ? poolRow[0] : poolRow;
  if (!pool || !pool.id) throw new Error('Pool row insert returned empty');

  return { pool_id: pool.id };
}

// ── helpers (mirror upload-image-init) ──────────────────────

function guessExt(mime, url) {
  var m = (mime || '').toLowerCase();
  if (m === 'image/jpeg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/heic' || m === 'image/heif') return 'heic';
  var u = (url || '').toLowerCase().match(/\.([a-z0-9]{2,4})(?:\?|$)/);
  return (u && u[1]) || 'jpg';
}

function slugify(s) {
  return String(s || 'practice').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 40) || 'practice';
}

function sourceTagFor(category) {
  return {
    practice: 'photo',
    logo: 'logo',
    headshot: 'headshot',
    hero: 'hero',
    misc: 'misc',
  }[category] || 'photo';
}
