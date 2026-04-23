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
  var practiceData = null;
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
      practiceData = fetched.practice;
    } catch (e) {
      console.error('[content-chat] fetchPageContext error:', e && e.message);
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }

  var systemPrompt = buildSystemPrompt(pageData, contactData, specData, practiceData);

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
  // Defense-in-depth: contentPageId is already UUID-validated upstream,
  // but encode anyway — keeps the PostgREST URL well-formed if the
  // validation ever loosens.
  var encodedId = encodeURIComponent(contentPageId);

  // Get content page
  var page = await sb.one('content_pages?id=eq.' + encodedId + '&limit=1');
  if (!page) return null;

  // Get contact, design spec, and practice details in parallel
  var encodedContactId = encodeURIComponent(page.contact_id);
  var results = await Promise.all([
    sb.query('contacts?id=eq.' + encodedContactId + '&limit=1'),
    sb.query('design_specs?contact_id=eq.' + encodedContactId + '&limit=1'),
    sb.query('practice_details?contact_id=eq.' + encodedContactId + '&limit=1')
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
function buildSystemPrompt(page, contact, spec, practice) {
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

  // Structured practice details — the chatbot uses these as authoritative
  // answers for questions like "what insurances do you take", "what do you
  // treat", "do you offer consultations". Sanitize every field individually.
  if (practice) {
    var practiceLines = [];
    var arr = function(v, n) {
      if (!Array.isArray(v) || v.length === 0) return null;
      return v.map(function(x) { return sanitizer.sanitizeText(String(x || ''), 120); })
              .filter(Boolean).slice(0, n || 25).join(', ');
    };
    var txt = function(v, n) {
      if (!v) return null;
      var s = sanitizer.sanitizeText(String(v), n || 300);
      return s || null;
    };

    var specialties    = arr(practice.specialties, 25);
    var modalities     = arr(practice.modalities, 25);
    var populations    = arr(practice.populations, 25);
    var licensedStates = arr(practice.licensed_states, 60);
    var targetKeywords = arr(practice.target_keywords, 30);
    var associations   = arr(practice.associations, 20);

    if (practice.practice_type)            practiceLines.push('- Practice type: ' + txt(practice.practice_type, 100));
    if (practice.num_therapists)           practiceLines.push('- Number of therapists: ' + practice.num_therapists);
    if (specialties)                       practiceLines.push('- Specialties: ' + specialties);
    if (modalities)                        practiceLines.push('- Modalities: ' + modalities);
    if (populations)                       practiceLines.push('- Populations served: ' + populations);
    if (practice.issues_treated)           practiceLines.push('- Issues treated: ' + txt(practice.issues_treated, 800));
    if (practice.additional_services)      practiceLines.push('- Additional services: ' + txt(practice.additional_services, 500));
    if (practice.insurance_or_private_pay) practiceLines.push('- Insurance posture: ' + txt(practice.insurance_or_private_pay, 100));
    if (practice.insurance_panels)         practiceLines.push('- Insurance panels: ' + txt(practice.insurance_panels, 500));
    if (practice.session_cost)             practiceLines.push('- Session cost: ' + txt(practice.session_cost, 120));
    if (practice.session_frequency)        practiceLines.push('- Session frequency: ' + txt(practice.session_frequency, 120));
    if (practice.offers_consultation === true) {
      practiceLines.push('- Offers free consultation: yes' + (practice.consultation_length ? ' (' + txt(practice.consultation_length, 40) + ')' : ''));
    } else if (practice.offers_consultation === false) {
      practiceLines.push('- Offers free consultation: no');
    }
    if (licensedStates)                    practiceLines.push('- Licensed in: ' + licensedStates);
    if (practice.ideal_client)             practiceLines.push('- Ideal client: ' + txt(practice.ideal_client, 400));
    if (practice.differentiators)          practiceLines.push('- Differentiators: ' + txt(practice.differentiators, 500));
    if (practice.intake_process)           practiceLines.push('- Intake process: ' + txt(practice.intake_process, 400));
    if (practice.pronoun_usage)            practiceLines.push('- Pronoun usage: ' + txt(practice.pronoun_usage, 100));
    if (practice.content_to_omit)          practiceLines.push('- Content to OMIT (never include): ' + txt(practice.content_to_omit, 500));
    if (targetKeywords)                    practiceLines.push('- Target keywords: ' + targetKeywords);
    if (associations)                      practiceLines.push('- Professional associations: ' + associations);

    if (practiceLines.length > 0) {
      prompt += '\n\nPRACTICE DETAILS (authoritative — use for factual questions about specialties, insurance, services, and locations):\n'
        + practiceLines.join('\n');
    }
  }

  // Include current HTML excerpt (first 8000 chars of visible text)
  if (page && page.generated_html) {
    var textOnly = page.generated_html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
    prompt += '\n\nCURRENT PAGE CONTENT SUMMARY (first 8000 chars):\n' + textOnly.substring(0, 8000);
  }

  return prompt;
}
