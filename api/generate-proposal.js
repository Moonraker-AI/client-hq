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
//   7. Convert lead to prospect + seed 9 onboarding steps
//   8. Create Google Drive folder hierarchy (Creative, Docs, Optimization, Web Design)
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, GITHUB_PAT, GOOGLE_SERVICE_ACCOUNT_JSON

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var gh = require('./_lib/github');
var pageToken = require('./_lib/page-token');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;


  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var ghToken = process.env.GITHUB_PAT;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });

  var proposalId = (req.body || {}).proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';
  var results = { generate: null, deploy: [] };

  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + ghToken, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' };
  }

  // ─── 1. Load proposal + contact ───────────────────────────────
  var proposal, contact;
  try {
    var pResp = await fetch(sb.url() + '/rest/v1/proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1', { headers: sb.headers() });
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

  // Load practice_type for results section filtering
  var practiceType = 'group'; // default
  try {
    var pdResp = await fetch(sb.url() + '/rest/v1/practice_details?contact_id=eq.' + contact.id + '&select=practice_type&limit=1', { headers: sb.headers() });
    var pdRows = await pdResp.json();
    if (pdRows && pdRows.length > 0 && pdRows[0].practice_type) {
      practiceType = pdRows[0].practice_type; // 'solo' or 'group'
    }
  } catch (e) { /* default to group */ }

  // Update status
  await fetch(sb.url() + '/rest/v1/proposals?id=eq.' + proposalId, {
    method: 'PATCH', headers: sb.headers(), body: JSON.stringify({ status: 'generating' })
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
    enrichmentContext += '\nCORE AUDIT SCORES: C=' + enrichment.campaign_audit.c_score + ' O=' + enrichment.campaign_audit.o_score + ' R=' + enrichment.campaign_audit.r_score + ' E=' + enrichment.campaign_audit.e_score + ' (CRES Total=' + enrichment.campaign_audit.cres_score + ', Variance=' + enrichment.campaign_audit.variance_score + ')\n';
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
        model: 'claude-sonnet-4-6',
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
    await fetch(sb.url() + '/rest/v1/proposals?id=eq.' + proposalId, {
      method: 'PATCH', headers: sb.headers(), body: JSON.stringify({ status: 'review', notes: 'Generation failed: ' + (e.message || String(e)) })
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
    + '<li><span class="check">&#10003;</span> Citation audit and listings via BrightLocal (15 citations + data aggregators)</li>'
    + '<li><span class="check">&#10003;</span> Social profile buildout and optimization across 9 platforms</li>'
    + '<li><span class="check">&#10003;</span> Entity Veracity Hub launch to verify and ground your practice online</li>'
    + '<li><span class="check">&#10003;</span> YouTube channel setup with optimized playlist for your main specialty</li>'
    + '<li><span class="check">&#10003;</span> Press release syndication across 500+ national and international news sites</li>'
    + '<li><span class="check">&#10003;</span> NEO image creation and distribution to build authority across high-traffic platforms</li>'
    + '<li><span class="check">&#10003;</span> Ongoing social posting across 4 platforms to reinforce your digital presence</li>'
    + '<li><span class="check">&#10003;</span> Professional endorsement collection for clinician bio pages</li>'
    + '<li><span class="check">&#10003;</span> Hero section and CTA optimization to convert visitors into consultation bookings</li>'
    + '<li><span class="check">&#10003;</span> Monthly progress reports with visibility and engagement metrics</li>';
  var guaranteeFeature = '<li><span class="check">&#10003;</span> <strong>12-month performance guarantee: if we don\'t hit our shared goal in 12 months, we continue working for free until you get there</strong></li>';

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
    if (c === 'annual') featuresList = guaranteeFeature + featuresList;
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

  // ─── Build Results Section (practice-type aware) ──────────────
  function buildResultsSection(type) {
    // Hardcoded GSC results matching the /results page data
    var groupResults = [
      { pct: 213, time: '6 months', id: '1uVfNKUBxYy3KCEJEmJU92QE3DN9khHWA', label: 'Group Practice' },
      { pct: 170, time: '6 months', id: '1spFbq2k8QOqwWbLuvz1JxLgWpM7VFfaa', label: 'Group Practice' },
      { pct: 156, time: '3 months', id: '1jNjoiNtFgIINAyUpWyvH426qq1HTHG7X', label: 'Group Practice' }
    ];
    var soloResults = [
      { pct: 308, time: '3 months', id: '1ClS6rM1HrdGKr1qXKF7J9Yo32HaiFZOE', label: 'Solo Therapist' },
      { pct: 202, time: '6 months', id: '1fdthfPuD2hn4g-yR1yaEd3VYJTYdFN5l', label: 'Solo Therapist' },
      { pct: 168, time: '6 months', id: '1zTy0yzf_cZFPRiQNCykjxTLQfjoRDKVT', label: 'Solo Therapist' }
    ];

    var featured = type === 'solo' ? soloResults : groupResults;
    var typeLabel = type === 'solo' ? 'Solo Therapists' : 'Group Practices';
    var topPct = type === 'solo' ? '308%' : '213%';

    var html = '';

    // Stats bar (green numbers)
    html += '<div class="results-stats-bar">';
    html += '<div class="stat"><div class="stat-value">22</div><div class="stat-label">Client Results</div></div>';
    html += '<div class="stat"><div class="stat-value">115%</div><div class="stat-label">Average Increase</div></div>';
    html += '<div class="stat"><div class="stat-value">' + topPct + '</div><div class="stat-label">Top ' + (type === 'solo' ? 'Solo' : 'Group') + ' Result</div></div>';
    html += '</div>';

    // Type label
    html += '<p style="text-align:center;font-size:.8125rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--color-muted);margin-bottom:1rem;">Featuring results from ' + typeLabel + '</p>';

    // Mini grid of top 3 results (matching results page card design)
    html += '<div class="results-mini-grid">';
    featured.forEach(function(r, i) {
      var imgUrl = 'https://lh3.googleusercontent.com/d/' + r.id + '=w800';
      var hiResUrl = 'https://lh3.googleusercontent.com/d/' + r.id + '=w1400';
      html += '<div class="results-mini-card" onclick="window._openResultLightbox(' + i + ')">';
      html += '<div class="card-image-wrap"><img src="' + imgUrl + '" alt="' + r.label + ' result: +' + r.pct + '% in ' + r.time + '" loading="lazy" data-hires="' + hiResUrl + '"><div class="card-badge">+' + r.pct + '%</div></div>';
      html += '<div class="card-body"><div class="card-meta"><span class="card-type-tag">' + r.label + '</span> ' + r.time + '</div></div>';
      html += '</div>';
    });
    html += '</div>';

    // CTA
    html += '<div class="results-see-all">';
    html += '<a href="https://clients.moonraker.ai/results" class="cta-btn-outline" target="_blank" rel="noopener">See All 22 Client Results &#8594;</a>';
    html += '</div>';

    // Lightbox HTML
    html += '<div class="results-lightbox" id="resultsLightbox" onclick="window._closeResultLightbox()">';
    html += '<button class="results-lightbox-close" onclick="window._closeResultLightbox()">&times;</button>';
    html += '<div class="results-lightbox-inner" onclick="event.stopPropagation()">';
    html += '<img id="resultsLightboxImg" src="" alt="">';
    html += '<div class="results-lightbox-caption" id="resultsLightboxCaption"></div>';
    html += '</div></div>';

    // Lightbox JS (data embedded)
    html += '<script>';
    html += '(function(){';
    html += 'var rd=' + JSON.stringify(featured.map(function(r) { return { pct: r.pct, time: r.time, label: r.label, hires: 'https://lh3.googleusercontent.com/d/' + r.id + '=w1400' }; })) + ';';
    html += 'window._openResultLightbox=function(i){var r=rd[i],lb=document.getElementById("resultsLightbox");document.getElementById("resultsLightboxImg").src=r.hires;document.getElementById("resultsLightboxCaption").textContent=r.label+"  \\u00B7  +"+r.pct+"%  \\u00B7  "+r.time;lb.classList.add("open");document.body.style.overflow="hidden";};';
    html += 'window._closeResultLightbox=function(){document.getElementById("resultsLightbox").classList.remove("open");document.body.style.overflow="";};';
    html += 'document.addEventListener("keydown",function(e){if(e.key==="Escape")window._closeResultLightbox();});';
    html += 'var lb=document.getElementById("resultsLightbox");if(lb)document.body.appendChild(lb);';
    html += '})();';
    html += '</script>';

    return html;
  }

  // Replace template variables
  var html = templateHtml;

  // Sign a scope=proposal page token bound to this contact_id.
  // The token is baked into the HTML as window.__PAGE_TOKEN__ and sent with
  // every message the prospect chatbot sends to /api/proposal-chat, which
  // verifies it before hitting Anthropic. 60-day TTL (see page-token DEFAULT_TTL).
  var signedPageToken = '';
  try {
    signedPageToken = pageToken.sign({ scope: 'proposal', contact_id: contact.id });
  } catch (e) {
    // Config error (PAGE_TOKEN_SECRET missing) or validation error — fail the
    // generate rather than deploy a broken proposal page.
    return res.status(500).json({ error: 'Failed to sign page token: ' + e.message });
  }

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
    '{{RESULTS_SECTION}}': buildResultsSection(practiceType),
    '{{NEXT_STEPS_ITEMS}}': nextStepsHtml,
    '{{PAGE_TOKEN}}': signedPageToken
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
  //
  // Sign a scope='onboarding' token bound to this contact. The onboarding
  // page reads it as window.__PAGE_TOKEN__ and sends it on every call to
  // /api/onboarding-action, which verifies and uses the contact_id from the
  // token instead of from the request body.
  var signedOnboardingToken = '';
  try {
    signedOnboardingToken = pageToken.sign({ scope: 'onboarding', contact_id: contact.id });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to sign onboarding page token: ' + e.message });
  }

  var pagesToDeploy = [
    { dest: slug + '/proposal/index.html', content: html },
    { template: '_templates/router.html', dest: slug + '/index.html' },
    { template: '_templates/checkout.html', dest: slug + '/checkout/index.html' },
    { template: '_templates/onboarding.html', dest: slug + '/onboarding/index.html', replacements: { '{{PAGE_TOKEN}}': signedOnboardingToken } }
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

        // Apply any page-specific replacements (e.g. {{PAGE_TOKEN}} for onboarding)
        if (p.replacements) {
          Object.keys(p.replacements).forEach(function(key) {
            fileContent = fileContent.split(key).join(String(p.replacements[key]));
          });
        }
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
    await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contact.id, {
      method: 'PATCH', headers: sb.headers(),
      body: JSON.stringify({ checkout_options: { plans: checkoutPlans } })
    }).catch(function(){});
  }

  await fetch(sb.url() + '/rest/v1/proposals?id=eq.' + proposalId, {
    method: 'PATCH', headers: sb.headers(),
    body: JSON.stringify({
      status: 'ready',
      proposal_url: proposalUrl,
      checkout_url: checkoutUrl,
      proposal_content: generatedContent
    })
  }).catch(function(){});

  // ─── 7. Convert lead to prospect + seed onboarding ────────────
  results.conversion = {};
  try {
    // Flip status to prospect
    var convResp = await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contact.id, {
      method: 'PATCH', headers: sb.headers(),
      body: JSON.stringify({
        status: 'prospect',
        converted_from_lead_at: new Date().toISOString()
      })
    });
    results.conversion.status = convResp.ok ? 'prospect' : 'failed';

    // Seed 9 onboarding steps (delete existing first for idempotency)
    await fetch(sb.url() + '/rest/v1/onboarding_steps?contact_id=eq.' + contact.id, {
      method: 'DELETE', headers: sb.headers()
    });
    var onboardingSteps = [
      { contact_id: contact.id, step_key: 'confirm_info', label: 'Confirm Info', status: 'pending', sort_order: 1 },
      { contact_id: contact.id, step_key: 'sign_agreement', label: 'Sign Agreement', status: 'pending', sort_order: 2 },
      { contact_id: contact.id, step_key: 'book_intro_call', label: 'Book Intro Call', status: 'pending', sort_order: 3 },
      { contact_id: contact.id, step_key: 'connect_accounts', label: 'Connect Accounts', status: 'pending', sort_order: 4 },
      { contact_id: contact.id, step_key: 'practice_details', label: 'Practice Details', status: 'pending', sort_order: 5 },
      { contact_id: contact.id, step_key: 'bio_materials', label: 'Bio Materials', status: 'pending', sort_order: 6 },
      { contact_id: contact.id, step_key: 'social_profiles', label: 'Social Profiles', status: 'pending', sort_order: 7 },
      { contact_id: contact.id, step_key: 'checkins_and_drive', label: 'Google Drive', status: 'pending', sort_order: 8 },
      { contact_id: contact.id, step_key: 'performance_guarantee', label: 'Performance Guarantee', status: 'pending', sort_order: 9 }
    ];
    var seedResp = await fetch(sb.url() + '/rest/v1/onboarding_steps', {
      method: 'POST', headers: sb.headers(),
      body: JSON.stringify(onboardingSteps)
    });
    results.conversion.onboarding_steps = seedResp.ok ? 9 : 'failed';
  } catch (convErr) {
    results.conversion.error = convErr.message || String(convErr);
  }

  // ─── 8. Create Google Drive folder hierarchy ──────────────────
  var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var CLIENTS_FOLDER_ID = '1dymrrowTe1szsOJJPf45x4qDUit6J5jB';
  results.drive = {};

  if (contact.drive_folder_id) {
    results.drive.skipped = 'Drive folder already exists: ' + contact.drive_folder_id;
  } else if (saJson) {
    try {
      var practiceName = contact.practice_name || slug;
      var driveToken = await getDelegatedToken(saJson, 'support@moonraker.ai', 'https://www.googleapis.com/auth/drive');
      if (driveToken && typeof driveToken === 'string') {
        var driveHeaders = { 'Authorization': 'Bearer ' + driveToken, 'Content-Type': 'application/json' };

        // Create parent folder: Drive > Clients > [Practice Name]
        var parentFolder = await createDriveFolder(practiceName, CLIENTS_FOLDER_ID, driveHeaders);
        if (parentFolder && parentFolder.id) {
          results.drive.parent = { id: parentFolder.id, name: practiceName };

          // Top-level subfolders with nested children
          var folderTree = [
            { name: 'Creative', children: ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'] },
            { name: 'Docs', children: ['GBP Posts', 'Press Releases'] },
            { name: 'Optimization', children: [] },
            { name: 'Web Design', children: [] }
          ];

          var creativeFolderId = null;
          var createdSubs = [];

          for (var f = 0; f < folderTree.length; f++) {
            var node = folderTree[f];
            var sub = await createDriveFolder(node.name, parentFolder.id, driveHeaders);
            if (sub && sub.id) {
              createdSubs.push(node.name);
              if (node.name === 'Creative') creativeFolderId = sub.id;

              // Create children
              for (var c2 = 0; c2 < node.children.length; c2++) {
                var child = await createDriveFolder(node.children[c2], sub.id, driveHeaders);
                if (child && child.id) createdSubs.push(node.name + '/' + node.children[c2]);
              }
            }
          }
          results.drive.subfolders = createdSubs;

          // Write Creative folder ID to contacts for onboarding page
          if (creativeFolderId) {
            await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + contact.id, {
              method: 'PATCH', headers: sb.headers(),
              body: JSON.stringify({
                drive_folder_id: creativeFolderId,
                drive_folder_url: 'https://drive.google.com/drive/folders/' + creativeFolderId
              })
            });
            results.drive.creative_folder = 'https://drive.google.com/drive/folders/' + creativeFolderId;
          }
        } else {
          results.drive.error = 'Failed to create parent folder: ' + JSON.stringify(parentFolder);
        }
      } else {
        results.drive.error = 'Failed to get Drive token: ' + (driveToken && driveToken.error ? driveToken.error : 'unknown');
      }
    } catch (driveErr) {
      results.drive.error = driveErr.message || String(driveErr);
    }
  } else {
    results.drive.skipped = 'GOOGLE_SERVICE_ACCOUNT_JSON not configured';
  }

  return res.status(200).json({
    ok: true,
    proposal_url: proposalUrl,
    checkout_url: checkoutUrl,
    results: results
  });
};


// ═══════════════════════════════════════════════════════════════════
// Helper: Get access token via domain-wide delegation
// ═══════════════════════════════════════════════════════════════════
async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('SA JSON missing private_key or client_email');
    }
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: impersonateEmail,
      scope: scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })).toString('base64url');

    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');

    var jwt = signable + '.' + signature;

    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    }
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Create a folder in Google Drive
// ═══════════════════════════════════════════════════════════════════
async function createDriveFolder(name, parentId, headers) {
  try {
    var resp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });
    if (!resp.ok) {
      var errBody = await resp.text();
      return { error: 'Drive API ' + resp.status + ': ' + errBody };
    }
    return await resp.json();
  } catch (e) {
    return { error: e.message || String(e) };
  }
}












