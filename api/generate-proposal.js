// /api/generate-proposal.js
// Generates personalized proposal content using Anthropic API,
// fills the proposal template, and deploys all client pages to GitHub.
//
// POST { proposal_id }
//
// Flow:
//   1. Load proposal + contact + enrichment from Supabase
//   2. Read proposal template from GitHub
//   3. Call Anthropic API to generate all content sections
//   4. Fill template with generated content + view tracking
//   5. Deploy proposal + checkout + onboarding + router to GitHub
//   6. Update proposal record with URLs and status
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, GITHUB_PAT

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var ghToken = process.env.GITHUB_PAT;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  var proposalId = (req.body || {}).proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var results = { generate: null, deploy: [] };

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }
  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' };
  }

  // ─── 1. Load proposal + contact ───────────────────────────────
  var proposal, contact;
  try {
    var pResp = await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1', { headers: sbHeaders() });
    var proposals = await pResp.json();
    if (!proposals || proposals.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    proposal = proposals[0];
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load proposal: ' + e.message });
  }

  var slug = contact.slug;
  var enrichment = proposal.enrichment_data || {};
  var campaigns = proposal.campaign_lengths || ['annual'];
  var billings = proposal.billing_options || [];
  var customPricing = proposal.custom_pricing || null;

  // Update status
  await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId, {
    method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'generating' })
  }).catch(function(){});

  // ─── 2. Read proposal template from GitHub ────────────────────
  var templateHtml;
  try {
    var tResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/_templates/proposal.html?ref=' + BRANCH, { headers: ghHeaders() });
    if (!tResp.ok) {
      var errText = await tResp.text().catch(function() { return 'unknown'; });
      return res.status(500).json({ error: 'GitHub API returned ' + tResp.status + ' reading template. Check GITHUB_PAT env var.', details: errText.substring(0, 500) });
    }
    var tData = await tResp.json();
    if (!tData.content) {
      return res.status(500).json({ error: 'Template response has no content field', keys: Object.keys(tData) });
    }
    templateHtml = Buffer.from(tData.content, 'base64').toString('utf-8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read proposal template: ' + e.message, stack: (e.stack || '').substring(0, 500) });
  }

  // ─── 3. Build context and call Anthropic ──────────────────────
  var firstName = contact.first_name || '';
  var lastName = contact.last_name || '';
  var fullName = (firstName + ' ' + lastName).trim();
  var nameWithCreds = fullName + (contact.credentials ? ', ' + contact.credentials : '');
  var practiceName = contact.practice_name || fullName;
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ') || '';

  // Determine primary campaign display
  var primaryCampaign = campaigns.includes('annual') ? 'annual' : campaigns.includes('quarterly') ? 'quarterly' : 'monthly';
  var campaignDisplay = { annual: '12-Month CORE Campaign', quarterly: '3-Month Growth Engagement', monthly: 'Monthly CORE Engagement' };
  var priceDisplay = { annual: '$20,000', quarterly: '$5,000', monthly: '$1,667' };
  var periodDisplay = { annual: '12-month campaign', quarterly: '3-month campaign', monthly: 'per month' };
  var timelineLabel = { annual: '12-Month', quarterly: '3-Month', monthly: 'Monthly' };

  // ─── Fetch Service & Sales Reference (source of truth) ───────
  var serviceReference = '';
  try {
    var docResp = await fetch('https://docs.google.com/document/d/1P9s6TKxp2cWRsGpvm-XvT_OipTqZqdk1XtGL3yG65Zc/export?format=txt', {
      signal: AbortSignal.timeout(10000)
    });
    if (docResp.ok) {
      serviceReference = await docResp.text();
      // Trim to key sections to fit context (skip objection handling, etc.)
      var pricingIdx = serviceReference.indexOf('PRICING & CONTRACTS');
      var objectionIdx = serviceReference.indexOf('OBJECTION HANDLING');
      if (objectionIdx > 0) serviceReference = serviceReference.substring(0, objectionIdx).trim();
    }
  } catch (e) { /* service doc fetch optional, prompt has fallback */ }

  // Build enrichment context summary
  var enrichmentContext = '';
  if (enrichment.emails && enrichment.emails.length > 0) {
    enrichmentContext += '\n\nEMAIL HISTORY (' + enrichment.emails.length + ' threads found):\n';
    enrichment.emails.forEach(function(e) {
      enrichmentContext += '- Subject: ' + e.subject + ' | From: ' + e.from + ' | Snippet: ' + e.snippet + '\n';
    });
  }
  if (enrichment.calls && enrichment.calls.length > 0) {
    enrichmentContext += '\n\nCALL RECORDINGS (' + enrichment.calls.length + ' found):\n';
    enrichment.calls.forEach(function(c) {
      enrichmentContext += '- Title: ' + c.title + ' | Date: ' + c.date + '\n';
      if (c.summary) enrichmentContext += '  Summary: ' + (typeof c.summary === 'string' ? c.summary.substring(0, 800) : JSON.stringify(c.summary).substring(0, 800)) + '\n';
    });
  }
  if (enrichment.audit_scores) {
    enrichmentContext += '\n\nENTITY AUDIT SCORES: ' + JSON.stringify(enrichment.audit_scores) + '\n';
  }
  if (enrichment.campaign_audit) {
    enrichmentContext += '\nCORE AUDIT SCORES: C=' + enrichment.campaign_audit.c_score + ' O=' + enrichment.campaign_audit.o_score + ' R=' + enrichment.campaign_audit.r_score + ' E=' + enrichment.campaign_audit.e_score + '\n';
  }
  if (enrichment.audit_tasks) {
    enrichmentContext += '\nAUDIT TASKS: ' + JSON.stringify(enrichment.audit_tasks).substring(0, 1500) + '\n';
  }
  if (enrichment.website_info) {
    enrichmentContext += '\n\nWEBSITE SCAN:\n';
    enrichmentContext += 'Title: ' + enrichment.website_info.title + '\n';
    enrichmentContext += 'Meta: ' + enrichment.website_info.meta_description + '\n';
    enrichmentContext += 'H1: ' + enrichment.website_info.h1 + '\n';
    enrichmentContext += 'Body preview: ' + (enrichment.website_info.body_preview || '').substring(0, 1500) + '\n';
  }
  if (enrichment.practice_details) {
    enrichmentContext += '\n\nPRACTICE DETAILS: ' + JSON.stringify(enrichment.practice_details).substring(0, 1500) + '\n';
  }

  var systemPrompt = `You are writing a personalized growth proposal for a therapy practice. You work for Moonraker, a digital marketing agency specializing in AI visibility for mental health professionals.

The CORE Marketing System has four pillars:
- C (Credibility): Proving the practice exists through DNS records, directory listings, social profiles, and entity verification
- O (Optimization): Teaching AI about services through dedicated pages, schema markup, FAQs, and proper heading hierarchy
- R (Reputation): Amplifying expertise through professional endorsements, social posting, YouTube content, press releases, and NEO images
- E (Engagement): Guiding visitors to book through hero section optimization, clear CTAs, and conversion optimization

IMPORTANT RULES:
- Never use em dashes. Use hyphens or rewrite.
- Write warmly but professionally. This is for therapists, not tech people.
- Reference specific details from the enrichment data to make this feel personal, not generic.
- Be honest about gaps but frame them as opportunities.
- Keep paragraphs concise and scannable.
- Score each CORE pillar 1-10 based on what you can assess from the data. If no audit data exists, estimate conservatively based on the website scan.

SERVICE SCOPE: The Service & Sales Reference document below is the SINGLE SOURCE OF TRUTH for all services, deliverables, pricing, and scope. Only reference services that appear in this document. If it is not in the document, we do not offer it.

CRITICAL: NEVER mention any of these ANYWHERE in the proposal, including findings, strategy sections, ROI, or investment features:
- Blog posts, blog content, blogging, or content marketing (we do NOT write blogs, do not even mention them as a gap)
- Backlinks, link building, or backlink strategies (we do NOT do link building, do not even mention them as a gap)
- Monthly strategy calls (we do onboarding calls, not ongoing monthly strategy calls)
- Email marketing or newsletters
- PPC/paid advertising management (referrals go to Mike Ensor)
- Website redesign or platform migration
- Any "12-month" guarantee (only a 12-month performance guarantee exists, and it is only for annual plans)

GUARANTEE: The 12-month performance guarantee means we set a measurable consultation benchmark together using their historical data, and we continue working for free until they hit it. This ONLY applies to the annual (12-month) plan. Do NOT mention it in the investment features (it is appended automatically for annual plans). Quarterly and monthly plans do NOT include any guarantee.

ROI PROJECTIONS: When generating the strategy_roi_callout, use ONLY numbers the prospect has actually shared (session rates, caseload, practice size, goals from calls or emails). Frame ROI conservatively using their own data, like "even one additional private-pay client at your rate of $X represents $Y in new revenue." Never fabricate specific dollar amounts or timelines. If the prospect hasn't shared financial details, use a general qualitative statement about ROI instead of inventing numbers. Do not promise specific timelines for investment recovery.

CONTACT: ${fullName} (${contact.credentials || 'credentials unknown'})
PRACTICE: ${practiceName}
LOCATION: ${location}
WEBSITE: ${contact.website_url || 'unknown'}
EMAIL: ${contact.email || 'unknown'}
CAMPAIGN: ${campaignDisplay[primaryCampaign]}
CAMPAIGN LENGTHS OFFERED: ${campaigns.join(', ')}
${enrichmentContext}

${serviceReference ? 'SERVICE & SALES REFERENCE DOCUMENT (source of truth for all services):\n' + serviceReference.substring(0, 8000) : ''}

Respond with ONLY valid JSON (no markdown, no backticks). The JSON must have these exact keys:`;

  var userPrompt = `Generate the proposal content as JSON with these keys:

{
  "hero_headline": "Short, compelling headline about transforming their practice's digital presence (15 words max)",
  "hero_subtitle": "One sentence expanding on the headline, referencing their specific situation",
  "exec_summary_paragraphs": "2-3 paragraphs in HTML (<p> tags) that show we understand their practice, goals, and challenges. Reference specific details from calls, emails, or website. Start with '<p class=\"lead\">' for the first paragraph.",
  "scores": { "c": NUMBER, "o": NUMBER, "r": NUMBER, "e": NUMBER },
  "credibility_findings": "3-4 findings as HTML divs using this format: <div class=\"finding\"><span class=\"finding-icon\">ICON</span><div><p><span class=\"highlight\">HEADLINE.</span> DETAIL</p></div></div> where ICON is &#9989; for strengths, &#9888;&#65039; for warnings, &#128308; for critical gaps",
  "optimization_findings": "Same format as above, 3-4 findings",
  "reputation_findings": "Same format, 3-4 findings",
  "engagement_findings": "Same format, 2-3 findings",
  "strategy_intro": "One paragraph about how the CORE strategy addresses their specific gaps",
  "strategy_cards": "4 HTML cards using EXACTLY these headings: <div class=\"card\"><h3 style=\"margin-bottom:1rem;\">Credibility: Prove You\'re Real</h3><p>...</p></div> then <div class=\"card\"><h3 style=\"margin-bottom:1rem;\">Optimization: Make AI Understand You</h3><p>...</p></div> then <div class=\"card\"><h3 style=\"margin-bottom:1rem;\">Reputation: Amplify the Signal</h3><p>...</p></div> then <div class=\"card\"><h3 style=\"margin-bottom:1rem;\">Engagement: Convert Visitors to Clients</h3><p>...</p></div>",
  "strategy_roi_callout": "HTML: <div class=\"roi-callout\"><h4>Title</h4><p style=\"margin-bottom:0;\">ROI calculation relevant to their practice</p></div> or empty string if insufficient data",
  "timeline_items": "3-4 timeline phases as HTML: <div class=\"timeline-item\"><span class=\"timeline-phase\">PHASE_LABEL</span><h4>PHASE_TITLE</h4><p>DESCRIPTION</p></div>",

  "next_steps": [{"title":"Step Title","desc":"Step description"}] // JSON array of exactly 4 steps describing what happens after they sign up. Personalize to their practice. Typical flow: Strategy Call, Custom Proposal/Onboarding, Quick Start, Launch & Monitor."
}`;

  var generatedContent;
  try {
    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    var aiData = await aiResp.json();
    var rawText = (aiData.content && aiData.content[0] && aiData.content[0].text) || '';
    // Clean potential markdown fences
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    generatedContent = JSON.parse(rawText);

    // Sanitize: strip any blog/backlink mentions the AI slips in despite instructions
    var sanitizePatterns = [
      /,?\s*blog\s*(posts?|content|strategy|creation|writing)?/gi,
      /,?\s*backlink(s|ing)?\s*(strateg(y|ies)|building|campaigns?)?/gi,
      /,?\s*link\s*building/gi
    ];
    Object.keys(generatedContent).forEach(function(key) {
      if (typeof generatedContent[key] === 'string') {
        sanitizePatterns.forEach(function(pat) {
          generatedContent[key] = generatedContent[key].replace(pat, '');
        });
        // Clean up artifacts: double commas, empty list items, orphaned "or"
        generatedContent[key] = generatedContent[key]
          .replace(/,\s*,/g, ',')
          .replace(/,\s*or\s*other/gi, ', or other')
          .replace(/,\s*<\/p>/g, '.</p>')
          .replace(/\s{2,}/g, ' ');
      }
    });

    results.generate = 'success';
  } catch (e) {
    results.generate = 'failed: ' + (e.message || String(e));
    await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ status: 'review', notes: 'Generation failed: ' + (e.message || String(e)) })
    }).catch(function(){});
    return res.status(500).json({ error: 'AI generation failed', details: e.message, results: results });
  }

  // ─── 4. Fill template with generated content ──────────────────
  var scores = generatedContent.scores || { c: 3, o: 3, r: 3, e: 3 };
  function scoreClass(s) { return s <= 4 ? 'score-low' : s <= 7 ? 'score-med' : 'score-high'; }
  function scoreOffset(s) { return Math.round(251.3 - (s / 10 * 251.3)); }
  var today = new Date();
  var dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // ─── Standardized investment features (hardcoded, not AI-generated) ───
  var standardFeatures = '<li><span class="check">&#10003;</span> Comprehensive digital audit using our proprietary Surge platform</li>'
    + '<li><span class="check">&#10003;</span> 5 dedicated service pages with custom HTML, schema markup, and targeted FAQs</li>'
    + '<li><span class="check">&#10003;</span> Professional bio pages for each therapist at your practice</li>'
    + '<li><span class="check">&#10003;</span> 1 location page to clearly establish where you serve</li>'
    + '<li><span class="check">&#10003;</span> General FAQ page covering logistics, policies, and common client questions</li>'
    + '<li><span class="check">&#10003;</span> Directory listings across 50+ platforms including all major data aggregators</li>'
    + '<li><span class="check">&#10003;</span> Social profile buildout and optimization across 9 platforms</li>'
    + '<li><span class="check">&#10003;</span> Entity Veracity Hub launch to verify and ground your practice online</li>'
    + '<li><span class="check">&#10003;</span> YouTube channel setup with optimized playlist for your main specialty</li>'
    + '<li><span class="check">&#10003;</span> Press release syndication across 500+ national and international news sites</li>'
    + '<li><span class="check">&#10003;</span> NEO image creation and distribution to build authority across high-traffic platforms</li>'
    + '<li><span class="check">&#10003;</span> Ongoing social posting across 4 platforms to reinforce your digital presence</li>'
    + '<li><span class="check">&#10003;</span> Hero section and CTA optimization to convert visitors into consultation bookings</li>'
    + '<li><span class="check">&#10003;</span> Monthly progress reports with visibility and engagement metrics</li>';
  var guaranteeFeature = '<li><span class="check">&#10003;</span> 12-month performance guarantee: if we don\'t hit our shared goal in 12 months, we continue working for free until you get there</li>';

  // Build investment cards for each selected campaign length
  var campaignInfo = {
    annual: { badge: '12-Month CORE Campaign', price: '$20,000', period: '12-month campaign', desc: 'Full annual engagement with performance guarantee', recommended: true },
    quarterly: { badge: '3-Month Growth Engagement', price: '$5,000', period: '3-month campaign', desc: 'Foundation-building quarterly engagement' },
    monthly: { badge: 'Monthly CORE Engagement', price: '$1,667', period: 'per month', desc: 'Flexible month-to-month engagement' }
  };

  var investmentCardsHtml = '<div class="investment-grid">';
  campaigns.forEach(function(c) {
    var info = campaignInfo[c];
    if (!info) return;
    var isRecommended = campaigns.length > 1 && c === 'annual';
    investmentCardsHtml += '<div class="investment-card' + (isRecommended ? ' recommended' : '') + '">';
    investmentCardsHtml += '<span class="badge">' + info.badge + '</span>';
    investmentCardsHtml += '<div class="investment-price">' + info.price + '</div>';
    investmentCardsHtml += '<div class="investment-period">' + info.period + '</div>';
    var featuresList = standardFeatures;
    if (c === 'annual') featuresList += guaranteeFeature;
    investmentCardsHtml += '<ul class="investment-features">' + featuresList + '</ul>';
    investmentCardsHtml += '<a href="/' + slug + '/checkout?plan=' + c + '" class="cta-btn" target="_blank">Choose Your Plan &#8594;</a>';
    investmentCardsHtml += '</div>';
  });
  // Add custom pricing card if present
  if (customPricing) {
    investmentCardsHtml += '<div class="investment-card">';
    investmentCardsHtml += '<span class="badge">Custom Arrangement</span>';
    investmentCardsHtml += '<div class="investment-price">$' + (customPricing.amount_cents / 100).toLocaleString() + '</div>';
    investmentCardsHtml += '<div class="investment-period">' + (customPricing.label || customPricing.period) + '</div>';
    investmentCardsHtml += '<ul class="investment-features">' + standardFeatures + '</ul>';
    investmentCardsHtml += '<a href="/' + slug + '/checkout" class="cta-btn" target="_blank">Choose Your Plan &#8594;</a>';
    investmentCardsHtml += '</div>';
  }
  investmentCardsHtml += '</div>';

  // Guarantee box
  var guaranteeBox = '';
  if (campaigns.includes('annual')) {
    guaranteeBox = '<div class="guarantee-box"><h3>Performance Guarantee</h3><p>Our annual program includes a performance guarantee - we set a measurable consultation benchmark together using your historical data, and we continue working for free until you hit it. No other agency in this space offers this.</p></div>';
  } else if (campaigns.includes('quarterly')) {
    guaranteeBox = '<div class="guarantee-box"><h3>Looking Ahead</h3><p>Our annual program includes a performance guarantee - we set a measurable consultation benchmark together and continue working for free until you hit it. While the 3-month engagement builds the foundation, many clients see enough momentum to transition to an annual program where the guarantee kicks in.</p><p>Everything we build in these 3 months is yours to keep, regardless of what you decide next.</p></div>';
  }

  // Build next steps HTML
  var nextStepsHtml = '';
  var steps = [];
  if (Array.isArray(generatedContent.next_steps) && generatedContent.next_steps.length > 0) {
    steps = generatedContent.next_steps;
  } else {
    steps = [
      { title: 'Choose Your Plan', desc: 'Click the button below to select your payment method and complete your investment. We offer both bank transfer (ACH) and credit card options.' },
      { title: 'Sign Your Agreement', desc: 'After payment, you will be directed to our client portal where you can review and electronically sign our service agreement.' },
      { title: 'Book Your Onboarding Call', desc: 'Schedule a 60-75 minute call with Scott, our Director of Growth. We will set up accounts, define your target keywords, and align on campaign strategy together.' },
      { title: 'We Get to Work', desc: 'Within the first week, our team starts the deep audit of your practice. You will see content drafts for review, and your digital footprint begins taking shape immediately.' }
    ];
  }
  steps.forEach(function(s, i) {
    var mb = i < steps.length - 1 ? 'margin-bottom:1.25rem;' : '';
    nextStepsHtml += '<div style="display:flex;gap:1rem;align-items:flex-start;' + mb + '"><div style="width:28px;height:28px;border-radius:50%;background:var(--color-primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8125rem;flex-shrink:0;">' + (i + 1) + '</div><div><h4>' + (s.title || 'Step ' + (i+1)) + '</h4><p style="margin-bottom:0;">' + (s.desc || s.description || '') + '</p></div></div>';
  });

  // Replace template variables
  var html = templateHtml;
  var replacements = {
    '{{PRACTICE_NAME}}': practiceName,
    '{{PROSPECT_NAME_CREDENTIALS}}': nameWithCreds,
    '{{PROSPECT_FIRST_NAME}}': firstName,
    '{{LOCATION}}': location || 'United States',
    '{{DATE}}': dateStr,
    '{{BADGE_TEXT}}': campaignDisplay[primaryCampaign],
    '{{HERO_HEADLINE}}': generatedContent.hero_headline || 'Your Practice Deserves to Be Found',
    '{{HERO_SUBTITLE}}': generatedContent.hero_subtitle || '',
    '{{EXEC_SUMMARY_PARAGRAPHS}}': generatedContent.exec_summary_paragraphs || '',
    '{{SCORE_C}}': scores.c,
    '{{SCORE_O}}': scores.o,
    '{{SCORE_R}}': scores.r,
    '{{SCORE_E}}': scores.e,
    '{{SCORE_C_CLASS}}': scoreClass(scores.c),
    '{{SCORE_O_CLASS}}': scoreClass(scores.o),
    '{{SCORE_R_CLASS}}': scoreClass(scores.r),
    '{{SCORE_E_CLASS}}': scoreClass(scores.e),
    '{{SCORE_C_OFFSET}}': scoreOffset(scores.c),
    '{{SCORE_O_OFFSET}}': scoreOffset(scores.o),
    '{{SCORE_R_OFFSET}}': scoreOffset(scores.r),
    '{{SCORE_E_OFFSET}}': scoreOffset(scores.e),
    '{{CREDIBILITY_FINDINGS}}': generatedContent.credibility_findings || '',
    '{{OPTIMIZATION_FINDINGS}}': generatedContent.optimization_findings || '',
    '{{REPUTATION_FINDINGS}}': generatedContent.reputation_findings || '',
    '{{ENGAGEMENT_FINDINGS}}': generatedContent.engagement_findings || '',
    '{{STRATEGY_INTRO}}': generatedContent.strategy_intro || '',
    '{{STRATEGY_CARDS}}': generatedContent.strategy_cards || '',
    '{{STRATEGY_ROI_CALLOUT}}': generatedContent.strategy_roi_callout || '',
    '{{TIMELINE_TITLE}}': 'Your ' + timelineLabel[primaryCampaign] + ' Roadmap',
    '{{TIMELINE_INTRO}}': 'Here is exactly what happens from the moment you say go. We handle the heavy lifting - your time commitment is roughly 6-8 hours in month one (mostly the onboarding call and content review), then significantly less after that.',
    '{{TIMELINE_ITEMS}}': generatedContent.timeline_items || '',
    '{{INVESTMENT_CARDS_HTML}}': investmentCardsHtml,
    '{{CHECKOUT_URL}}': '/' + slug + '/checkout',
    '{{GUARANTEE_BOX}}': guaranteeBox,
    '{{NEXT_STEPS_ITEMS}}': nextStepsHtml
  };

  Object.keys(replacements).forEach(function(key) {
    html = html.split(key).join(String(replacements[key]));
  });

  // Add view tracking script before </body>
  var trackingScript = `
<script>
(function(){
  var params = new URLSearchParams(window.location.search);
  if (params.has('preview')) return;
  var SB='https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var K='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbW13Y2poZHJodnh4a2hjdXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjM1NTcsImV4cCI6MjA4OTg5OTU1N30.zMMHW0Fk9ixWjORngyxJTIoPOfx7GFsD4wBV4Foqqms';
  fetch(SB+'/rest/v1/rpc/track_proposal_view',{method:'POST',headers:{'apikey':K,'Authorization':'Bearer '+K,'Content-Type':'application/json'},body:JSON.stringify({p_slug:'${slug}'})}).catch(function(){});
})();
</script>`;
  html = html.replace('</body>', trackingScript + '\n</body>');

  // ─── 5. Deploy all pages to GitHub ────────────────────────────
  var pagesToDeploy = [
    { dest: slug + '/proposal/index.html', content: html },
    { template: '_templates/router.html', dest: slug + '/index.html' },
    { template: '_templates/checkout.html', dest: slug + '/checkout/index.html' },
    { template: '_templates/onboarding.html', dest: slug + '/onboarding/index.html' }
  ];

  for (var p of pagesToDeploy) {
    try {
      var fileContent;
      if (p.content) {
        fileContent = p.content;
      } else {
        // Read template from GitHub
        var tplResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + p.template + '?ref=' + BRANCH, { headers: ghHeaders() });
        if (!tplResp.ok) { results.deploy.push({ path: p.dest, ok: false, error: 'Template not found' }); continue; }
        var tplData = await tplResp.json();
        fileContent = Buffer.from(tplData.content, 'base64').toString('utf-8');
      }

      // Check if file already exists (need SHA for update)
      var existResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + p.dest + '?ref=' + BRANCH, { headers: ghHeaders() });
      var sha = null;
      if (existResp.ok) {
        var existData = await existResp.json();
        sha = existData.sha;
      }

      var pushBody = {
        message: 'Deploy ' + p.dest.split('/').pop() + ' for ' + slug,
        content: Buffer.from(fileContent).toString('base64'),
        branch: BRANCH
      };
      if (sha) pushBody.sha = sha;

      var pushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + p.dest, {
        method: 'PUT', headers: ghHeaders(), body: JSON.stringify(pushBody)
      });
      results.deploy.push({ path: p.dest, ok: pushResp.ok });
    } catch (e) {
      results.deploy.push({ path: p.dest, ok: false, error: e.message });
    }
  }

  // ─── 6. Update proposal record ────────────────────────────────
  var proposalUrl = 'https://clients.moonraker.ai/' + slug + '/proposal';
  var checkoutUrl = 'https://clients.moonraker.ai/' + slug + '/checkout';

  // Also update checkout_options on the contact
  var checkoutPlans = billings.length ? billings : null;
  if (checkoutPlans) {
    await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + contact.id, {
      method: 'PATCH', headers: sbHeaders(),
      body: JSON.stringify({ checkout_options: { plans: checkoutPlans } })
    }).catch(function(){});
  }

  await fetch(sbUrl + '/rest/v1/proposals?id=eq.' + proposalId, {
    method: 'PATCH', headers: sbHeaders(),
    body: JSON.stringify({
      status: 'ready',
      proposal_url: proposalUrl,
      checkout_url: checkoutUrl,
      proposal_content: generatedContent
    })
  }).catch(function(){});

  return res.status(200).json({
    ok: true,
    proposal_url: proposalUrl,
    checkout_url: checkoutUrl,
    results: results
  });
};






