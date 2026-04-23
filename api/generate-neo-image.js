// /api/generate-neo-image.js
// Generates a unique AI image using Gemini (Nano Banana) for a content page.
// Uploads to Supabase Storage, creates neo_images record.
//
// POST body: { content_page_id?, contact_id, prompt?, image_name? }
// If no prompt, generates one from the keyword + practice context.

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

var GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
var MODEL = 'gemini-2.0-flash-preview-image-generation';
var BUCKET = 'images';

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var GOOGLE_KEY = process.env.GOOGLE_API_KEY;
  if (!GOOGLE_KEY) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  try {
    // 1. Fetch contact
    var contact = await sb.one('contacts?id=eq.' + encodeURIComponent(contactId) + '&select=id,slug,practice_name,first_name,last_name,city,state_province&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    var slug = contact.slug;
    var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
    var location = [contact.city, contact.state_province].filter(Boolean).join(', ');

    // 2. Build prompt
    var prompt = body.prompt;
    if (!prompt) {
      // Fetch content page for keyword context
      var keyword = '';
      if (body.content_page_id) {
        var cp = await sb.one('content_pages?id=eq.' + encodeURIComponent(body.content_page_id) + '&select=target_keyword,page_name&limit=1');
        if (cp) keyword = cp.target_keyword || cp.page_name || '';
      }
      prompt = buildPrompt(keyword, practiceName, location);
    }

    var imageName = body.image_name || ('neo-' + (body.content_page_id ? body.content_page_id.substring(0, 8) : Date.now()));

    // 3. Call Gemini
    var geminiResp = await fetch(GEMINI_API + '/' + MODEL + ':generateContent?key=' + GOOGLE_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE']
        }
      })
    });

    if (!geminiResp.ok) {
      var errText = await geminiResp.text();
      // Try fallback model
      geminiResp = await fetch(GEMINI_API + '/nano-banana-pro-preview:generateContent?key=' + GOOGLE_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
          }
        })
      });
      if (!geminiResp.ok) {
        var err2 = await geminiResp.text();
        return res.status(502).json({ error: 'Gemini API failed', detail: (errText + ' / ' + err2).substring(0, 400) });
      }
    }

    var geminiData = await geminiResp.json();

    // 4. Extract image from response
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
      return res.status(502).json({
        error: 'No image in Gemini response',
        detail: JSON.stringify(geminiData).substring(0, 500)
      });
    }

    // 5. Decode image
    var imgBuffer = Buffer.from(imageData, 'base64');
    var ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
    var storagePath = slug + '/neo/' + imageName + '.' + ext;

    // 6. Upload to Supabase Storage
    var SB_URL = sb.url();
    var SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    var uploadResp = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': mimeType,
        'x-upsert': 'true'
      },
      body: imgBuffer
    });

    if (!uploadResp.ok) {
      var uploadErr = await uploadResp.text();
      return res.status(500).json({ error: 'Storage upload failed', detail: uploadErr.substring(0, 200) });
    }

    var hostedUrl = 'https://clients.moonraker.ai/' + slug + '/img/neo/' + imageName + '.' + ext;

    // 7. Create neo_images record
    var neoData = {
      contact_id: contactId,
      client_slug: slug,
      image_name: imageName,
      hosted_url: hostedUrl,
      source_url: null,
      metadata: { prompt: prompt, content_page_id: body.content_page_id || null, model: MODEL, generated_at: new Date().toISOString() }
    };

    var neoResult = await sb.mutate('neo_images', 'POST', neoData, 'return=representation');
    var neoRow = Array.isArray(neoResult) ? neoResult[0] : neoResult;

    return res.status(200).json({
      success: true,
      neo_image: neoRow,
      hosted_url: hostedUrl,
      prompt: prompt,
      image_size: imgBuffer.length
    });

  } catch (err) {
    console.error('generate-neo-image error:', err);
    monitor.logError('generate-neo-image', err, {
      client_slug: (typeof slug !== 'undefined' ? slug : null),
      detail: { stage: 'generate_handler' }
    });
    return res.status(500).json({ error: 'Failed to generate image' });
  }
};

function buildPrompt(keyword, practiceName, location) {
  var themes = [
    'a serene therapy office with warm natural light, comfortable furniture, and calming earth tones',
    'a peaceful wellness space with plants, soft textures, and a sense of safety',
    'an inviting counseling room with modern minimal design, warm wood accents, and gentle lighting',
    'a tranquil healing environment with soft colors, natural materials, and a feeling of hope',
    'a professional yet warm therapy setting with cozy seating, ambient light, and mindful decor'
  ];
  var theme = themes[Math.floor(Math.random() * themes.length)];

  var prompt = 'Create a professional, high-quality photograph-style image for a therapy practice website. ';
  prompt += 'The image should depict ' + theme + '. ';
  if (keyword) {
    prompt += 'The image relates to ' + keyword + ' services. ';
  }
  prompt += 'Style: warm, inviting, professional healthcare aesthetic. ';
  prompt += 'No text, no logos, no people\'s faces clearly visible. ';
  prompt += 'Photorealistic, high resolution, suitable for a medical/therapy website hero section. ';
  prompt += 'Color palette should feel calming and trustworthy.';

  return prompt;
}
