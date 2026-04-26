/**
 * /api/cron/process-image-pool.js
 *
 * Cron: runs every 1-2 minutes.
 * Picks up client_image_pool rows in 'pending' status whose upload has
 * completed (metadata_json.upload_complete_at present), and processes them.
 *
 * Per row:
 *   1. Download from Supabase Storage
 *   2. Strip EXIF metadata (privacy + bytes)
 *   3. Convert HEIC to JPEG (HEIC isn't web-renderable in most browsers)
 *   4. Resize down if >2400px on the longest side
 *   5. Re-encode and inject IPTC/XMP metadata (title, author, copyright, keywords)
 *   6. Re-upload to same path (overwrite)
 *   7. Generate alt text via Claude based on context (page topic + practice info)
 *   8. Flip status='ready', populate hosted_url, width, height, bytes, alt_text
 *
 * Throughput: processes up to BATCH_SIZE rows per invocation. Sharp is
 * synchronous-ish in CPU — keeping batch small avoids hitting maxDuration.
 *
 * Failure handling: any per-row error flips that row to 'failed' with
 * metadata_json.processing_error set. Cron continues to next row.
 *
 * Idempotency: if a row was already processed (status != 'pending'), skip.
 */

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');

var BATCH_SIZE = 5;          // Per cron invocation; sharp is CPU-bound
var MAX_DIMENSION = 2400;    // Resize anything larger
var JPEG_QUALITY = 88;       // Subjectively the sweet spot for web photos
var BUCKET = 'images';

// sharp is heavy (~9MB). Lazy-require so the cron file's bundle includes
// it but other functions stay slim.
var sharp = null;
function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

async function handler(req, res) {
  // Auth: CRON_SECRET, admin JWT, or AGENT_API_KEY
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  try {
    // CR-M3 (revised 2026-04-26): Queue snapshot runs in parallel with the
    // claim work below. withTracking now awaits req._snapshotPromise before
    // flushing the response, so the snapshot can no longer die mid-fetch
    // when the lambda freezes. Snapshot still doesn't block claim work
    // (both promises proceed concurrently); only the eventual response
    // flush waits for both to settle.
    if (req._cronRunId) {
      req._snapshotPromise = (async function snapshotAsync() {
        try {
          var qRows = await sb.query(
            "client_image_pool?status=eq.pending&select=created_at&order=created_at.asc&limit=200"
          );
          if (!Array.isArray(qRows)) return;
          var oldestAge = qRows.length > 0
            ? Math.max(0, Math.floor((Date.now() - new Date(qRows[0].created_at).getTime()) / 1000))
            : 0;
          await cronRuns.snapshot(req._cronRunId, {
            queue_depth: qRows.length,
            oldest_item_age_sec: oldestAge,
          });
        } catch (snapErr) { /* never block the cron on telemetry */ }
      })();
    }

    // Claim a small batch of pending rows whose upload has completed.
    // We query, filter in app for upload_complete_at presence (PostgREST
    // jsonb extract works but app-level filter is simpler and the queue
    // is small).
    var candidates = await sb.query(
      'client_image_pool?status=eq.pending' +
      '&order=created_at.asc' +
      '&limit=' + (BATCH_SIZE * 3)  // overfetch; some may not yet be upload-complete
    );

    var ready = (candidates || []).filter(function(r) {
      return r.metadata_json && r.metadata_json.upload_complete_at;
    }).slice(0, BATCH_SIZE);

    if (ready.length === 0) {
      return res.status(200).json({ ok: true, processed: 0, message: 'No images ready for processing' });
    }

    var results = { processed: 0, failed: 0, skipped: 0 };
    var details = [];

    for (var i = 0; i < ready.length; i++) {
      var row = ready[i];
      try {
        var outcome = await processOne(row);
        if (outcome.skipped) results.skipped++;
        else results.processed++;
        details.push({ id: row.id, ok: true, outcome: outcome });
      } catch (perRowErr) {
        results.failed++;
        details.push({ id: row.id, ok: false, error: String(perRowErr.message || perRowErr).substring(0, 200) });
        // Mark failed (don't await alt-text on failure)
        try {
          await sb.mutate('client_image_pool?id=eq.' + row.id, 'PATCH', {
            status: 'failed',
            metadata_json: Object.assign({}, row.metadata_json || {}, {
              processing_error: String(perRowErr.message || perRowErr).substring(0, 500),
              processing_failed_at: new Date().toISOString(),
            }),
          }, 'return=minimal');
        } catch (markErr) { /* noop */ }
        monitor.logError('cron/process-image-pool', perRowErr, {
          client_slug: row.client_slug,
          detail: { stage: 'process_one', pool_id: row.id, storage_path: row.storage_path },
        });
      }
    }

    return res.status(200).json({
      ok: true,
      processed: results.processed,
      failed: results.failed,
      skipped: results.skipped,
      details: details,
    });

  } catch (err) {
    monitor.logError('cron/process-image-pool', err, { detail: { stage: 'cron_handler' } });
    return res.status(500).json({ error: 'Cron handler failed' });
  }
}

// ── per-row processor ────────────────────────────────────────

async function processOne(row) {
  // Re-read state in case another worker raced us
  var fresh = await sb.one('client_image_pool?id=eq.' + row.id + '&limit=1');
  if (!fresh) return { skipped: true, reason: 'row_disappeared' };
  if (fresh.status !== 'pending') return { skipped: true, reason: 'status_changed' };

  var SB_URL = sb.url();
  var SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 1. Download original from Storage
  var dlResp = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + row.storage_path, {
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
    },
  });
  if (!dlResp.ok) {
    throw new Error('Storage download failed: ' + dlResp.status);
  }
  var origBuf = Buffer.from(await dlResp.arrayBuffer());

  // 2. Look up contact context for IPTC fields
  var contact = await sb.one(
    'contacts?id=eq.' + encodeURIComponent(row.contact_id) +
    '&select=practice_name,first_name,last_name,city,state_province&limit=1'
  );
  var practiceName = (contact && contact.practice_name)
    || ((contact && (contact.first_name || '') + ' ' + (contact.last_name || '')).trim())
    || 'Practice';

  // 3. Process with sharp
  var s = getSharp();
  var img = s(origBuf, { failOn: 'truncated' });
  var meta = await img.metadata();

  // Resize if too large (preserve aspect, fit inside)
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    img = img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });
  }

  // Output format: JPEG for photos, PNG kept as PNG (logos etc.), WebP kept
  var outFormat;
  var outMime;
  if (meta.format === 'png' && row.category === 'logo') {
    outFormat = 'png';
    outMime = 'image/png';
    img = img.png({ compressionLevel: 9, palette: true });
  } else if (meta.format === 'webp') {
    outFormat = 'webp';
    outMime = 'image/webp';
    img = img.webp({ quality: JPEG_QUALITY });
  } else {
    // Default + HEIC -> JPEG
    outFormat = 'jpeg';
    outMime = 'image/jpeg';
    img = img.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
  }

  // EXIF stripping is the default behavior in sharp unless you call
  // .withMetadata(). We do NOT call it — confirmed strip.
  // For metadata injection we use withExif (sharp 0.33+).
  // Build minimal IPTC/EXIF: copyright, artist, description, comment.
  var year = new Date().getFullYear();
  var copyright = '(C) ' + year + ' ' + practiceName;
  var description = filenameToDescription(row.filename, practiceName);

  // Per-row overrides (e.g. endorser_headshot rows want Artist=endorser_name,
  // ImageDescription="Maya Lin's endorsement of Anna Skomorovskaia at Sky
  // Therapies"). Set by the originating route at insert time, never trusted
  // from end-users (the route sanitizes before storing).
  var overrides = (row.metadata_json && row.metadata_json.exif_overrides) || {};
  var artist = overrides.artist || practiceName;
  if (overrides.description) description = overrides.description;

  // sharp's withExif takes a structured EXIF object. We inject the IFD0 (image-level) fields.
  img = img.withExif({
    IFD0: {
      Copyright: copyright,
      Artist: artist,
      ImageDescription: description,
      Software: 'Moonraker Pagemaster',
    },
  });

  var processedBuf = await img.toBuffer({ resolveWithObject: true });
  var finalBuf = processedBuf.data;
  var finalInfo = processedBuf.info;

  // If the output extension changed (HEIC -> JPG), update path/filename
  var finalStoragePath = row.storage_path;
  var finalFilename = row.filename;
  var finalExt = extOf(finalFilename);
  var desiredExt = outFormat === 'jpeg' ? 'jpg' : outFormat;
  if (finalExt !== desiredExt) {
    finalFilename = finalFilename.replace(/\.[a-z0-9]+$/i, '') + '.' + desiredExt;
    finalStoragePath = row.storage_path.replace(/[^/]+$/, finalFilename);
  }

  // 4. Upload processed bytes back. Use upsert to replace original.
  var upResp = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + finalStoragePath, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': outMime,
      'x-upsert': 'true',
    },
    body: finalBuf,
  });
  if (!upResp.ok) {
    var upErr = await upResp.text();
    throw new Error('Storage upload failed: ' + upResp.status + ' / ' + upErr.substring(0, 200));
  }

  // If we changed path, delete the original
  if (finalStoragePath !== row.storage_path) {
    await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + row.storage_path, {
      method: 'DELETE',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY },
    }).catch(function(){});
  }

  // 5. Build the public hosted URL
  // Public bucket — direct URL pattern: /storage/v1/object/public/<bucket>/<path>
  var hostedUrl = SB_URL + '/storage/v1/object/public/' + BUCKET + '/' + finalStoragePath;

  // 6. Generate alt text via Claude (best-effort — failures don't block the row)
  var altText = '';
  try {
    altText = await generateAltText({
      practiceName: practiceName,
      category: row.category,
      filename: finalFilename,
    });
  } catch (altErr) {
    // Non-fatal — fall back to a deterministic alt
    altText = description;
  }

  // 7. Update the row
  await sb.mutate('client_image_pool?id=eq.' + row.id, 'PATCH', {
    status: 'ready',
    storage_path: finalStoragePath,
    filename: finalFilename,
    hosted_url: hostedUrl,
    mime_type: outMime,
    width: finalInfo.width,
    height: finalInfo.height,
    bytes: finalBuf.length,
    alt_text: altText,
    title: description,
    metadata_json: Object.assign({}, row.metadata_json || {}, {
      exif_stripped: true,
      original_bytes: row.bytes,
      processed_at: new Date().toISOString(),
      original_format: meta.format,
      output_format: outFormat,
      iptc_injected: true,
      copyright: copyright,
    }),
  }, 'return=minimal');

  return {
    ok: true,
    bytes_before: row.bytes,
    bytes_after: finalBuf.length,
    width: finalInfo.width,
    height: finalInfo.height,
  };
}

// ── helpers ──────────────────────────────────────────────────

function extOf(name) {
  var m = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function filenameToDescription(filename, practiceName) {
  // Strip ext + numeric suffix; convert dashes to spaces.
  // "sky-therapies-photo-3f2a.jpg" -> "Sky Therapies photo"
  var base = (filename || '').replace(/\.[a-z0-9]+$/i, '').replace(/-[a-f0-9]{4,8}$/i, '');
  var words = base.split('-').filter(function(w) { return w && !/^\d+$/.test(w); });
  if (words.length === 0) return practiceName + ' photo';
  // Title-case
  var titled = words.map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  return titled;
}

async function generateAltText(args) {
  // Placeholder for V1: deterministic alt from category + practice.
  // V2 (immediate follow-up): call Claude with a small prompt + image base64
  // for true vision-grounded alt text. Skipped here to keep cron lean +
  // avoid extra Anthropic cost on every upload. Can be turned on per-category.
  var cat = args.category || 'practice';
  var labels = {
    practice: 'photo of ' + args.practiceName,
    logo: args.practiceName + ' logo',
    headshot: 'portrait of clinician at ' + args.practiceName,
    hero: 'photo from ' + args.practiceName,
    misc: 'image from ' + args.practiceName,
  };
  return labels[cat] || (args.practiceName + ' photo');
}

module.exports = cronRuns.withTracking('process-image-pool', handler);
