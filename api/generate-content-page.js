// /api/generate-content-page.js
// Generates production-ready HTML for a content page using Claude Opus 4.6.
// Uses NDJSON streaming to keep the connection alive during generation.
// Pulls: design_specs, content_pages (RTPBA + schema), contacts, practice_details, bio_materials
// Produces: Full HTML page with schema, FAQ accordion, CTA bands, crisis disclaimer

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var sanitizer = require('./_lib/html-sanitizer');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var contentPageId = body.content_page_id;
  if (!contentPageId) return res.status(400).json({ error: 'content_page_id required' });

  // NDJSON streaming
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(obj) {
    res.write(JSON.stringify(obj) + '\n');
    if (typeof res.flush === 'function') res.flush();
  }

  var headers = sb.headers();

  try {
    send({ step: 'loading', message: 'Loading content page data...' });

    // 1. Fetch the content page
    var cpRes = await fetch(sb.url() + '/rest/v1/content_pages?id=eq.' + contentPageId + '&limit=1', { headers: headers });
    var cpArr = await cpRes.json();
    var cp = cpArr && cpArr[0];
    if (!cp) { send({ step: 'error', message: 'Content page not found' }); return res.end(); }

    var contactId = cp.contact_id;
    var clientSlug = cp.client_slug;

    // 2. Fetch design spec, contact, practice details in parallel
    send({ step: 'loading', message: 'Loading design spec and client data...' });

    var results = await Promise.all([
      fetch(sb.url() + '/rest/v1/design_specs?contact_id=eq.' + contactId + '&limit=1', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return []; }),
      fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contactId + '&limit=1', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return []; }),
      fetch(sb.url() + '/rest/v1/practice_details?contact_id=eq.' + contactId + '&limit=1', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return []; }),
      fetch(sb.url() + '/rest/v1/bio_materials?contact_id=eq.' + contactId + '&order=sort_order,is_primary.desc', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return []; }),
      fetch(sb.url() + '/rest/v1/entity_audits?contact_id=eq.' + contactId + '&order=created_at.desc&limit=1', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return []; }),
      fetch(sb.url() + '/rest/v1/endorsements?contact_id=eq.' + contactId + '&status=eq.processed&order=sort_order,created_at.desc', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return []; })
    ]);

    var spec = results[0] && results[0][0];
    var contact = results[1] && results[1][0];
    var practice = results[2] && results[2][0];
    var bios = results[3] || [];
    var entityAudit = results[4] && results[4][0];
    var endorsements = results[5] || [];

    if (!contact) { send({ step: 'error', message: 'Contact not found' }); return res.end(); }

    // Determine RTPBA source
    var rtpba = cp.rtpba || '';
    var schemaRecs = cp.schema_recommendations || {};

    // For homepage, also check entity audit
    if (cp.page_type === 'homepage' && !rtpba && entityAudit && entityAudit.surge_data) {
      // Try to extract RTPBA from entity audit surge data
      var sd = entityAudit.surge_data;
      if (typeof sd === 'object' && sd.opportunities && sd.opportunities.ready_to_publish) {
        rtpba = sd.opportunities.ready_to_publish;
      } else if (typeof sd === 'object' && sd.raw_text) {
        // Search for RTPBA section in raw text
        var raw = sd.raw_text || '';
        var rtpbaIdx = raw.indexOf('Ready-to-Publish');
        if (rtpbaIdx > -1) {
          rtpba = raw.substring(rtpbaIdx, rtpbaIdx + 5000);
        }
      }
    }

    // For FAQ page, we don't need RTPBA, we generate from practice details
    if (cp.page_type === 'faq' && !rtpba) {
      rtpba = '[GENERATE_FROM_PRACTICE_DETAILS]';
    }

    var platform = contact.website_platform || 'wordpress';
    var siteUrl = contact.website_url || '';

    send({ step: 'loaded', message: 'Data loaded. Starting generation...', page_type: cp.page_type, platform: platform, has_spec: !!spec, has_rtpba: !!rtpba });

    // Update status to generating
    await fetch(sb.url() + '/rest/v1/content_pages?id=eq.' + contentPageId, {
      method: 'PATCH',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'generating' })
    });

    // 3. Build the system prompt
    var systemPrompt = buildSystemPrompt(platform, siteUrl);

    // 4. Build the user message with all context
    var userMessage = buildUserMessage(cp, spec, contact, practice, bios, endorsements, rtpba, schemaRecs, platform, siteUrl);

    // 5. Call Claude with heartbeat
    var heartbeat = setInterval(function() {
      send({ step: 'heartbeat', message: 'Still generating...' });
    }, 15000);

    send({ step: 'generating', message: 'Claude is building the page HTML...' });

    var claudeResp;
    try {
      claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        })
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (!claudeResp.ok) {
      var errText = await claudeResp.text();
      send({ step: 'error', message: 'Claude API error: ' + claudeResp.status, detail: errText.substring(0, 500) });
      // Revert status
      await fetch(sb.url() + '/rest/v1/content_pages?id=eq.' + contentPageId, {
        method: 'PATCH',
        headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ status: 'audit_loaded' })
      });
      return res.end();
    }

    var claudeData = await claudeResp.json();
    var responseText = '';
    if (claudeData.content && claudeData.content.length > 0) {
      responseText = claudeData.content[0].text || '';
    }

    send({ step: 'processing', message: 'Extracting HTML from response...', response_length: responseText.length });

    // 6. Extract HTML from response
    var html = extractHtml(responseText);

    if (!html || html.length < 200) {
      send({ step: 'error', message: 'Generated HTML is too short or empty. Check response.', raw_preview: responseText.substring(0, 500) });
      await fetch(sb.url() + '/rest/v1/content_pages?id=eq.' + contentPageId, {
        method: 'PATCH',
        headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ status: 'audit_loaded', generation_notes: 'Generation produced insufficient output. Raw length: ' + responseText.length })
      });
      return res.end();
    }

    // 7. Extract any VERIFY flags
    var verifyFlags = [];
    var verifyRegex = /VERIFY[:\s]*([^\n<]+)/gi;
    var match;
    while ((match = verifyRegex.exec(html)) !== null) {
      verifyFlags.push(match[1].trim());
    }

    var notes = '';
    if (verifyFlags.length > 0) {
      notes = 'VERIFY flags (' + verifyFlags.length + '): ' + verifyFlags.join('; ');
    }

    // 7b. Sanitize the generated HTML before save.
    //
    // Defense-in-depth against stored XSS on the deployed client site.
    // Upstream inputs (endorsements especially) are already sanitized on
    // submission, but Claude itself could in principle produce unsafe output
    // — a rogue prompt injection, a confused generation, a template instruction
    // that asks for literal <script>. The allowlist sanitizer strips all
    // <script>, <iframe>, <object>, <embed>, event handlers, and
    // javascript:/data: URLs. Legitimate content pages use only structural
    // and inline tags plus <style> for theming, all of which stay.
    var htmlBefore = html.length;
    html = sanitizer.sanitizeHtml(html);
    if (html.length !== htmlBefore) {
      var diff = htmlBefore - html.length;
      notes = (notes ? notes + ' ' : '') + 'Sanitizer stripped ' + diff + ' bytes of unsafe markup.';
      send({ step: 'sanitized', message: 'Sanitizer stripped ' + diff + ' bytes', bytes_removed: diff });
    }

    // 8. Save to content_pages
    send({ step: 'saving', message: 'Saving generated HTML (' + Math.round(html.length / 1024) + 'KB)...' });

    var updateData = {
      generated_html: html,
      status: 'review',
      generation_notes: notes || null,
      stale: false
    };

    await fetch(sb.url() + '/rest/v1/content_pages?id=eq.' + contentPageId, {
      method: 'PATCH',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify(updateData)
    });

    // 9. Create initial version record
    await fetch(sb.url() + '/rest/v1/content_page_versions', {
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        content_page_id: contentPageId,
        html: html,
        change_summary: 'Initial generation via Pagemaster',
        changed_by: 'admin'
      })
    });

    send({
      step: 'complete',
      message: 'Page generated successfully',
      html_size: html.length,
      verify_flags: verifyFlags.length,
      status: 'review'
    });

    return res.end();

  } catch (err) {
    console.error('Content page generation error:', err);
    try { send({ step: 'error', message: err.message }); } catch (e) { /* stream may be closed */ }
    return res.end();
  }
};


// ============================================================
// SYSTEM PROMPT BUILDER
// ============================================================
function buildSystemPrompt(platform, siteUrl) {
  var isWix = platform.toLowerCase() === 'wix';

  var prompt = `You are the Moonraker Pagemaster, a production engine that builds SEO-optimized, AI-citation-ready HTML pages for mental health therapy practices.

OUTPUT RULES:
- Return ONLY the complete HTML page code. No explanations, no markdown, no backticks.
- Start with <!DOCTYPE html> or the opening tag and end with the closing tag.
- The output must be valid, production-ready HTML that can be deployed directly.

CONTENT RULES:
- The Ready-to-Publish Best Answer (RTPBA) is VERBATIM source copy. Do not rewrite or reinterpret it.
- Apply layout, styling, schema, and formatting to the exact RTPBA text.
- Adapt voice to match the Voice DNA profile provided.
- NEVER use emdashes. Use commas, periods, colons, or restructure the sentence.
- Mark any unconfirmed practitioner detail with <!-- VERIFY: detail --> comments.
- Crisis disclaimers must be paragraph text, never headings.

PAGE STRUCTURE:
- Hero section: two-column with emotional "Why" statement, "What" explanation, and CTA.
  Hero text max: hook + one supporting paragraph + CTA. Longer content goes into sections below.
- Two-column desktop layouts with alternating full-width branded background sections.
- FAQ accordion section with proper FAQPage schema.
- CTA bands: minimum two (hero CTA and closing CTA).
- Button hover transitions at 0.3s, no aggressive animations.
- Subtle scroll animations (fade-in on scroll).
- Set <body> background-color to match the last section's background.

SCHEMA (embedded in page):
- Include all relevant schema types: MedicalWebPage, FAQPage, Person, Service, BreadcrumbList.
- Schema goes in a <script type="application/ld+json"> block in the <head>.

RESPONSIVE DESIGN:
- Mobile-first CSS with breakpoints at 768px (tablet) and 1024px (desktop).
- Images: max-width: 100%, height: auto for content images, object-fit: cover for backgrounds.
- Use CSS Grid or Flexbox for layouts.`;

  if (isWix) {
    prompt += `

WIX-SPECIFIC RULES (CRITICAL):
- This page will be embedded as a Wix Custom HTML block (sandboxed iframe on filesusr.com).
- ALL elements need explicit fonts, sizes, colors. Nothing is inherited from the site theme.
- Import Google Fonts at the top of the <style> block.
- Use 17px base font desktop, 15-16px mobile.
- Max-width: 1200px for content.
- ALL internal links must be absolute URLs (https://${siteUrl || 'www.example.com'}/page) with target="_top".
- External links: target="_blank" rel="noopener".
- Full-width backgrounds: make sections direct children of <body> with width: 100% and padding.
  Do NOT use 100vw or negative-margin tricks.
- Use .section-inner wrapper with max-width and margin: 0 auto to center content.
- <body> background-color must match the last section's background (gap mitigation).
- Remove bottom padding/margin on the last section.`;
  } else {
    prompt += `

PLATFORM: ${platform.toUpperCase()} (Hybrid Styling Mode)
- Standard HTML elements are left unstyled, the site theme's CSS cascade applies.
- Only custom/branded elements (CTA bands, FAQ accordion, NEO section, schema) receive inline or embedded styles.
- Import Google Fonts only if different from what the site theme provides.`;
  }

  return prompt;
}


// ============================================================
// USER MESSAGE BUILDER
// ============================================================
function buildUserMessage(cp, spec, contact, practice, bios, endorsements, rtpba, schemaRecs, platform, siteUrl) {
  var msg = 'Build a production-ready HTML page with the following context:\n\n';

  // Page info
  msg += '=== PAGE INFO ===\n';
  msg += 'Page Type: ' + cp.page_type + '\n';
  msg += 'Page Name: ' + cp.page_name + '\n';
  if (cp.target_keyword) msg += 'Target Keyword: ' + cp.target_keyword + '\n';
  msg += 'Platform: ' + platform + '\n';
  if (siteUrl) msg += 'Site URL: ' + siteUrl + '\n';
  msg += '\n';

  // Practice info
  msg += '=== PRACTICE INFO ===\n';
  msg += 'Practice Name: ' + (contact.practice_name || '') + '\n';
  msg += 'Practitioner: ' + (contact.first_name || '') + ' ' + (contact.last_name || '') + (contact.credentials ? ', ' + contact.credentials : '') + '\n';
  if (contact.city || contact.state_province) msg += 'Location: ' + [contact.city, contact.state_province].filter(Boolean).join(', ') + '\n';
  if (contact.practice_address_line1) msg += 'Address: ' + contact.practice_address_line1 + (contact.practice_address_line2 ? ', ' + contact.practice_address_line2 : '') + ', ' + [contact.city, contact.state_province, contact.postal_code].filter(Boolean).join(', ') + '\n';
  if (contact.phone) msg += 'Phone: ' + contact.phone + '\n';
  if (contact.email) msg += 'Email: ' + contact.email + '\n';
  if (contact.gbp_url) msg += 'Google Business Profile: ' + contact.gbp_url + '\n';
  msg += '\n';

  // Practice details
  if (practice) {
    msg += '=== PRACTICE DETAILS ===\n';
    if (practice.specialties && practice.specialties.length) msg += 'Specialties: ' + practice.specialties.join(', ') + '\n';
    if (practice.modalities && practice.modalities.length) msg += 'Modalities: ' + practice.modalities.join(', ') + '\n';
    if (practice.populations && practice.populations.length) msg += 'Populations Served: ' + practice.populations.join(', ') + '\n';
    if (practice.insurance_or_private_pay) msg += 'Payment: ' + practice.insurance_or_private_pay + '\n';
    if (practice.insurance_panels) msg += 'Insurance Panels: ' + practice.insurance_panels + '\n';
    if (practice.session_cost) msg += 'Session Cost: ' + practice.session_cost + '\n';
    if (practice.booking_url) msg += 'Booking URL: ' + practice.booking_url + '\n';
    if (practice.offers_consultation) msg += 'Free Consultation: Yes' + (practice.consultation_length ? ' (' + practice.consultation_length + ')' : '') + '\n';
    if (practice.licensed_states && practice.licensed_states.length) msg += 'Licensed States: ' + practice.licensed_states.join(', ') + '\n';
    if (practice.service_delivery) msg += 'Service Delivery: ' + practice.service_delivery + '\n';
    if (practice.ideal_client) msg += 'Ideal Client: ' + practice.ideal_client + '\n';
    if (practice.differentiators) msg += 'Differentiators: ' + practice.differentiators + '\n';
    if (practice.intake_process) msg += 'Intake Process: ' + practice.intake_process + '\n';
    msg += '\n';
  }

  // Design spec
  if (spec) {
    msg += '=== DESIGN SPEC ===\n';
    if (spec.summary_text) msg += spec.summary_text + '\n\n';
    if (spec.typography) msg += 'Typography: ' + JSON.stringify(spec.typography) + '\n';
    if (spec.color_palette) msg += 'Colors: ' + JSON.stringify(spec.color_palette) + '\n';
    if (spec.layout_patterns) msg += 'Layout: ' + JSON.stringify(spec.layout_patterns) + '\n';
    if (spec.button_styles) msg += 'Buttons: ' + JSON.stringify(spec.button_styles) + '\n';
    if (spec.voice_dna) msg += 'Voice DNA: ' + JSON.stringify(spec.voice_dna) + '\n';
    msg += '\n';
  } else {
    msg += '=== DESIGN SPEC ===\nNo design spec available. Use clean, professional defaults with a calming therapy aesthetic.\n\n';
  }

  // RTPBA / Content source
  if (cp.page_type === 'faq') {
    msg += '=== FAQ CONTENT INSTRUCTIONS ===\n';
    msg += 'Generate a General FAQ page for this practice. This is NOT service-specific.\n';
    msg += 'Cover these categories of questions:\n';
    msg += '- Getting started (intake, first appointment, what to expect)\n';
    msg += '- Insurance and payment (accepted plans, sliding scale, costs)\n';
    msg += '- Scheduling and logistics (cancellation policy, session length, frequency)\n';
    msg += '- Telehealth and in-person options\n';
    msg += '- Privacy and confidentiality\n';
    msg += '- Emergency and crisis information\n';
    msg += 'Use the Practice Details above to make answers specific to this practice.\n';
    msg += 'Include FAQPage schema for all Q&A pairs.\n\n';
  } else if (cp.page_type === 'bio' && bios.length > 0) {
    msg += '=== BIO CONTENT ===\n';
    bios.forEach(function(bio) {
      msg += 'Name: ' + (bio.therapist_name || '') + '\n';
      if (bio.therapist_credentials) msg += 'Credentials: ' + bio.therapist_credentials + '\n';
      if (bio.professional_bio) msg += 'Bio: ' + bio.professional_bio + '\n';
      if (bio.clinical_approach) msg += 'Clinical Approach: ' + bio.clinical_approach + '\n';
      if (bio.headshot_url) msg += 'Headshot URL: ' + bio.headshot_url + '\n';
      if (bio.education_details) msg += 'Education: ' + JSON.stringify(bio.education_details) + '\n';
      if (bio.license_details) msg += 'Licenses: ' + JSON.stringify(bio.license_details) + '\n';
      if (bio.certification_details) msg += 'Certifications: ' + JSON.stringify(bio.certification_details) + '\n';
      if (bio.association_details) msg += 'Associations: ' + JSON.stringify(bio.association_details) + '\n';
      msg += '\n';
    });

    // Include processed endorsements for this clinician
    var bioEndorsements = endorsements;
    if (cp.bio_material_id) {
      bioEndorsements = endorsements.filter(function(e) {
        return e.bio_material_id === cp.bio_material_id || !e.bio_material_id;
      });
    }
    if (bioEndorsements.length > 0) {
      msg += '=== ENDORSEMENTS (include in a dedicated section near the bottom of the page) ===\n';
      msg += 'Include these endorsements in a visually distinct "What Others Say" or "Professional Endorsements" section.\n';
      msg += 'Each endorsement should include the endorser name, title/org, and the quote. Use proper schema markup (Review/Recommendation).\n';
      msg += 'IMPORTANT: Wrap the endorsement section in a container with id="endorsement-section" so it can be dynamically updated.\n\n';
      bioEndorsements.forEach(function(e, idx) {
        msg += 'Endorsement ' + (idx + 1) + ':\n';
        msg += '  From: ' + (e.endorser_name || 'Anonymous');
        if (e.endorser_title) msg += ', ' + e.endorser_title;
        if (e.endorser_org) msg += ' at ' + e.endorser_org;
        msg += '\n';
        if (e.relationship) msg += '  Relationship: ' + e.relationship + '\n';
        if (e.content) msg += '  Quote: "' + e.content + '"\n';
        msg += '\n';
      });
    } else {
      msg += '=== ENDORSEMENTS ===\n';
      msg += 'No endorsements available yet. Include an empty endorsement section placeholder with id="endorsement-section" and a brief note like "Professional endorsements coming soon."\n\n';
    }
  } else if (rtpba) {
    msg += '=== READY-TO-PUBLISH BEST ANSWER (VERBATIM, DO NOT REWRITE) ===\n';
    msg += rtpba.substring(0, 25000) + '\n\n';
  } else {
    msg += '=== CONTENT NOTE ===\n';
    msg += 'No RTPBA available. Draft page content based on the practice details above.\n';
    msg += 'Mark ALL practitioner-specific claims with <!-- VERIFY: claim --> comments.\n\n';
  }

  // Schema recommendations
  if (schemaRecs && Object.keys(schemaRecs).length > 0) {
    msg += '=== SCHEMA RECOMMENDATIONS FROM SURGE ===\n';
    msg += JSON.stringify(schemaRecs, null, 2) + '\n\n';
  }

  // Surge data (truncated, for additional context)
  if (cp.surge_data && typeof cp.surge_data === 'object') {
    var sd = cp.surge_data;
    if (sd.intelligence) {
      msg += '=== SURGE INTELLIGENCE (key insights) ===\n';
      var intel = typeof sd.intelligence === 'string' ? sd.intelligence : JSON.stringify(sd.intelligence);
      msg += intel.substring(0, 3000) + '\n\n';
    }
    if (sd.action_plan) {
      msg += '=== SURGE ACTION PLAN (on-page items only) ===\n';
      var ap = typeof sd.action_plan === 'string' ? sd.action_plan : JSON.stringify(sd.action_plan);
      msg += ap.substring(0, 2000) + '\n\n';
    }
  }

  msg += '=== INSTRUCTIONS ===\n';
  msg += 'Build the complete HTML page now. Return ONLY the HTML code.\n';

  return msg;
}


// ============================================================
// HTML EXTRACTOR
// ============================================================
function extractHtml(responseText) {
  var text = responseText.trim();

  // If it starts with <!DOCTYPE or <html, it's already clean HTML
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || text.startsWith('<head') || text.startsWith('<style')) {
    return text;
  }

  // Try to extract from markdown code blocks
  var htmlBlock = text.match(/```html?\s*\n?([\s\S]*?)```/);
  if (htmlBlock && htmlBlock[1]) {
    return htmlBlock[1].trim();
  }

  // Try to find HTML starting from <!DOCTYPE or <html
  var docIdx = text.indexOf('<!DOCTYPE');
  if (docIdx === -1) docIdx = text.indexOf('<html');
  if (docIdx === -1) docIdx = text.indexOf('<head');
  if (docIdx === -1) docIdx = text.indexOf('<style');

  if (docIdx > -1) {
    return text.substring(docIdx).trim();
  }

  // Last resort: return the whole thing
  return text;
}
