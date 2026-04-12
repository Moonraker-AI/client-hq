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

  if (contentPageId) {
    var fetched = await fetchPageContext(contentPageId);
    pageData = fetched.page;
    contactData = fetched.contact;
    specData = fetched.spec;
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
async function fetchPageContext(contentPageId) {
  if (!sb.isConfigured()) return { page: null, contact: null, spec: null };
  var headers = sb.headers();

  try {
    // Get content page
    var cpResp = await fetch(
      sb.url() + '/rest/v1/content_pages?id=eq.' + contentPageId + '&limit=1',
      { headers: headers }
    );
    var pages = await cpResp.json();
    if (!pages || pages.length === 0) return { page: null, contact: null, spec: null };
    var page = pages[0];

    // Get contact and design spec in parallel
    var results = await Promise.all([
      fetch(sb.url() + '/rest/v1/contacts?id=eq.' + page.contact_id + '&limit=1', { headers: headers }).then(function(r) { return r.json(); }),
      fetch(sb.url() + '/rest/v1/design_specs?contact_id=eq.' + page.contact_id + '&limit=1', { headers: headers }).then(function(r) { return r.json(); }),
      fetch(sb.url() + '/rest/v1/practice_details?contact_id=eq.' + page.contact_id + '&limit=1', { headers: headers }).then(function(r) { return r.json(); })
    ]);

    return {
      page: page,
      contact: (results[0] && results[0][0]) || null,
      spec: (results[1] && results[1][0]) || null,
      practice: (results[2] && results[2][0]) || null
    };
  } catch(e) {
    return { page: null, contact: null, spec: null };
  }
}


// ─── System prompt ─────────────────────────────────────────────
function buildSystemPrompt(page, contact, spec) {
  var practiceName = (contact && contact.practice_name) || 'the practice';
  var therapistName = contact ? ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() : '';

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
  if (contact && contact.city) prompt += `\n- Location: ${contact.city}, ${contact.state_province || ''}`;

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
