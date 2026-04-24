// /api/generate-pool-image.js
//
// Pagemaster v2: generate an AI image and place it in client_image_pool.
// Uses Gemini 2.0 Flash image generation (Nano Banana) with a user-provided
// or templated prompt.
//
// Distinct from /api/generate-neo-image which produces composited NEO images
// (with logo + QR + caption overlay). This route is for general pool images
// — section illustrations, supporting visuals, etc.
//
// POST { contact_id, prompt, category? }
//
// Returns { pool_id, status: 'pending' }   (cron then strips/processes/IPTC)

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');
var sanitizer = require('./_lib/html-sanitizer');
var crypto = require('crypto');

var GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
var MODEL_PRIMARY = 'gemini-2.0-flash-preview-image-generation';
var MODEL_FALLBACK = 'nano-banana-pro-preview';
var BUCKET = 'images';
var ALLOWED_CATEGORIES = ['practice', 'hero', 'misc'];  // logo/headshot are not AI-generated
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var PROMPT_MAX = 800;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var GOOGLE_KEY = process.env.GOOGLE_API_KEY;
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  var promptRaw = body.prompt || '';
  var category = body.category || 'practice';
  var asDraft = body.as_draft === true;

  if (!contactId || !UUID_RE.test(contactId)) return res.status(400).json({ error: 'Invalid contact_id' });
  if (!promptRaw || !String(promptRaw).trim()) return res.status(400).json({ error: 'prompt required' });
  if (ALLOWED_CATEGORIES.indexOf(category) === -1) {
    return res.status(400).json({ error: 'Category must be practice, hero, or misc' });
  }

  // Sanitize prompt before sending to model — this is untrusted text from
  // the client. sanitizer.sanitizeText strips HTML and clamps length.
  var prompt = sanitizer.sanitizeText(String(promptRaw), PROMPT_MAX);

  try {
    // Auth
    var token = pageToken.getTokenFromRequest(req, 'onboarding');
    var actor;
    if (token && token.contact_id === contactId) {
      actor = 'client';
    } else {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
      actor = (admin.role === 'internal' || admin.role === 'agent') ? 'system' : 'admin';
    }

    var contact = await sb.one(
      'contacts?id=eq.' + encodeURIComponent(contactId) +
      '&select=id,slug,practice_name,first_name,last_name,city,state_province,lost,status&limit=1'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost === true || contact.status === 'lost') {
      return res.status(403).json({ error: 'Contact not active' });
    }

    var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
    var practiceSlug = slugify(practiceName || contact.slug);

    // Build the wrapped prompt: client's prompt + universal style guards
    var wrappedPrompt = wrapPromptForTherapyContext(prompt);

    // 1. Call Gemini (primary model, then fallback on failure)
    var geminiResp = await callGemini(MODEL_PRIMARY, wrappedPrompt, GOOGLE_KEY);
    if (!geminiResp.ok) {
      var firstErr = await geminiResp.text();
      geminiResp = await callGemini(MODEL_FALLBACK, wrappedPrompt, GOOGLE_KEY);
      if (!geminiResp.ok) {
        var secondErr = await geminiResp.text();
        monitor.logError('generate-pool-image', new Error('Both Gemini models failed'), {
          client_slug: contact.slug,
          detail: { stage: 'gemini', primary: firstErr.substring(0, 200), fallback: secondErr.substring(0, 200) },
        });
        return res.status(502).json({ error: 'Image generation unavailable' });
      }
    }

    var geminiData = await geminiResp.json();

    // 2. Extract image bytes
    var imageData = null;
    var mimeType = 'image/png';
    if (geminiData.candidates && geminiData.candidates[0] && geminiData.candidates[0].content) {
      var parts = geminiData.candidates[0].content.parts || [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].inlineData) {
          imageData = parts[i].inlineData.data;
          mimeType = parts[i].inlineData.mimeType || 'image/png';
          break;
        }
      }
    }
    if (!imageData) {
      return res.status(502).json({ error: 'Model returned no image' });
    }

    var imgBuffer = Buffer.from(imageData, 'base64');
    var ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
    var shortId = crypto.randomBytes(3).toString('hex');
    var filename = (practiceSlug + '-generated-' + shortId + '.' + ext).toLowerCase();
    var storagePath = contact.slug + '/pool/' + filename;

    // 3. Upload to Storage
    var SB_URL = sb.url();
    var SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    var upResp = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': mimeType,
        'x-upsert': 'true',
      },
      body: imgBuffer,
    });
    if (!upResp.ok) {
      var upErr = await upResp.text();
      return res.status(502).json({ error: 'Storage upload failed', detail: upErr.substring(0, 200) });
    }

    // 4. Create pool row, marked upload-complete for cron pickup
    var poolRow = await sb.mutate('client_image_pool', 'POST', {
      contact_id: contactId,
      client_slug: contact.slug,
      category: category,
      source_type: 'generated',
      source_ref: prompt.substring(0, 200),
      storage_path: storagePath,
      hosted_url: '',
      filename: filename,
      mime_type: mimeType,
      bytes: imgBuffer.length,
      status: 'pending',
      uploaded_by: actor,
      metadata_json: {
        prompt: prompt,
        wrapped_prompt: wrappedPrompt,
        model: MODEL_PRIMARY,
        original_filename: filename,
        upload_complete_at: new Date().toISOString(),
        origin: 'ai_generated',
        is_draft: asDraft,
      },
    }, 'return=representation');
    var pool = Array.isArray(poolRow) ? poolRow[0] : poolRow;
    if (!pool || !pool.id) {
      return res.status(500).json({ error: 'Pool row insert returned empty' });
    }

    return res.status(200).json({
      pool_id: pool.id,
      status: 'pending',
      processing: true,
      bytes: imgBuffer.length,
    });

  } catch (err) {
    monitor.logError('generate-pool-image', err, { detail: { stage: 'handler' } });
    return res.status(500).json({ error: 'Image generation failed' });
  }
};

// ── helpers ──────────────────────────────────────────────────

async function callGemini(model, prompt, key) {
  return fetch(GEMINI_API + '/' + model + ':generateContent?key=' + key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
}

// Wrap user prompt with universal therapy-context style guards.
// Keeps photographic, no-text, no-faces output across all generations.
function wrapPromptForTherapyContext(userPrompt) {
  return [
    userPrompt,
    '',
    'Style: photorealistic, professional healthcare aesthetic, warm and inviting.',
    'No text, no logos, no clearly visible faces of identifiable people.',
    'Color palette should feel calming and trustworthy.',
    'High resolution, suitable for a therapy practice website.',
  ].join('\n');
}

function slugify(s) {
  return String(s || 'practice').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .substring(0, 40) || 'practice';
}
