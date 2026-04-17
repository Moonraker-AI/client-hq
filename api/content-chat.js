// /api/content-chat.js
// Streaming chat endpoint for the content preview chatbot (client-facing).
// Uses Claude Opus 4.6 with context of the page HTML, design spec, and practice info.
// Supports content editing: when the client requests a change, Claude returns the
// updated HTML which gets saved to content_pages + versioned.
//
// POST { messages: [...], context: { content_page_id, slug } }
//
// The response is SSE (same as proposal-chat), piped directly from Anthropic.
// The client-side chatbot parses the full response and, if it contains an HTML update,
// sends a follow-up POST to /api/action to save it.

var sb = require('./_lib/supabase');
var rateLimit = require('./_lib/rate-limit');
var sanitizer = require('./_lib/html-sanitizer');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://clients.moonraker.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Origin validation: block cross-origin abuse (protects Anthropic API credits).
  // Empty Origin is now rejected (H15) — curl and non-browser callers that
  // strip the header previously bypassed the check.
  var origin = req.headers.origin || '';
  if (!origin || origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Rate limit: 20 req/min per IP (protects Anthropic API credits)
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':content-chat', 20, 60);
  rateLimit.setHeaders(res, rl, 20);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again.' });
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  var messages = req.body && req.body.messages;
  var context = (req.body && req.body.context) || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Fetch page data from Supabase
  var pageData = null;
  var contactData = null;
  var specData = null;
  var contentPageId = context.content_page_id || '';

  // H12: validate UUID format before any PostgREST concat. Rejects
  // arbitrary strings that would otherwise flow into '?id=eq.<value>'.
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (contentPageId && !uuidPattern.test(contentPageId)) {
    return res.status(400).json({ error: 'Invalid content_page_id' });
  }

  if (contentPageId) {
    // H12 ownership + M14 fail-loud: fetchPageContext now throws on
    // Supabase error (503) and returns null when the page does not
    // exist OR when the owning contact is lost (404, no existence
    // oracle between the two cases).
    try {
      var fetched = await fetchPageContext(contentPageId);
      if (!fetched) {
        return res.status(404).json({ error: 'Content page not found' });
      }
      pageData = fetched.page;
      contactData = fetched.contact;
      specData = fetched.spec;
    } catch (e) {
      console.error('[content-chat] fetchPageContext error:', e && e.message);
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }

  var systemPrompt = buildSystemPrompt(pageData, contactData, specData);

  // Call Anthropic with streaming
  var aiResp;
  try {
    aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: messages,
        stream: true
      })
    });
  } catch(e) {
    return res.status(500).json({ error: 'Failed to reach Anthropic API' });
  }

  if (!aiResp.ok) {
    var errBody = await aiResp.text();
    return res.status(aiResp.status).json({ error: 'Anthropic API error', status: aiResp.status });
  }

  // Stream: pipe raw Anthropic SSE bytes directly
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  var reader = aiResp.body.getReader();
  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      res.write(chunk.value);
    }
  } catch(e) {
    // Stream error, close gracefully
  }

  res.end();
};


// ─── Fetch page + contact + spec from Supabase ────────────────
// Returns:
//   - the full {page, contact, spec, practice} bundle on success
//   - null when the content page does not exist OR when the owning contact
//     is lost (caller 404s, no oracle for distinguishing)
// Throws on Supabase misconfiguration or non-ok HTTP — caller maps to 503.
async function fetchPageContext(contentPageId) {
  if (!sb.isConfigured()) {
    throw new Error('Supabase not configured');
  }
  var headers = sb.headers();
  // Defense-in-depth: contentPageId is already UUID-validated upstream,
  // but encode anyway — keeps the PostgREST URL well-formed if the
  // validation ever loosens.
  var encodedId = encodeURIComponent(contentPageId);

  // Get content page
  var cpResp = await fetch(
    sb.url() + '/rest/v1/content_pages?id=eq.' + encodedId + '&limit=1',
    { headers: headers }
  );
  if (!cpResp.ok) {
    throw new Error('content_pages fetch failed: ' + cpResp.status);
  }
  var pages = await cpResp.json();
  if (!pages || pages.length === 0) return null;
  var page = pages[0];

  // Get contact, design spec, and practice details in parallel
  var encodedContactId = encodeURIComponent(page.contact_id);
  var results = await Promise.all([
    fetch(sb.url() + '/rest/v1/contacts?id=eq.' + encodedContactId + '&limit=1', { headers: headers }).then(function(r) {
      if (!r.ok) throw new Error('contacts fetch failed: ' + r.status);
      return r.json();
    }),
    fetch(sb.url() + '/rest/v1/design_specs?contact_id=eq.' + encodedContactId + '&limit=1', { headers: headers }).then(function(r) {
      if (!r.ok) throw new Error('design_specs fetch failed: ' + r.status);
      return r.json();
    }),
    fetch(sb.url() + '/rest/v1/practice_details?contact_id=eq.' + encodedContactId + '&limit=1', { headers: headers }).then(function(r) {
      if (!r.ok) throw new Error('practice_details fetch failed: ' + r.status);
      return r.json();
    })
  ]);

  var contact = (results[0] && results[0][0]) || null;

  // Ownership gate: don't stream Claude content about lost contacts.
  // Check both `lost` boolean and `status` — a client can be status='active'
  // and lost=true simultaneously. Return null (not throw) so caller 404s.
  if (!contact || contact.lost === true || contact.status === 'lost') {
    return null;
  }

  return {
    page: page,
    contact: contact,
    spec: (results[1] && results[1][0]) || null,
    practice: (results[2] && results[2][0]) || null
  };
}


// ─── System prompt ─────────────────────────────────────────────
function buildSystemPrompt(page, contact, spec) {
  var practiceName = sanitizer.sanitizeText((contact && contact.practice_name) || 'the practice', 200);
  var therapistName = contact ? sanitizer.sanitizeText(((contact.first_name || '') + ' ' + (contact.last_name || '')).trim(), 200) : '';

  var prompt = `You are a helpful content assistant for ${practiceName}. You are helping the practice owner review and refine their new web page before it goes live.

YOUR ROLE:
- You help the client understand what is on the page and answer questions about the content
- You can suggest and make specific content edits when requested
- You are warm, professional, and supportive
- You explain things in simple, non-technical language

CONTENT EDITING:
When the client requests a change to the page content (like updating text, changing wording, removing a section, updating their insurance list, fixing a detail), you should:

1. Acknowledge their request
2. Explain the change you will make
3. Include the updated HTML in your response wrapped in a special tag: <content_update>...full updated HTML...</content_update>
4. The HTML inside <content_update> must be the COMPLETE page HTML (not a fragment). The client's preview will replace the entire page with this content.

IMPORTANT EDITING RULES:
- Never remove crisis disclaimers
- Never remove or modify schema/structured data (<script type="application/ld+json">)
- Never add unverified claims about the practitioner
- Never use emdashes. Use commas, periods, or colons instead.
- Keep the same overall page structure, styling, and section order unless specifically asked to change it
- Only modify the specific content the client requested
- If a request is unclear, ask for clarification before making changes`;

  if (spec && spec.voice_dna) {
    prompt += `\n\nVOICE DNA (match this style for any new or edited text):
- Tone: ${spec.voice_dna.tone || 'professional and warm'}
- Rhythm: ${spec.voice_dna.sentence_rhythm || 'mixed'}
- Emotional register: ${spec.voice_dna.emotional_register || 'empathetic'}`;
  }

  prompt += `\n\nPAGE CONTEXT:
- Page type: ${page ? page.page_type : 'unknown'}
- Page name: ${page ? page.page_name : 'unknown'}
- Practice: ${practiceName}`;
  if (therapistName) prompt += `\n- Therapist: ${therapistName}`;
  if (contact && contact.city) prompt += `\n- Location: ${sanitizer.sanitizeText(contact.city, 100)}, ${sanitizer.sanitizeText(contact.state_province || '', 100)}`;

  // Include current HTML summary (not the full HTML, that comes in the user messages from the chatbot)
  if (page && page.generated_html) {
    // Extract text-only summary for context (first 2000 chars of visible text)
    var textOnly = page.generated_html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
    prompt += '\n\nCURRENT PAGE CONTENT SUMMARY (first 2000 chars):\n' + textOnly.substring(0, 2000);
  }

  return prompt;
}
