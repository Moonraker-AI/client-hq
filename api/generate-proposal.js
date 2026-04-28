// /api/generate-proposal.js
// Generates personalized proposal content using Anthropic API and stores
// it as a new row in proposal_versions. The parent proposals row's
// active_version_id pointer is repointed to the new version, and the prior
// active version (if any) is retired with reason='regenerated'.
//
// Dynamic rendering takes over from here: /api/public-proposal reads the
// active version and renders at request time. No HTML is baked to GitHub.
//
// POST { proposal_id }
//
// Flow:
//   1. Load proposal + contact + enrichment from Supabase
//   2. Build context and call Anthropic for generatedContent (JSON)
//   3. Persist as a new proposal_versions row + repoint active_version_id
//      + retire prior active (if any)
//   4. Convert lead to prospect + seed 9 onboarding steps
//   5. Create Google Drive folder hierarchy
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var google = require('./_lib/google-delegated');
var crypto = require('./_lib/crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;


  var anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  var proposalId = (req.body || {}).proposal_id;
  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  var results = { generate: null };

  // ─── 1. Load proposal + contact ───────────────────────────────
  var proposal, contact;
  try {
    proposal = await sb.one('proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1');
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    contact = proposal.contacts;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load proposal: ' + e.message });
  }

  var slug = contact.slug;
  var enrichment = proposal.enrichment_data || {};

  // H29: decrypt the _sensitive envelope if present. Post-H29 enrichment
  // rows pack emails[]+calls[] inside enrichment_data._sensitive
  // (v1/v2-prefixed ciphertext string). Legacy rows (pre-backfill) still
  // have emails/calls as cleartext top-level arrays; both shapes work.
  if (enrichment._sensitive) {
    try {
      var decrypted = crypto.decryptJSON(enrichment._sensitive);
      if (decrypted && typeof decrypted === 'object') {
        if (Array.isArray(decrypted.emails)) enrichment.emails = decrypted.emails;
        if (Array.isArray(decrypted.calls)) enrichment.calls = decrypted.calls;
      }
    } catch (decErr) {
      // Fail loud: Claude prompt context will be missing email/call history
      // if decryption fails. Surface the error so we notice key misconfig.
      try {
        await monitor.logError('generate-proposal', decErr, {
          client_slug: slug,
          detail: { stage: 'decrypt_enrichment_sensitive', proposal_id: proposal.id }
        });
      } catch (_) { /* observability only */ }
      // Continue with empty emails/calls rather than failing the whole
      // proposal-generation; Claude will produce a reasonable proposal
      // without the email/call context, just less personalized.
      enrichment.emails = enrichment.emails || [];
      enrichment.calls = enrichment.calls || [];
    }
  }

  var campaigns = proposal.campaign_lengths || ['annual'];
  var billings = proposal.billing_options || [];
  var customPricing = proposal.custom_pricing || null;

  // Load practice_type for results section filtering
  var practiceType = 'group'; // default
  try {
    var pd = await sb.one('practice_details?contact_id=eq.' + contact.id + '&select=practice_type&limit=1');
    if (pd && pd.practice_type) {
      practiceType = pd.practice_type; // 'solo' or 'group'
    }
  } catch (e) { /* default to group */ }

  // Update status. M30: previously fire-and-forget (`.catch(function(){})`)
  // which swallowed every failure. Now awaited with error tracking so admin
  // sees partial state in `results` and server-side logs capture the detail.
  try {
    await sb.mutate('proposals?id=eq.' + proposalId, 'PATCH', { status: 'generating' });
  } catch (e) {
    results.status_update_error = e.message || String(e);
    monitor.logError('generate-proposal', e, {
      client_slug: slug,
      detail: { stage: 'set_status_generating', proposal_id: proposalId }
    });
  }

  // ─── 2. Build context and call Anthropic ──────────────────────
  var firstName = contact.first_name || '';
  var lastName = contact.last_name || '';
  var fullName = (firstName + ' ' + lastName).trim();
  var nameWithCreds = fullName + (contact.credentials ? ', ' + contact.credentials : '');
  var practiceName = contact.practice_name || fullName;
  var location = [contact.city, contact.state_province].filter(Boolean).join(', ') || '';

  // Determine primary campaign display
  var primaryCampaign = campaigns.includes('annual') ? 'annual' : campaigns.includes('quarterly') ? 'quarterly' : 'monthly';
  var campaignDisplay = { annual: '12-Month CORE Campaign', quarterly: '3-Month Growth Engagement', monthly: 'Monthly CORE Engagement' };
  var priceDisplay = { annual: '$20,000', quarterly: '$5,000', monthly: '$2,000' };
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
  "exec_summary_paragraphs": "2-3 paragraphs in HTML that show we understand their practice, goals, and challenges. Reference specific details from calls, emails, or website. Wrap EVERY paragraph in <p class=\"lead\">...</p> so font sizing stays consistent across the section.",
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
    // M30: previously `.catch(function(){})`. We still return 500 below so
    // admin sees the generation failure, but we log the record-failure path
    // separately if the status-flip itself fails (DB would still hold the
    // prior status — admin can retry).
    try {
      await sb.mutate('proposals?id=eq.' + proposalId, 'PATCH', {
        status: 'review',
        notes: 'Generation failed: ' + (e.message || String(e))
      });
    } catch (patchErr) {
      monitor.logError('generate-proposal', patchErr, {
        client_slug: slug,
        detail: { stage: 'record_generation_failure', proposal_id: proposalId }
      });
    }
    return res.status(500).json({ error: 'AI generation failed', details: e.message, results: results });
  }

  // ─── 3. Persist generated content as a new proposal version ────
  //
  // Layout the content with AI-fallback defaults so a missing field from
  // the model doesn't leave users staring at an empty hero/findings
  // section. These defaults mirror the ones the old template-fill step
  // used to apply at bake time. Here we bake them into the JSONB row
  // so every downstream reader gets the same safety net.
  var defaultNextSteps = [
    { title: 'Choose Your Plan', desc: 'Click the button below to select your payment method and complete your investment. We offer both bank transfer (ACH) and credit card options.' },
    { title: 'Sign Your Agreement', desc: 'After payment, you will be directed to our client portal where you can review and electronically sign our service agreement.' },
    { title: 'Book Your Onboarding Call', desc: 'Schedule a 60-75 minute call with Scott, our Director of Growth. We will set up accounts, define your target keywords, and align on campaign strategy together.' },
    { title: 'We Get to Work', desc: 'Within the first week, our team starts the deep audit of your practice. You will see content drafts for review, and your digital footprint begins taking shape immediately.' }
  ];
  var versionContent = Object.assign({}, generatedContent);
  if (!versionContent.hero_headline) versionContent.hero_headline = 'Your Practice Deserves to Be Found';
  if (!versionContent.scores || typeof versionContent.scores !== 'object') {
    versionContent.scores = { c: 3, o: 3, r: 3, e: 3 };
  }
  if (!Array.isArray(versionContent.next_steps) || !versionContent.next_steps.length) {
    versionContent.next_steps = defaultNextSteps;
  }

  var proposalUrl = 'https://clients.moonraker.ai/' + slug + '/proposal';
  var checkoutUrl = 'https://clients.moonraker.ai/' + slug + '/checkout';
  var nowIso = new Date().toISOString();

  // Also update checkout_options on the contact.
  // M30: was `.catch(function(){})`. Non-critical, but surface failures in results.
  var checkoutPlans = billings.length ? billings : null;
  if (checkoutPlans) {
    try {
      await sb.mutate('contacts?id=eq.' + contact.id, 'PATCH', {
        checkout_options: { plans: checkoutPlans }
      });
    } catch (e) {
      results.checkout_options_error = e.message || String(e);
    }
  }

  // STEP A — Retire the previously-active version, if any. Non-fatal:
  // if retire fails we still want the new version written so the proposal
  // can serve. Any stale un-retired row is a minor audit-trail blemish,
  // not a user-facing problem.
  if (proposal.active_version_id) {
    try {
      await sb.mutate('proposal_versions?id=eq.' + proposal.active_version_id, 'PATCH', {
        retired_at: nowIso,
        retired_reason: 'regenerated'
      }, 'return=minimal');
    } catch (e) {
      results.retire_prior_error = e.message || String(e);
      monitor.logError('generate-proposal', e, {
        client_slug: slug,
        detail: { stage: 'retire_prior_version', proposal_id: proposalId, prior_version_id: proposal.active_version_id }
      });
    }
  }

  // STEP B — Insert the new version. Fatal on failure: we abort rather
  // than leave the parent proposals row pointing at a now-retired version
  // with no successor.
  var priorVersionCount = proposal.version_count || 0;
  var newVersionNumber = priorVersionCount + 1;
  var newVersion = null;
  try {
    var inserted = await sb.mutate('proposal_versions', 'POST', {
      proposal_id:      proposalId,
      contact_id:       contact.id,
      version_number:   newVersionNumber,
      proposal_content: versionContent,
      campaign_lengths: campaigns,
      billing_options:  billings,
      custom_pricing:   customPricing,
      generated_at:     nowIso,
      generated_by:     'api:generate-proposal'
    }, 'return=representation');
    newVersion = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!newVersion || !newVersion.id) {
      throw new Error('proposal_versions INSERT returned no row');
    }
  } catch (e) {
    results.version_insert_error = e.message || String(e);
    monitor.logError('generate-proposal', e, {
      client_slug: slug,
      detail: { stage: 'insert_new_version', proposal_id: proposalId, attempted_version_number: newVersionNumber }
    });
    // Try to flip status back to 'review' so admin sees the failure in the UI
    // rather than a stuck 'generating'. The prior version, if any, was already
    // retired in STEP A — the proposal is in a degraded state that regeneration
    // will fix on retry.
    try {
      await sb.mutate('proposals?id=eq.' + proposalId, 'PATCH', {
        status: 'review',
        notes: 'Version insert failed: ' + (e.message || String(e))
      });
    } catch (_) { /* observability already logged */ }
    return res.status(500).json({ error: 'Failed to persist new proposal version', details: e.message, results: results });
  }

  // STEP C — Repoint the parent proposals row at the new version, bump
  // version_count, flip status to 'ready', set URLs. Tracked in
  // results.finalize_error consistent with the prior flow.
  try {
    await sb.mutate('proposals?id=eq.' + proposalId, 'PATCH', {
      status:            'ready',
      proposal_url:      proposalUrl,
      checkout_url:      checkoutUrl,
      active_version_id: newVersion.id,
      version_count:     newVersionNumber
    }, 'return=minimal');
  } catch (e) {
    results.finalize_error = e.message || String(e);
    monitor.logError('generate-proposal', e, {
      client_slug: slug,
      detail: { stage: 'finalize_proposal', proposal_id: proposalId, new_version_id: newVersion.id }
    });
  }

  results.version = {
    new_version_id:      newVersion.id,
    new_version_number:  newVersionNumber,
    retired_prior_id:    proposal.active_version_id || null
  };

  // ─── 4. Convert lead to prospect + seed onboarding ────────────
  results.conversion = {};
  try {
    // Flip status to prospect
    try {
      await sb.mutate('contacts?id=eq.' + contact.id, 'PATCH', {
        status: 'prospect',
        converted_from_lead_at: new Date().toISOString()
      });
      results.conversion.status = 'prospect';
    } catch (e) {
      results.conversion.status = 'failed';
      results.conversion.status_error = e.message || String(e);
    }

    // Seed onboarding steps. H26: previously DELETE-then-POST which left a
    // zero-step window if the invocation died between the two calls — the
    // auto_promote_to_active trigger (pending→complete) would then never fire.
    // Fix: upsert on UNIQUE(contact_id, step_key) so a re-run is idempotent,
    // and do a targeted DELETE of any *stale* steps whose keys aren't in the
    // current template (e.g. if the template shrank between regenerations).
    // No all-or-nothing wipe; no zero-row window.
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
    var currentKeys = onboardingSteps.map(function (s) { return s.step_key; }).join(',');
    // Stale-row cleanup: remove only steps whose keys are NOT in the new template.
    // Scoped by contact_id so it can never touch another contact's rows.
    try {
      await sb.mutate(
        'onboarding_steps?contact_id=eq.' + contact.id + '&step_key=not.in.(' + currentKeys + ')',
        'DELETE',
        null,
        'return=minimal'
      );
    } catch (e) {
      // Non-fatal: stale rows don't block the upsert itself, they just leave extra
      // rows the client will see. Surface in results so it's visible in admin UI.
      results.conversion.stale_cleanup_error = e.message || String(e);
    }
    try {
      await sb.mutate('onboarding_steps', 'POST', onboardingSteps, 'resolution=merge-duplicates,return=minimal');
      results.conversion.onboarding_steps = onboardingSteps.length;
    } catch (e) {
      results.conversion.onboarding_steps = 'failed';
      results.conversion.onboarding_error = e.message || String(e);
    }
  } catch (convErr) {
    results.conversion.error = convErr.message || String(convErr);
  }

  // ─── 5. Create Google Drive folder hierarchy ──────────────────
  var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  // M23 (2026-04-18): DRIVE_CLIENTS_FOLDER_ID is the shared parent folder
  // containing all per-client subfolders; read from env instead of a
  // hardcoded literal. Per-client subfolder IDs still flow through
  // contacts.drive_folder_id (created on-demand at L690 below) -- this env
  // var is only the parent. Missing env var skips the Drive-folder-create
  // block with the same "skipped" shape as missing GOOGLE_SERVICE_ACCOUNT_JSON;
  // the proposal itself continues successfully.
  var CLIENTS_FOLDER_ID = process.env.DRIVE_CLIENTS_FOLDER_ID;
  results.drive = {};

  if (contact.drive_folder_id) {
    results.drive.skipped = 'Drive folder already exists: ' + contact.drive_folder_id;
  } else if (!CLIENTS_FOLDER_ID) {
    results.drive.skipped = 'DRIVE_CLIENTS_FOLDER_ID env var not configured';
    try {
      await monitor.logError('generate-proposal', new Error('DRIVE_CLIENTS_FOLDER_ID not configured'), {
        client_slug: slug,
        detail: { stage: 'drive_folder_create' }
      });
    } catch (_) { /* observability-only; don't mask the 200 */ }
  } else if (saJson) {
    try {
      var practiceName = contact.practice_name || slug;
      var driveToken;
      try {
        driveToken = await google.getDelegatedAccessToken('support@moonraker.ai', 'https://www.googleapis.com/auth/drive');
      } catch (tokenErr) {
        results.drive.error = 'Failed to get Drive token: ' + (tokenErr.message || String(tokenErr));
      }
      if (driveToken) {
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
            await sb.mutate('contacts?id=eq.' + contact.id, 'PATCH', {
              drive_folder_id: creativeFolderId,
              drive_folder_url: 'https://drive.google.com/drive/folders/' + creativeFolderId
            });
            results.drive.creative_folder = 'https://drive.google.com/drive/folders/' + creativeFolderId;
          }
        } else {
          results.drive.error = 'Failed to create parent folder: ' + JSON.stringify(parentFolder);
        }
      }
    } catch (driveErr) {
      monitor.logError('generate-proposal', driveErr, {
        client_slug: slug,
        detail: { stage: 'create_drive_folders' }
      });
      results.drive.error = 'Drive folder creation failed';
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
      return { error: 'Drive folder creation failed (HTTP ' + resp.status + ')' };
    }
    return await resp.json();
  } catch (e) {
    return { error: 'Drive folder creation failed' };
  }
}













