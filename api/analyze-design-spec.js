// /api/analyze-design-spec.js — Analyze client website design via Claude
// Takes raw CSS + optional sample content + site URL
// Returns structured design tokens (typography, colors, layout, voice DNA)
// Uses Sonnet 4.6 (non-streaming, structured JSON output)

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var contrast = require('./_lib/contrast');

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

  // 2026-04-26: dual-pathway auth so audit cycles and post-capture
  // automation can invoke this without an admin JWT in the browser.
  // Admin UI flow is unchanged (cookie-based admin JWT).
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }


  try {
    var body = req.body;
    var contactId = body.contact_id;
    var clientSlug = body.client_slug;
    var rawCss = body.raw_css || '';
    var sampleContent = body.sample_content || '';
    var computedCss = body.computed_css || null;
    var screenshotUrls = body.screenshot_urls || [];
    var siteUrl = body.site_url || '';
    var platform = body.platform || '';
    var existingSpecId = body.existing_spec_id || null;
    var source = body.source || 'manual';

    if (!contactId || !clientSlug) {
      return res.status(400).json({ error: 'contact_id and client_slug required' });
    }

    if (!rawCss && !sampleContent && !computedCss) {
      return res.status(400).json({ error: 'Provide CSS data or sample content for analysis' });
    }

    // Build the analysis prompt
    var systemPrompt = `You are a web design analyst for Moonraker AI, a digital marketing agency serving therapy practices. Your job is to analyze a client's website CSS and content to produce a structured Design Language Summary that will be used to build new pages matching their existing style.

You must return ONLY valid JSON with no other text, no markdown, no backticks. The JSON must match this exact structure:

{
  "typography": {
    "heading_font": "font family name",
    "body_font": "font family name",
    "heading_weights": [700, 600],
    "body_weights": [400, 500],
    "heading_sizes": { "h1": "2.5rem", "h2": "1.75rem", "h3": "1.25rem" },
    "body_size": "1rem",
    "line_height": "1.6"
  },
  "color_palette": {
    "primary": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": "#hex",
    "surface": "#hex",
    "heading_text": "#hex",
    "body_text": "#hex",
    "muted_text": "#hex",
    "cta_background": "#hex",
    "cta_text": "#hex",
    "section_alternating": ["#hex1", "#hex2"]
  },
  "layout_patterns": {
    "max_width": "1200px",
    "section_padding": "60px 24px",
    "mobile_padding": "40px 16px",
    "card_radius": "12px",
    "grid_gap": "2rem",
    "image_treatment": "rounded corners / full bleed / contained",
    "section_style": "alternating backgrounds / cards / minimal"
  },
  "button_styles": {
    "shape": "rounded / pill / square",
    "radius": "8px",
    "padding": "12px 24px",
    "font_weight": "600",
    "text_transform": "none / uppercase",
    "hover_effect": "darken / lighten / shadow"
  },
  "voice_dna": {
    "tone": "warm / clinical / casual / professional",
    "sentence_rhythm": "short and direct / flowing / mixed",
    "metaphor_style": "nature / journey / growth / minimal",
    "emotional_register": "empathetic / authoritative / nurturing / balanced",
    "punctuation_habits": "em dashes / ellipses / minimal / standard",
    "forbidden_patterns": ["list any patterns to avoid"],
    "person_perspective": "first / second / third / mixed"
  },
  "summary_text": "A 3-5 paragraph human-readable Design Language Summary covering the overall aesthetic personality, key design decisions, and voice characteristics. This summary will be referenced by content builders."
}

Important rules:
- Extract actual values from the CSS provided, do not guess or use defaults
- If a value cannot be determined from the CSS, use your best inference and note it in the summary
- For voice_dna, analyze the sample content carefully for patterns
- If no sample content is provided, set voice_dna values to "unknown" and note this in the summary
- The summary_text should be warm and descriptive, written for a human reader
- Never use emdashes in the summary_text. Use commas, periods, or colons instead
- Platform context matters: Wix sites need fully explicit styles, WordPress/Squarespace use hybrid styling`;

    var userMessage = 'Analyze this client website and produce the design spec JSON.\n\n';

    if (source === 'automated_capture') {
      userMessage += 'NOTE: This data was automatically captured from the live website using Playwright (getComputedStyle + content extraction). The CSS data is structured and reliable.\n\n';
    }

    if (platform) {
      userMessage += 'PLATFORM: ' + platform + '\n';
    }
    if (siteUrl) {
      userMessage += 'SITE URL: ' + siteUrl + '\n';
    }
    userMessage += '\n';

    if (computedCss) {
      userMessage += '--- COMPUTED CSS (extracted via getComputedStyle) ---\n';
      if (computedCss.allFonts) userMessage += 'FONTS FOUND: ' + computedCss.allFonts.join(', ') + '\n';
      if (computedCss.allColors) userMessage += 'COLORS FOUND: ' + computedCss.allColors.join(', ') + '\n';
      if (computedCss.bodyBackground) userMessage += 'BODY BACKGROUND: ' + computedCss.bodyBackground + '\n';
      var elements = ['h1', 'h2', 'h3', 'p', 'a', 'button', 'nav', 'footer', 'body'];
      elements.forEach(function(el) {
        if (computedCss[el]) {
          var s = computedCss[el];
          userMessage += el.toUpperCase() + ': font=' + (s.fontFamily || '?') + ', size=' + (s.fontSize || '?') + ', weight=' + (s.fontWeight || '?') + ', color=' + (s.color || '?') + ', bg=' + (s.backgroundColor || 'transparent') + '\n';
        }
      });
      userMessage += '\n';
    } else if (rawCss) {
      userMessage += '--- RAW CSS / COMPUTED STYLES ---\n' + rawCss.substring(0, 15000) + '\n\n';
    }

    if (sampleContent) {
      userMessage += '--- WEBSITE CONTENT (for voice/tone analysis) ---\n' + sampleContent.substring(0, 12000) + '\n\n';
    }

    if (screenshotUrls.length > 0) {
      userMessage += '--- SCREENSHOT REFERENCES ---\n';
      screenshotUrls.forEach(function(url) {
        userMessage += '- ' + url + '\n';
      });
      userMessage += '(Full-page screenshots captured from the live site.)\n\n';
    }

    userMessage += 'Return ONLY the JSON object. No other text.';

    // Call Claude (non-streaming)
    var anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!anthropicRes.ok) {
      var errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      return res.status(502).json({ error: 'Claude API error', status: anthropicRes.status });
    }

    var claudeData = await anthropicRes.json();
    var responseText = '';
    if (claudeData.content && claudeData.content.length > 0) {
      responseText = claudeData.content[0].text || '';
    }

    // Parse the JSON response
    var cleanJson = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var spec = null;
    try {
      spec = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error('Failed to parse Claude response as JSON:', parseErr.message);
      console.error('Raw response:', responseText.substring(0, 500));
      return res.status(500).json({ error: 'Failed to parse design analysis', raw: responseText.substring(0, 1000) });
    }

    // Validate required fields exist
    if (!spec.typography || !spec.color_palette || !spec.summary_text) {
      return res.status(500).json({ error: 'Incomplete design analysis', spec: spec });
    }

    // 2026-04-26: clamp palette text colors to AA contrast before persisting.
    // Source palettes captured from real client sites frequently fail WCAG
    // (e.g. Mark O'Brien's #9ea7a7 muted text is 2.4:1 on his cream
    // background). Without this, every page rendered against design_specs
    // inherits the failure. Helper preserves hue + saturation, walks
    // lightness only. See api/_lib/contrast.js.
    var clampedPalette = contrast.clampPalette(spec.color_palette);
    if (clampedPalette && clampedPalette._contrast_clamp) {
      console.log('[analyze-design-spec] palette clamped for contact ' + contactId + ': ' + JSON.stringify(clampedPalette._contrast_clamp));
    }

    // Save to Supabase
    var specRecord = {
      contact_id: contactId,
      client_slug: clientSlug,
      typography: spec.typography,
      color_palette: clampedPalette,
      layout_patterns: spec.layout_patterns || {},
      button_styles: spec.button_styles || {},
      voice_dna: spec.voice_dna || {},
      raw_css: rawCss.substring(0, 50000),
      screenshots: screenshotUrls.length > 0 ? screenshotUrls : null,
      summary_text: spec.summary_text
    };

    var sbMethod, sbUrl;
    if (existingSpecId) {
      sbMethod = 'PATCH';
      sbUrl = sb.url() + '/rest/v1/design_specs?id=eq.' + existingSpecId;
    } else {
      sbMethod = 'POST';
      sbUrl = sb.url() + '/rest/v1/design_specs';
    }

    var sbRes = await fetch(sbUrl, {
      method: sbMethod,
      headers: sb.headers('return=representation'),
      body: JSON.stringify(specRecord)
    });

    if (!sbRes.ok) {
      var sbErr = await sbRes.text();
      console.error('Supabase save error:', sbRes.status, sbErr);
      // Still return the spec even if save fails
      return res.status(200).json({
        success: true,
        saved: false,
        save_error: sbErr,
        spec: spec,
        record: specRecord
      });
    }

    var savedData = await sbRes.json();
    var savedRecord = Array.isArray(savedData) ? savedData[0] : savedData;

    return res.status(200).json({
      success: true,
      saved: true,
      spec: spec,
      record: savedRecord
    });

  } catch (err) {
    monitor.logError('analyze-design-spec', err, {
      client_slug: (typeof clientSlug !== 'undefined' ? clientSlug : null),
      detail: { stage: 'analyze_handler' }
    });
    return res.status(500).json({ error: 'Failed to analyze design spec' });
  }
};
