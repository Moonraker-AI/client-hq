// /api/process-entity-audit.js
// Processes pasted Surge data into a structured entity audit.
// Uses NDJSON streaming to keep the connection alive during long processing.
// 1. Sends Surge data to Claude for structured extraction
// 2. Updates entity_audits row with scores (promoted columns + JSONB detail)
// 3. Writes individual checklist_items rows (structured, trackable, reportable)
// 4. Deploys scorecard page from template to GitHub
// 5. For active/onboarding clients, also deploys the 3-page audit suite

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var gh = require('./_lib/github');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var ghToken = process.env.GITHUB_PAT;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var auditId = body.audit_id;
  var surgeData = body.surge_data;

  if (!auditId || !surgeData) return res.status(400).json({ error: 'audit_id and surge_data required' });

  // Switch to streaming mode: NDJSON (newline-delimited JSON)
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function send(obj) {
    res.write(JSON.stringify(obj) + '\n');
    if (typeof res.flush === 'function') res.flush();
  }

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';


  try {
    // ============================================================
    // STEP 1: Look up audit + contact
    // ============================================================
    send({ step: 'lookup', message: 'Looking up audit record...' });

    var auditResp = await fetch(sb.url() + '/rest/v1/entity_audits?id=eq.' + auditId + '&select=*', {
      headers: sb.headers()
    });
    var audits = await auditResp.json();
    if (!audits || audits.length === 0) {
      send({ step: 'error', message: 'Audit not found' });
      return res.end();
    }
    var audit = audits[0];

    var contactResp = await fetch(sb.url() + '/rest/v1/contacts?id=eq.' + audit.contact_id + '&select=*', {
      headers: sb.headers()
    });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) {
      send({ step: 'error', message: 'Contact not found' });
      return res.end();
    }
    var contact = contacts[0];

    var practiceName = contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim();
    var slug = contact.slug;
    var isActiveCampaign = contact.status === 'active' || contact.status === 'onboarding';

    send({ step: 'lookup_done', message: 'Found: ' + practiceName + ' (' + contact.status + ')' });

    // ============================================================
    // STEP 2: Call Claude to process Surge data
    // ============================================================
    send({ step: 'claude', message: 'Analyzing with Claude Opus (this takes 2-4 minutes)...' });

    // Keep-alive: send a heartbeat every 15s while Claude is processing
    var heartbeat = setInterval(function() {
      send({ step: 'heartbeat', message: 'Still processing...' });
    }, 15000);

    var claudePrompt = `You are processing Surge audit data for an entity audit. The practice is "${practiceName}" at ${audit.homepage_url}.

Analyze the Surge data below and return ONLY a valid JSON object (no markdown, no backticks, no explanation) with this exact structure:

{
  "scores": {
    "credibility": <number 1-10>,
    "optimization": <number 1-10>,
    "reputation": <number 1-10>,
    "engagement": <number 1-10>,
    "variance": <number 0-100>,
    "variance_desc": "<one sentence describing the variance score meaning>",
    "summary": "<2-3 paragraphs of HTML summarizing the audit findings. Use <strong> for emphasis. Do not use em dashes. Focus on: what is working, what is the core challenge, and what the path forward looks like.>",
    "quick_wins": ["<quick win 1>", "<quick win 2>", "<quick win 3>", "<quick win 4>", "<quick win 5>"],
    "rtpba": "<HTML version of the Ready-to-Publish Best Answer content from Section 3 of the Surge data. Format as clean HTML paragraphs with <h4> for the main heading, <p> for paragraphs, <strong> for emphasis, and <ul>/<li> for any lists. Preserve ALL of the Surge RTPBA content, do not summarize or truncate. If no RTPBA section is found in the Surge data, use null.>",
    "brand_dataset_variance": <number 0-100 or null>,
    "search_intent_match": <number 0-1 or null>,
    "topical_depth": <number 0-100 or null>,
    "local_eeat": <number 0-100 or null>,
    "multimodal_coverage": <number 0-100 or null>,
    "structured_data_stack": <number 0-1 or null>,
    "faq_coverage": <number 0-1 or null>,
    "internal_linking": <number 0-1 or null>,
    "ai_extraction_readiness": <number 0-100 or null>,
    "citation_gap_index": <number 0-1 or null>,
    "unique_value_index": "<string label or null>",
    "first_party_evidence": <number 0-10 or null>,
    "content_authenticity": <number 0-10 or null>,
    "reputation_signal": "<string label or null>",
    "entity_recognition": <number 0-10 or null>,
    "performance_ux": <number 0-100 or null>
  },
  "citations": {
    "google_ai": <true|false>,
    "chatgpt": <true|false>,
    "claude": <true|false>,
    "perplexity": <true|false>,
    "bing": <true|false>,
    "youtube": <true|false>,
    "reddit": <true|false>,
    "meta": <true|false>
  },
  "tasks": {
    "credibility": [
      {
        "severity": "critical|warning|positive",
        "title": "<short finding title>",
        "detail": "<1-2 sentence explanation of the finding>",
        "fix": "<HTML with step-by-step DIY fix instructions. Use <p>, <ol class='step-list'><li>...</li></ol>, and <pre><code>...</code></pre> for schema examples. Include actual schema code snippets where relevant. Anonymize the practice name as [Practice Name] in code examples.>",
        "owner": "Moonraker|Client|Collaboration",
        "scope": "on-page|off-page"
      }
    ],
    "optimization": [...],
    "reputation": [...],
    "engagement": [...]
  }
}

SCORING GUIDELINES:
- Credibility (1-10): Weighted from Entity Recognition, Knowledge Graph, Content Authenticity, DNS/directory presence, GBP status
- Optimization (1-10): Weighted from Topical Depth, AI Extraction Readiness, Structured Data Stack, FAQ Coverage, heading hierarchy
- Reputation (1-10): Weighted from Reputation Signal, Citation Gap, Unique Value Index, review visibility, endorsements
- Engagement (1-10): Weighted from Performance/UX, CTA clarity, booking pathway, content freshness
- Variance (0-100): Overall gap score. 0 = perfect, 100 = critical. Weight entity recognition gaps heavily.
- Extract the detailed metric values from the Surge data into the scores object (brand_dataset_variance through performance_ux). Use null if a metric is not present in the Surge data.

CITATION TRACKING:
- Check the Surge data for any mention of AI platform citations/mentions (Google AI Overview, ChatGPT, Claude, Perplexity, Bing Copilot, YouTube, Reddit, Meta AI)
- Set each to true if the practice is mentioned/cited by that platform, false otherwise

SEVERITY RULES:
- "critical" = red dot, something broken or missing that blocks AI visibility
- "warning" = yellow dot, something suboptimal that limits performance
- "positive" = green dot, something that is working well

TASK RULES:
- Frame ALL tasks as DIY self-service: "Here is what to do" not "We will do this"
- Include actual schema code in fix instructions where relevant (brand.jsonld, AggregateRating, FAQPage, VideoObject, Service)
- Be specific with metric values from the Surge data
- Each pillar should have 3-6 findings (mix of critical, warning, and positive)
- Do not use em dashes anywhere
- "owner" should be: "Moonraker" for technical SEO tasks we control (schema markup, code changes, structured data, content writing, on-site optimization, BrightLocal citations, data aggregator submissions), "Client" for tasks requiring their direct involvement (GBP verification/optimization, review responses, credential documentation, booking calendar, AND all paid or third-party directory profiles such as Psychology Today, TherapyDen, ZocDoc, GoodTherapy, TherapyRoute, Healthgrades, Vitals, Open Path, Alma, Headway, or any similar platform where the client must create/manage their own account), "Collaboration" for tasks requiring both parties (content review, bio updates, media/photos)
- "scope" should be: "on-page" for changes to the practice website itself, "off-page" for everything external including GBP, directories, social media, reviews, citations, and third-party profiles

SURGE DATA:
${surgeData}`;

    var claudeErr;
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
          messages: [{ role: 'user', content: claudePrompt }]
        })
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (!claudeResp.ok) {
      claudeErr = await claudeResp.text();
      send({ step: 'error', message: 'Claude API error: ' + claudeErr.substring(0, 300) });
      return res.end();
    }

    var claudeData = await claudeResp.json();
    var rawText = claudeData.content.map(function(c) { return c.text || ''; }).join('');

    send({ step: 'claude_done', message: 'Analysis complete. Parsing results...' });

    // Parse JSON from Claude's response (strip any markdown fences)
    var cleanJson = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (parseErr) {
      send({ step: 'error', message: 'Failed to parse Claude response as JSON', raw: cleanJson.substring(0, 500) });
      return res.end();
    }

    // ============================================================
    // STEP 3: Update entity_audits row (promoted columns + JSONB)
    // ============================================================
    send({ step: 'supabase', message: 'Saving scores and findings...' });

    var scores = parsed.scores || {};
    var citations = parsed.citations || {};
    var tasks = parsed.tasks || {};

    // Count tasks by priority and owner
    var allTasks = [];
    var pillars = ['credibility', 'optimization', 'reputation', 'engagement'];
    pillars.forEach(function(pillar) {
      (tasks[pillar] || []).forEach(function(t) {
        allTasks.push(Object.assign({}, t, { pillar: pillar }));
      });
    });

    var taskCounts = { p1: 0, p2: 0, p3: 0, moonraker: 0, client: 0, collaboration: 0 };
    allTasks.forEach(function(t) {
      if (t.severity === 'critical') taskCounts.p1++;
      else if (t.severity === 'warning') taskCounts.p2++;
      else taskCounts.p3++;
      var owner = (t.owner || '').toLowerCase();
      if (owner === 'moonraker') taskCounts.moonraker++;
      else if (owner === 'client') taskCounts.client++;
      else taskCounts.collaboration++;
    });

    var cresScore = (scores.credibility || 0) + (scores.optimization || 0) +
                    (scores.reputation || 0) + (scores.engagement || 0);

    var updateBody = {
      // JSONB columns (scores + metadata for templates)
      scores: scores,
      surge_data: { raw_length: surgeData.length, processed_at: new Date().toISOString() },
      // Promoted score columns (queryable across clients)
      variance_score: scores.variance || null,
      variance_label: scores.variance_desc || null,
      cres_score: cresScore,
      score_credibility: scores.credibility || null,
      score_optimization: scores.optimization || null,
      score_reputation: scores.reputation || null,
      score_engagement: scores.engagement || null,
      // Task counts
      total_tasks: allTasks.length,
      tasks_p1: taskCounts.p1,
      tasks_p2: taskCounts.p2,
      tasks_p3: taskCounts.p3,
      tasks_moonraker: taskCounts.moonraker,
      tasks_client: taskCounts.client,
      tasks_collaboration: taskCounts.collaboration,
      // Citation booleans
      cited_google_ai: citations.google_ai || false,
      cited_chatgpt: citations.chatgpt || false,
      cited_claude: citations.claude || false,
      cited_perplexity: citations.perplexity || false,
      cited_bing: citations.bing || false,
      cited_youtube: citations.youtube || false,
      cited_reddit: citations.reddit || false,
      cited_meta: citations.meta || false,
      // Metadata
      client_slug: slug,
      status: 'complete'
    };

    var updateResp = await fetch(sb.url() + '/rest/v1/entity_audits?id=eq.' + auditId, {
      method: 'PATCH',
      headers: Object.assign({}, sb.headers(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(updateBody)
    });

    if (!updateResp.ok) {
      var updateErr = await updateResp.text();
      send({ step: 'error', message: 'Supabase update failed: ' + updateErr.substring(0, 200) });
      return res.end();
    }

    send({ step: 'supabase_done', message: 'Entity audit scores saved.' });

    // ============================================================
    // STEP 4: Write checklist_items (structured, trackable tasks)
    // ============================================================
    send({ step: 'checklist', message: 'Creating ' + allTasks.length + ' structured task records...' });

    // Delete any existing checklist_items for this audit (re-processing support)
    await fetch(sb.url() + '/rest/v1/checklist_items?audit_id=eq.' + auditId, {
      method: 'DELETE',
      headers: Object.assign({}, sb.headers(), { 'Prefer': 'return=minimal' })
    });

    // Map severity to priority
    function severityToPriority(sev) {
      if (sev === 'critical') return 'P1';
      if (sev === 'warning') return 'P2';
      return 'P3';
    }

    // Map pillar + priority to phase groupings
    function pillarToPhase(pillar, priority) {
      if (priority === 'P1') return 'Entity Identity + Schema';
      if (priority === 'P2') return 'Content Structure';
      return 'Growth + Amplification';
    }

    // Map pillar to display category
    function pillarToCategory(pillar) {
      if (pillar === 'credibility') return 'Credibility + Entity Identity';
      if (pillar === 'optimization') return 'Optimization + Content';
      if (pillar === 'reputation') return 'Reputation + Citations';
      return 'Engagement + UX';
    }

    // Build checklist_items rows
    var checklistRows = allTasks.map(function(t, idx) {
      var priority = severityToPriority(t.severity);
      return {
        id: auditId.substring(0, 8) + '-' + String(idx + 1).padStart(3, '0'),
        client_slug: slug,
        audit_id: auditId,
        audit_period: audit.audit_period || 'initial',
        task_id: String(idx + 1),
        priority: priority,
        category: pillarToCategory(t.pillar),
        scope: t.scope || 'on-page',
        title: t.title,
        description: (t.detail || '') + (t.fix ? '\n\n' + t.fix : ''),
        owner: t.owner || 'Moonraker',
        status: t.severity === 'positive' ? 'complete' : 'not_started',
        phase: pillarToPhase(t.pillar, priority),
        web_visible: true,
        sort_order: idx + 1,
        notes: ''
      };
    });

    // Batch insert checklist_items
    if (checklistRows.length > 0) {
      var insertResp = await fetch(sb.url() + '/rest/v1/checklist_items', {
        method: 'POST',
        headers: Object.assign({}, sb.headers(), { 'Prefer': 'return=minimal' }),
        body: JSON.stringify(checklistRows)
      });

      if (!insertResp.ok) {
        var insertErr = await insertResp.text();
        send({ step: 'checklist_warning', message: 'Checklist insert issue: ' + insertErr.substring(0, 200) });
        // Continue, non-fatal
      } else {
        send({ step: 'checklist_done', message: checklistRows.length + ' tasks created in checklist_items.' });
      }
    }

    // ============================================================
    // STEP 5: Deploy scorecard page from template to GitHub
    // ============================================================
    send({ step: 'deploy', message: 'Deploying scorecard page...' });

    var ghHeaders = {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Read the scorecard template
    var tmplResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/_templates/entity-audit.html?ref=' + BRANCH, {
      headers: ghHeaders
    });
    var githubDeployed = false;
    var checkoutDeployed = false;
    var suiteDeployed = false;

    if (tmplResp.ok) {
      var tmplData = await tmplResp.json();

      // Check if destination exists
      var destPath = slug + '/entity-audit/index.html';
      var sha = null;
      var checkResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + destPath + '?ref=' + BRANCH, {
        headers: ghHeaders
      });
      if (checkResp.ok) {
        sha = (await checkResp.json()).sha;
      }

      // Push the template as the scorecard page
      var pushBody = {
        message: 'Deploy entity audit scorecard for ' + slug,
        content: tmplData.content.replace(/\n/g, ''),
        branch: BRANCH
      };
      if (sha) pushBody.sha = sha;

      var pushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + destPath, {
        method: 'PUT',
        headers: ghHeaders,
        body: JSON.stringify(pushBody)
      });
      githubDeployed = pushResp.ok;

      // Deploy checkout page
      send({ step: 'deploy_checkout', message: 'Deploying checkout page...' });

      var checkoutTmplResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/_templates/entity-audit-checkout.html?ref=' + BRANCH, {
        headers: ghHeaders
      });
      if (checkoutTmplResp.ok) {
        var checkoutTmplData = await checkoutTmplResp.json();
        var checkoutPath = slug + '/entity-audit-checkout/index.html';
        var checkoutSha = null;
        var checkoutCheck = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + checkoutPath + '?ref=' + BRANCH, {
          headers: ghHeaders
        });
        if (checkoutCheck.ok) {
          checkoutSha = (await checkoutCheck.json()).sha;
        }
        var checkoutPush = {
          message: 'Deploy entity audit checkout for ' + slug,
          content: checkoutTmplData.content.replace(/\n/g, ''),
          branch: BRANCH
        };
        if (checkoutSha) checkoutPush.sha = checkoutSha;
        var checkoutPushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + checkoutPath, {
          method: 'PUT',
          headers: ghHeaders,
          body: JSON.stringify(checkoutPush)
        });
        checkoutDeployed = checkoutPushResp.ok;
      }

      // ============================================================
      // STEP 6: For active/onboarding clients, deploy 3-page audit suite
      // ============================================================
      if (isActiveCampaign) {
        send({ step: 'deploy_suite', message: 'Deploying campaign audit suite (diagnosis, action plan, progress)...' });

        var suiteTemplates = [
          { template: 'diagnosis.html', dest: slug + '/audits/diagnosis/index.html' },
          { template: 'action-plan.html', dest: slug + '/audits/action-plan/index.html' },
          { template: 'progress.html', dest: slug + '/audits/progress/index.html' }
        ];

        var suiteResults = [];
        for (var i = 0; i < suiteTemplates.length; i++) {
          var st = suiteTemplates[i];
          // Small delay between GitHub pushes
          if (i > 0) await new Promise(function(r) { setTimeout(r, 600); });

          var stTmplResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/_templates/' + st.template + '?ref=' + BRANCH, {
            headers: ghHeaders
          });
          if (!stTmplResp.ok) {
            suiteResults.push({ template: st.template, deployed: false, reason: 'template not found' });
            continue;
          }
          var stTmplData = await stTmplResp.json();

          var stSha = null;
          var stCheck = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + st.dest + '?ref=' + BRANCH, {
            headers: ghHeaders
          });
          if (stCheck.ok) {
            stSha = (await stCheck.json()).sha;
          }

          var stPush = {
            message: 'Deploy audit ' + st.template.replace('.html', '') + ' for ' + slug,
            content: stTmplData.content.replace(/\n/g, ''),
            branch: BRANCH
          };
          if (stSha) stPush.sha = stSha;

          var stPushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + st.dest, {
            method: 'PUT',
            headers: ghHeaders,
            body: JSON.stringify(stPush)
          });
          suiteResults.push({ template: st.template, deployed: stPushResp.ok });
        }

        suiteDeployed = suiteResults.every(function(r) { return r.deployed; });
        send({ step: 'deploy_suite_done', message: 'Audit suite: ' + suiteResults.filter(function(r) { return r.deployed; }).length + '/3 pages deployed.' });
      }
    } else {
      send({ step: 'deploy_warning', message: 'Template not found, skipping GitHub deploy.' });
    }

    // ============================================================
    // STEP 7: Finalize + auto-delivery for lead audits
    // ============================================================
    send({ step: 'finalize', message: 'Finalizing...' });

    // Auto-deliver for lead entity audits
    if (contact.status === 'lead' && audit.audit_tier === 'free') {
      send({ step: 'auto_send', message: 'Sending scorecard email automatically (free lead audit)...' });
      try {
        var sendResp = await fetch('https://clients.moonraker.ai/api/send-audit-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audit_id: auditId })
        });
        if (sendResp.ok) {
          send({ step: 'auto_send_done', message: 'Scorecard email sent to ' + (contact.email || 'client') });
        } else {
          var sendErr = '';
          try { sendErr = (await sendResp.json()).error || ''; } catch(e) {}
          send({ step: 'auto_send_warning', message: 'Auto-send failed (' + sendResp.status + '): ' + sendErr + '. Team can send manually.' });
        }
      } catch (sendEx) {
        send({ step: 'auto_send_warning', message: 'Auto-send error: ' + sendEx.message + '. Team can send manually.' });
      }
    } else if (contact.status === 'lead' && audit.audit_tier === 'premium') {
      // Premium lead audit: notify team to add Loom and review
      send({ step: 'notify_team', message: 'Notifying team to review premium audit...' });
      try {
        var resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
              to: ['notifications@clients.moonraker.ai'],
              subject: 'Premium Entity Audit Ready for Review - ' + practiceName,
              html: '<p>A premium entity audit has been processed and is ready for your review.</p>' +
                '<p><strong>Client:</strong> ' + contact.first_name + ' ' + contact.last_name + '</p>' +
                '<p><strong>Practice:</strong> ' + practiceName + '</p>' +
                '<p><strong>CRES Score:</strong> ' + (cresScore || 'N/A') + '</p>' +
                '<p style="margin-top:16px;"><strong>Next steps:</strong></p>' +
                '<ol><li>Record a personalized Loom walkthrough</li><li>Add the Loom URL to the audit in admin</li><li>Send the delivery email from admin</li></ol>' +
                '<p><a href="https://clients.moonraker.ai/admin/clients#audit-' + auditId + '">Open in Admin</a></p>'
            })
          });
          send({ step: 'notify_team_done', message: 'Team notified. Premium audit awaiting Loom review.' });
        }
      } catch (notifyEx) {
        send({ step: 'notify_team_warning', message: 'Team notification failed: ' + notifyEx.message });
      }
    }

    send({
      step: 'done',
      success: true,
      scores: {
        credibility: scores.credibility,
        optimization: scores.optimization,
        reputation: scores.reputation,
        engagement: scores.engagement,
        variance: scores.variance,
        cres: cresScore
      },
      task_counts: {
        total: allTasks.length,
        p1: taskCounts.p1,
        p2: taskCounts.p2,
        p3: taskCounts.p3,
        moonraker: taskCounts.moonraker,
        client: taskCounts.client,
        collaboration: taskCounts.collaboration
      },
      checklist_items_created: checklistRows.length,
      scorecard_url: 'https://clients.moonraker.ai/' + slug + '/entity-audit',
      checkout_url: 'https://clients.moonraker.ai/' + slug + '/entity-audit-checkout',
      github_deployed: githubDeployed,
      checkout_deployed: checkoutDeployed,
      suite_deployed: suiteDeployed,
      is_campaign_audit: isActiveCampaign
    });

    return res.end();

  } catch (err) {
    try { send({ step: 'error', message: err.message }); } catch (e) { /* stream may be closed */ }
    return res.end();
  }
};



