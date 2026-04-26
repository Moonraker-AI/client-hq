// /api/page-stages/extract-contract.js
// Runs after a homepage page reaches status='ready_for_contract'. Distills
// the chain output into a client_design_contracts row that subsequent pages
// must conform to.
//
// POST body: { content_page_id }
// Response: { success: true, contract: <row>, content_page_id, next_status: 'ready_for_client' }
//
// Auth: admin JWT or CRON_SECRET.
//
// Behavior:
// - Validates the page is page_type='homepage' and status='ready_for_contract'.
// - Reads the page's current generated_html (post-chain), design_specs, and
//   the most recent accepted page_stage_runs for context.
// - Calls Claude with a tight extraction schema. Claude does not rewrite HTML
//   here — it only inspects and reports. Output is structured JSON.
// - Marks any prior active contract for the same contact as 'superseded',
//   inserts the new contract as 'active'. (Schema enforces one active per
//   contact via the EXCLUDE constraint.)
// - Transitions content_pages.status: ready_for_contract → ready_for_client.

var auth     = require('../_lib/auth');
var sb       = require('../_lib/supabase');
var monitor  = require('../_lib/monitor');
var fetchT   = require('../_lib/fetch-with-timeout');

var CLAUDE_MODEL = 'claude-sonnet-4-6';
var EXTRACT_TIMEOUT_MS = 240000;
var MAX_OUTPUT_TOKENS = 4096;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  var body = req.body || {};
  var contentPageId = body.content_page_id;
  if (!contentPageId) return res.status(400).json({ error: 'content_page_id required' });

  try {
    // 1. Load the page and validate state.
    var page = await sb.one(
      'content_pages?id=eq.' + contentPageId +
      '&select=id,contact_id,client_slug,page_type,page_name,status,generated_html&limit=1'
    );
    if (!page) return res.status(404).json({ error: 'content_page not found' });
    if (page.page_type !== 'homepage') {
      return res.status(400).json({ error: 'extract-contract only operates on homepage rows' });
    }
    if (page.status !== 'ready_for_contract') {
      return res.status(409).json({
        error: 'page must be in status ready_for_contract (got: ' + page.status + ')'
      });
    }
    if (!page.generated_html || page.generated_html.length < 500) {
      return res.status(400).json({ error: 'page has no usable generated_html' });
    }

    // 2. Load design_specs and chain run summaries for context.
    var designSpec = null;
    if (page.contact_id) {
      designSpec = await sb.one(
        'design_specs?contact_id=eq.' + page.contact_id +
        '&select=typography,color_palette,voice_dna&limit=1'
      );
    }

    var runs = await sb.query(
      'page_stage_runs?content_page_id=eq.' + contentPageId +
      '&accepted_at=not.is.null&rejected_at=is.null' +
      '&order=accepted_at.asc' +
      '&select=stage,diff_summary,findings_summary'
    );

    // 3. Build extraction prompt.
    var systemPrompt = buildSystemPrompt();
    var userMessage = buildUserMessage({
      page: page,
      designSpec: designSpec,
      runs: runs || []
    });

    // 4. Call Claude.
    var startedAt = Date.now();
    var resp = await fetchT('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    }, EXTRACT_TIMEOUT_MS);

    var durationMs = Date.now() - startedAt;

    if (!resp.ok) {
      var errText = '';
      try { errText = await resp.text(); } catch (e) {}
      monitor.logError('extract-contract', new Error('Anthropic ' + resp.status), {
        detail: { content_page_id: contentPageId, status: resp.status, body: errText.slice(0, 500) }
      });
      return res.status(502).json({ error: 'Claude API error', status: resp.status });
    }

    var claudeData = await resp.json();
    var responseText = '';
    if (claudeData.content && claudeData.content.length > 0) {
      responseText = claudeData.content[0].text || '';
    }
    var clean = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    var extracted;
    try {
      extracted = JSON.parse(clean);
    } catch (parseErr) {
      monitor.logError('extract-contract', new Error('parse error'), {
        detail: { content_page_id: contentPageId, raw: responseText.slice(0, 800) }
      });
      return res.status(500).json({
        error: 'Failed to parse contract extraction',
        raw: responseText.slice(0, 1000)
      });
    }

    // 5. Validate required keys.
    var requiredKeys = ['tokens', 'voice', 'components', 'copy_conventions', 'source_brief'];
    for (var i = 0; i < requiredKeys.length; i++) {
      if (!extracted[requiredKeys[i]]) {
        return res.status(500).json({
          error: 'Incomplete contract extraction (missing: ' + requiredKeys[i] + ')',
          extracted: extracted
        });
      }
    }

    var nowIso = new Date().toISOString();

    // 6. Mark any prior active contract for this contact as superseded.
    await sb.mutate(
      'client_design_contracts?contact_id=eq.' + page.contact_id +
      '&status=eq.active',
      'PATCH',
      { status: 'superseded', updated_at: nowIso },
      'return=minimal'
    ).catch(function(e) {
      // Non-fatal — likely no prior contract.
      console.log('[extract-contract] no prior contract to supersede:', e.message);
    });

    // 7. Insert the new contract.
    var insertBody = {
      contact_id: page.contact_id,
      client_slug: page.client_slug,
      homepage_content_page_id: contentPageId,
      tokens: extracted.tokens,
      voice: extracted.voice,
      components: extracted.components,
      copy_conventions: extracted.copy_conventions,
      source_brief: extracted.source_brief,
      source_html: page.generated_html.slice(0, 200000),  // defensive cap
      status: 'active'
    };
    var contractInsert = await sb.mutate(
      'client_design_contracts',
      'POST',
      insertBody,
      'return=representation'
    );
    if (!contractInsert || !contractInsert[0]) {
      return res.status(500).json({ error: 'Failed to insert contract' });
    }

    // 8. Transition the page to ready_for_client.
    await sb.mutate(
      'content_pages?id=eq.' + contentPageId,
      'PATCH',
      { status: 'ready_for_client', updated_at: nowIso },
      'return=minimal'
    );

    return res.status(200).json({
      success: true,
      contract: contractInsert[0],
      content_page_id: contentPageId,
      next_status: 'ready_for_client',
      duration_ms: durationMs
    });
  } catch (e) {
    monitor.logError('extract-contract', e, { detail: { content_page_id: contentPageId } });
    return res.status(500).json({ error: 'Contract extraction failed', detail: e.message });
  }
};

function buildSystemPrompt() {
  return [
    'You are extracting a "design contract" from a Moonraker AI client homepage that has just completed the audit→critique→polish→harden→clarify chain.',
    '',
    'The contract you produce will be used to constrain every subsequent page generated for this client. Subsequent pages must inherit these tokens, voice patterns, component shapes, and copy conventions exactly. Anything you put in the contract is locked for the rest of this client\'s page buildout.',
    '',
    'Be specific. "Use a warm tone" is not a contract; "First-person (I/you), short declarative sentences (avg 14 words), occasional one-word emphasis, never em-dashes" is a contract.',
    '',
    'Return ONLY valid JSON, no markdown fences, matching this exact shape:',
    '',
    '{',
    '  "tokens": {',
    '    "color_palette": { "primary": "#hex", "secondary": "#hex", "accent": "#hex", "background": "#hex", "surface": "#hex", "heading_text": "#hex", "body_text": "#hex", "muted_text": "#hex", "cta_background": "#hex", "cta_text": "#hex" },',
    '    "typography": { "heading_font": "string", "body_font": "string", "heading_weights": [int], "body_weights": [int], "heading_scale": { "h1": "rem", "h2": "rem", "h3": "rem", "h4": "rem" }, "body_size": "rem", "line_height": "string" },',
    '    "spacing_scale": ["string", "..."],',
    '    "radii": { "card": "string", "button": "string", "input": "string" }',
    '  },',
    '  "voice": {',
    '    "person": "first|second|third",',
    '    "tone_descriptors": ["string", "..."],',
    '    "sentence_shape": "string",',
    '    "vocabulary_patterns": ["string", "..."],',
    '    "vocabulary_avoid": ["string", "..."],',
    '    "punctuation_rules": ["string", "..."]',
    '  },',
    '  "components": {',
    '    "hero": { "shape": "string description", "primary_cta_style": "string", "image_treatment": "string" },',
    '    "service_cards": { "layout": "string", "fields": ["string", "..."], "icon_use": "string" },',
    '    "bio_section": { "layout": "string", "length_range": "string", "photo_treatment": "string" },',
    '    "testimonials": { "layout": "string", "attribution_style": "string" },',
    '    "faq": { "layout": "string", "expansion": "string" },',
    '    "footer": { "structure": "string", "tone": "string" }',
    '  },',
    '  "copy_conventions": {',
    '    "primary_cta_phrase": "string — exact phrasing for the primary CTA across the site",',
    '    "service_naming": "string — how services are referred to",',
    '    "session_naming": "string",',
    '    "capitalization": "title_case|sentence_case",',
    '    "headline_pattern": "string — pattern for H1 across pages",',
    '    "key_terms_locked": [ { "term": "string", "definition": "string" } ]',
    '  },',
    '  "source_brief": {',
    '    "audience_description": "string — who the client serves, in plain English",',
    '    "differentiators": ["string", "..."],',
    '    "credentialing_emphasis": "string",',
    '    "geographic_focus": "string",',
    '    "tone_summary": "string"',
    '  }',
    '}',
    '',
    'Inspect the homepage HTML carefully. Where multiple values appear, pick the one that occurs most often or is clearly intended as canonical (post-polish, the page should be internally consistent). Where the homepage shows a deliberate choice (e.g. always using "free consultation" not "intro session"), lock it in copy_conventions.key_terms_locked.',
    '',
    'Therapist audience: warm, plain English. No em-dashes. Voice and copy conventions you extract should preserve these defaults unless the homepage clearly establishes something else.'
  ].join('\n');
}

function buildUserMessage(opts) {
  var parts = [];
  parts.push('## Client');
  parts.push('- Slug: ' + opts.page.client_slug);
  parts.push('- Page: ' + opts.page.page_name + ' (homepage)');

  if (opts.designSpec) {
    parts.push('\n## Captured design spec (reference, may differ from final homepage)');
    parts.push('```json\n' + JSON.stringify({
      typography: opts.designSpec.typography,
      color_palette: opts.designSpec.color_palette,
      voice_dna: opts.designSpec.voice_dna
    }, null, 2) + '\n```');
  }

  if (opts.runs && opts.runs.length > 0) {
    parts.push('\n## Chain history (each stage\'s diff summary)');
    opts.runs.forEach(function(r) {
      parts.push('- **' + r.stage + '**: ' + (r.diff_summary || '(no summary)'));
    });
  }

  parts.push('\n## Final homepage HTML (post-chain, this is what the contract reflects)');
  parts.push('```html\n' + opts.page.generated_html + '\n```');

  parts.push('\nReturn ONLY the JSON contract object. No other text.');
  return parts.join('\n');
}
