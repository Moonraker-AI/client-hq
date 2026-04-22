// /api/process-entity-audit.js
// Processes pasted Surge data into a structured entity audit.
// Uses NDJSON streaming to keep the connection alive during long processing.
// 1. Sends Surge data to Claude for structured extraction
// 2. Updates entity_audits row with scores (promoted columns + JSONB detail)
// 3. Writes individual checklist_items rows (structured, trackable, reportable)
// 4. Deploys scorecard page from template to GitHub
// 5. For active/onboarding clients, also deploys the 3-page audit suite
// 6. Nulls entity_audits.surge_raw_data on success. The column is the
//    agent's safety-net capture (written pre-callback so a failed callback
//    can be recovered via /api/admin/reprocess-entity-audit) and is no
//    longer needed once scores + checklist rows have landed. Recovery
//    callers that PATCH surge_raw_data back in can re-invoke this handler
//    and the same nulling will fire on re-success.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var gh = require('./_lib/github');
var fetchT = require('./_lib/fetch-with-timeout');
var sanitizer = require('./_lib/html-sanitizer');
var jsonParser = require('./_lib/json-parser');
var pageToken = require('./_lib/page-token');

// Apply any {{KEY}} replacements to a template HTML string. Kept as a
// helper even though no templates here use placeholders today — keeps
// the structure ready for future placeholder substitution (M40,
// 2026-04-19: simplified to utf8 in/out now that callers go through
// gh.readTemplate + gh.pushFile which handle base64 framing).
function prepTemplate(html, replacements) {
  if (replacements) {
    Object.keys(replacements).forEach(function(key) {
      html = html.split(key).join(String(replacements[key]));
    });
  }
  return html;
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;


  var anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!gh.isConfigured()) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var auditId = body.audit_id;
  var surgeData = body.surge_data;

  if (!auditId) return res.status(400).json({ error: 'audit_id required' });

  // Recovery path: if surge_data not in request body, try reading from the
  // surge_raw_data column (saved by the agent before callback attempt)
  if (!surgeData) {
    try {
      var auditRow = await sb.one('entity_audits?id=eq.' + auditId + '&select=surge_raw_data&limit=1');
      if (auditRow && auditRow.surge_raw_data) {
        surgeData = auditRow.surge_raw_data;
      }
    } catch (e) { /* ignore, will fail below */ }
  }

  if (!surgeData) return res.status(400).json({ error: 'surge_data required (not in request body or surge_raw_data column)' });

  // Push 2 (2026-04-21): Reciprocal truncation guard.
  //
  // The agent has its own Phase 3 callback guard (MIN_RAW_CHARS_FOR_CALLBACK,
  // 100,000 chars) in tasks/surge_audit.py. This is the belt-and-suspenders
  // check on the Client HQ side: if a callback somehow arrives here with
  // too little raw content — agent regression, an old build still running
  // somewhere, or a manual reprocess against a stale/truncated
  // surge_raw_data row — reject before Claude burns tokens extracting
  // structure from garbage.
  //
  // On rejection: flip the row to agent_error + retriable=true (matches
  // the agent's own _retriable_fail shape) so process-audit-queue Step 0.5
  // auto-requeues after the 5-min backoff, and fire a direct-to-chris@
  // alert so manual review is immediate rather than hidden in the regular
  // team notifications inbox.
  //
  // MIN kept in sync with agent-side MIN_RAW_CHARS_FOR_CALLBACK; adjust
  // both together if thresholds ever change.
  var MIN_RAW_CHARS_SERVER = 100000;
  if (surgeData.length < MIN_RAW_CHARS_SERVER) {
    var rejectReason = 'truncated_extraction_rejected_server';
    var rejectDetail = (
      'Reciprocal truncation guard rejected callback: surge_data length ' +
      surgeData.length + ' chars (required >=' + MIN_RAW_CHARS_SERVER + '). ' +
      'Row flipped to agent_error+retriable; process-audit-queue Step 0.5 ' +
      'will requeue after the 5-min backoff.'
    );

    try {
      await sb.mutate('entity_audits?id=eq.' + auditId, 'PATCH', {
        status: 'agent_error',
        agent_error_retriable: true,
        last_agent_error_code: rejectReason,
        last_agent_error: rejectDetail,
        last_agent_error_at: new Date().toISOString(),
        agent_task_id: null
      }, 'return=minimal');
    } catch (patchErr) {
      monitor.logError('process-entity-audit', patchErr, {
        detail: {
          stage: 'truncation_guard_patch',
          audit_id: auditId,
          raw_len: surgeData.length
        }
      });
    }

    try {
      var resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        var shortId = (auditId || '').slice(0, 8);
        var notifyHtml = (
          '<p style="font-family:Inter,sans-serif;font-size:15px;color:#333F70;line-height:1.7;margin:0 0 16px;">' +
          'Client HQ rejected a Surge audit callback because the payload was too short to trust.' +
          '</p>' +
          '<table style="font-family:Inter,sans-serif;font-size:14px;color:#333F70;border-collapse:collapse;margin:16px 0;">' +
            '<tr><td style="padding:4px 12px 4px 0;color:#6B7599;">Audit ID</td>' +
              '<td style="padding:4px 0;font-family:ui-monospace,Menlo,monospace;">' +
              sanitizer.sanitizeText(auditId || '', 64) + '</td></tr>' +
            '<tr><td style="padding:4px 12px 4px 0;color:#6B7599;">Raw length</td>' +
              '<td style="padding:4px 0;font-family:ui-monospace,Menlo,monospace;">' +
              surgeData.length + ' chars (required >=' + MIN_RAW_CHARS_SERVER + ')</td></tr>' +
            '<tr><td style="padding:4px 12px 4px 0;color:#6B7599;">Row status</td>' +
              '<td style="padding:4px 0;">agent_error, retriable=true. Will auto-requeue in ~5 min.</td></tr>' +
          '</table>' +
          '<p style="font-family:Inter,sans-serif;font-size:13px;color:#6B7599;line-height:1.5;margin:0;">' +
          'If this fires repeatedly for the same audit, the Phase 2 settle gate ' +
          'is being bypassed or the target site is producing genuinely short ' +
          'Surge output. Review in the admin UI.' +
          '</p>'
        );
        await fetchT('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Moonraker Alerts <notifications@clients.moonraker.ai>',
            to: 'chris@moonraker.ai',
            subject: 'Surge audit rejected: truncated callback (audit ' + shortId + ')',
            html: notifyHtml
          })
        }, 10000);
      }
    } catch (notifyErr) {
      monitor.logError('process-entity-audit', notifyErr, {
        detail: {
          stage: 'truncation_guard_notify',
          audit_id: auditId
        }
      });
    }

    return res.status(400).json({
      error: rejectReason,
      message: rejectDetail,
      raw_length: surgeData.length,
      min_required: MIN_RAW_CHARS_SERVER
    });
  }

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


  try {
    // ============================================================
    // STEP 1: Look up audit + contact
    // ============================================================
    send({ step: 'lookup', message: 'Looking up audit record...' });

    var audit = await sb.one('entity_audits?id=eq.' + auditId + '&select=*');
    if (!audit) {
      send({ step: 'error', message: 'Audit not found' });
      return res.end();
    }

    var contact = await sb.one('contacts?id=eq.' + audit.contact_id + '&select=*');
    if (!contact) {
      send({ step: 'error', message: 'Contact not found' });
      return res.end();
    }

    var practiceName = contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim();
    var slug = contact.slug;
    var isActiveCampaign = (contact.status === 'active' || contact.status === 'onboarding') && !contact.lost;

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
      // 4-min ceiling: Claude Opus on a 150KB Surge payload routinely takes
      // 2-3 minutes. Old 60s value was a silent killer -- the handler aborted
      // the Anthropic fetch at T+60s, the row stayed pending, and the agent
      // had already been told 200-OK by the time this fired (observed in
      // audit 6268e8ee-7e1e-4b75-a66e-80641cc481b6, Anna Sky demo). 240s
      // leaves 60s headroom under the 300s Vercel maxDuration so we can
      // still flush the NDJSON `error` event on timeout.
      claudeResp = await fetchT('https://api.anthropic.com/v1/messages', {
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
      }, 240000);
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

    // Parse JSON from Claude's response using the M25/L11 bracket-tracking
    // parser, which respects JSON string delimiters + backslash escapes so
    // content inside strings (including stray backticks, braces, or brackets)
    // is never confused for fence or structural markers.
    var parsed;
    try {
      parsed = jsonParser.parseFenced(rawText);
    } catch (parseErr) {
      send({ step: 'error', message: 'Failed to parse Claude response as JSON', raw: rawText.substring(0, 500) });
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

    // Compute variance from previous audit (for quarterly comparisons)
    var varianceFromPrevious = null;
    if (audit.audit_period !== 'initial') {
      try {
        var prevAudits = await sb.query('entity_audits?contact_id=eq.' + audit.contact_id +
          '&id=neq.' + auditId +
          '&status=in.(complete,delivered)' +
          '&select=cres_score,score_credibility,score_optimization,score_reputation,score_engagement,audit_period,audit_date' +
          '&order=audit_date.desc&limit=1');
        if (prevAudits && prevAudits.length > 0) {
          var prev = prevAudits[0];
          varianceFromPrevious = {
            compared_to: prev.audit_period,
            compared_date: prev.audit_date,
            cres: { previous: prev.cres_score, current: cresScore, delta: cresScore - (prev.cres_score || 0) },
            credibility: { previous: prev.score_credibility, current: scores.credibility, delta: (scores.credibility || 0) - (prev.score_credibility || 0) },
            optimization: { previous: prev.score_optimization, current: scores.optimization, delta: (scores.optimization || 0) - (prev.score_optimization || 0) },
            reputation: { previous: prev.score_reputation, current: scores.reputation, delta: (scores.reputation || 0) - (prev.score_reputation || 0) },
            engagement: { previous: prev.score_engagement, current: scores.engagement, delta: (scores.engagement || 0) - (prev.score_engagement || 0) }
          };
          send({ step: 'variance', message: 'Compared to ' + prev.audit_period + ': CRES ' + (prev.cres_score || 0) + ' -> ' + cresScore + ' (' + (varianceFromPrevious.cres.delta >= 0 ? '+' : '') + varianceFromPrevious.cres.delta + ')' });
        }
      } catch (varErr) {
        send({ step: 'variance_warning', message: 'Could not compute variance: ' + varErr.message });
      }
    }

    var updateBody = {
      // JSONB columns (scores + metadata for templates)
      scores: scores,
      tasks: tasks,
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
      status: 'complete',
      variance_from_previous: varianceFromPrevious,
      // Retention (security audit H3): once the surge payload has been parsed
      // into scores + tasks + citations above, the raw HTML is no longer
      // needed. Nulling it here reclaims ~80KB/row (TOAST) and prevents the
      // entity_audits footprint from growing linearly with audit volume. The
      // recovery path in this same handler (~line 56) only reads surge_raw_data
      // pre-processing, so clearing it at the complete-transition never
      // interferes with retry logic.
      surge_raw_data: null
    };

    try {
      await sb.mutate('entity_audits?id=eq.' + auditId, 'PATCH', updateBody, 'return=minimal');
    } catch (e) {
      send({ step: 'error', message: 'Supabase update failed: ' + (e.message || '').substring(0, 200) });
      return res.end();
    }

    send({ step: 'supabase_done', message: 'Entity audit scores saved.' });

    // ============================================================
    // STEP 4: Write checklist_items (structured, trackable tasks)
    // Only for active/onboarding clients. Leads get scores but not
    // the action item checklist (that's our campaign deliverable).
    // Checklist items are created retroactively if a lead converts
    // via setup-audit-schedule.js.
    // ============================================================
    var checklistRows = [];
    if (isActiveCampaign) {
    send({ step: 'checklist', message: 'Creating ' + allTasks.length + ' structured task records...' });

    // Delete any existing checklist_items for this audit (re-processing support)
    try {
      await sb.mutate('checklist_items?audit_id=eq.' + auditId, 'DELETE', null, 'return=minimal');
    } catch (_e) { /* non-fatal; best-effort cleanup */ }

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
        id: auditId + '-' + String(idx + 1).padStart(3, '0'),
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
      try {
        await sb.mutate('checklist_items', 'POST', checklistRows, 'return=minimal');
        send({ step: 'checklist_done', message: checklistRows.length + ' tasks created in checklist_items.' });
      } catch (e) {
        send({ step: 'checklist_warning', message: 'Checklist insert issue: ' + (e.message || '').substring(0, 200) });
        // Continue, non-fatal
      }
    }
    } else {
      send({ step: 'checklist_skipped', message: 'Checklist items skipped (lead audit). Will be created if client signs up.' });
    }

    // ============================================================
    // STEP 5: Deploy scorecard page from template to GitHub
    // ============================================================
    send({ step: 'deploy', message: 'Deploying scorecard page...' });

    var githubDeployed = false;
    var checkoutDeployed = false;
    var suiteDeployed = false;
    var scorecardReady = false; // template read succeeded (cascades to checkout + suite)

    // Scorecard page
    try {
      var scorecardHtml = prepTemplate(await gh.readTemplate('entity-audit.html'));
      scorecardReady = true;
      await gh.pushFile(slug + '/entity-audit/index.html', scorecardHtml, 'Deploy entity audit scorecard for ' + slug);
      githubDeployed = true;
    } catch (ghErr) {
      if (!scorecardReady) {
        send({ step: 'deploy_warning', message: 'Template not found, skipping GitHub deploy.' });
      }
      monitor.logError('process-entity-audit', ghErr, {
        client_slug: slug,
        detail: { stage: 'deploy_scorecard' }
      });
    }

    if (scorecardReady) {
      // Checkout page
      send({ step: 'deploy_checkout', message: 'Deploying checkout page...' });
      try {
        var checkoutHtml = prepTemplate(await gh.readTemplate('entity-audit-checkout.html'));
        await gh.pushFile(slug + '/entity-audit-checkout/index.html', checkoutHtml, 'Deploy entity audit checkout for ' + slug);
        checkoutDeployed = true;
      } catch (ghErr) {
        monitor.logError('process-entity-audit', ghErr, {
          client_slug: slug,
          detail: { stage: 'deploy_checkout' }
        });
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

        // Sign a scope='progress' page token bound to this contact.
        // progress.html bakes it as window.__PAGE_TOKEN__ and sends it on
        // every call to /api/progress-update. Security audit H4.
        var signedProgressToken = '';
        try {
          signedProgressToken = pageToken.sign({ scope: 'progress', contact_id: contact.id });
        } catch (e) {
          monitor.logError('process-entity-audit', e, {
            client_slug: slug,
            detail: { stage: 'sign_progress_token' }
          });
        }

        var suiteResults = [];
        for (var i = 0; i < suiteTemplates.length; i++) {
          var st = suiteTemplates[i];
          // Small delay between GitHub pushes (secondary-rate-limit mitigation)
          if (i > 0) await new Promise(function(r) { setTimeout(r, 600); });

          try {
            var stReplacements = null;
            if (st.template === 'progress.html') {
              stReplacements = { '{{PAGE_TOKEN}}': signedProgressToken };
            }
            var stHtml = prepTemplate(await gh.readTemplate(st.template), stReplacements);
            await gh.pushFile(st.dest, stHtml, 'Deploy audit ' + st.template.replace('.html', '') + ' for ' + slug);
            suiteResults.push({ template: st.template, deployed: true });
          } catch (ghErr) {
            suiteResults.push({ template: st.template, deployed: false });
            monitor.logError('process-entity-audit', ghErr, {
              client_slug: slug,
              detail: { stage: 'deploy_suite', template: st.template }
            });
          }
        }

        suiteDeployed = suiteResults.every(function(r) { return r.deployed; });
        send({ step: 'deploy_suite_done', message: 'Audit suite: ' + suiteResults.filter(function(r) { return r.deployed; }).length + '/3 pages deployed.' });
      }
    }

    // ============================================================
    // STEP 7: Finalize + auto-delivery for lead audits
    // ============================================================
    send({ step: 'finalize', message: 'Finalizing...' });

    // Auto-deliver for lead entity audits
    if (contact.status === 'lead' && !contact.lost && audit.audit_tier === 'free') {
      send({ step: 'auto_send', message: 'Sending scorecard email automatically (free lead audit)...' });
      try {
        // process-entity-audit is invoked via the agent callback path;
        // AGENT_API_KEY is the deliberate identity for the downstream
        // send-audit-email call. Hard-require it; the previous
        // CRON_SECRET || AGENT_API_KEY || '' fallback sent
        // "Authorization: Bearer " with empty credentials if both
        // env vars were missing, which fails closed at send-audit-email
        // but pollutes error paths with a misleading auth-failure
        // signature. Fail loud at the source instead.
        var agentKey = process.env.AGENT_API_KEY;
        if (!agentKey) {
          throw new Error('AGENT_API_KEY not configured -- cannot call send-audit-email');
        }
        var sendResp = await fetchT('https://clients.moonraker.ai/api/send-audit-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + agentKey },
          body: JSON.stringify({ audit_id: auditId })
        }, 30000);
        if (sendResp.ok) {
          send({ step: 'auto_send_done', message: 'Scorecard email sent to ' + (contact.email || 'client') });

          // ── M19 race-case detection ──
          // Record auto_sent_at so stripe-webhook can detect the race
          // when a premium-upgrade payment lands AFTER this email went
          // out. Then re-read the audit row; if audit_tier has flipped
          // to 'premium' between our initial load (L501) and now, the
          // webhook's upgrade landed DURING our processing, the customer
          // paid for premium but already got free delivery, so fire a
          // Loom team notification. Idempotent via race_loom_notified_at
          // (conditional PATCH WHERE race_loom_notified_at IS NULL);
          // stripe-webhook's own entity_audit branch may also attempt
          // this claim from the other side of the race. Whichever writer
          // flips the column from NULL first wins and sends the email.
          try {
            await sb.mutate('entity_audits?id=eq.' + auditId, 'PATCH', {
              auto_sent_at: new Date().toISOString()
            });
            var rechecked = await sb.one('entity_audits?id=eq.' + auditId + '&select=audit_tier&limit=1');
            if (rechecked && rechecked.audit_tier === 'premium') {
              var loomClaim = await sb.mutate(
                'entity_audits?id=eq.' + auditId + '&race_loom_notified_at=is.null',
                'PATCH',
                { race_loom_notified_at: new Date().toISOString() }
              );
              if (loomClaim && loomClaim.length > 0) {
                send({ step: 'race_loom_notify', message: 'Upgrade landed during processing -- notifying team for premium Loom delivery' });
                var loomResendKey = process.env.RESEND_API_KEY;
                if (loomResendKey) {
                  await fetchT('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + loomResendKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
                      to: ['notifications@clients.moonraker.ai'],
                      subject: 'Premium Audit Paid After Free Delivery -- Loom Required for ' + sanitizer.sanitizeText(practiceName, 200),
                      html: '<p><strong>Race-case premium audit detected.</strong> The customer paid for a premium entity audit during audit processing. The free scorecard was auto-sent moments ago; the team now needs to record a Loom walkthrough to complete the premium delivery.</p>' +
                        '<p><strong>Client:</strong> ' + sanitizer.sanitizeText(contact.first_name, 100) + ' ' + sanitizer.sanitizeText(contact.last_name, 100) + '</p>' +
                        '<p><strong>Practice:</strong> ' + sanitizer.sanitizeText(practiceName, 200) + '</p>' +
                        '<p><strong>Audit ID:</strong> ' + sanitizer.sanitizeText(String(auditId), 64) + '</p>' +
                        '<p style="margin-top:16px;"><strong>Next steps:</strong></p>' +
                        '<ol><li>Record a personalized Loom walkthrough covering the same audit data</li><li>Add the Loom URL to the audit in admin</li><li>Send the premium delivery email from admin</li></ol>' +
                        '<p><a href="https://clients.moonraker.ai/admin/clients">Open in Admin</a></p>'
                    })
                  }, 15000);
                  send({ step: 'race_loom_notify_done', message: 'Team notified about race-case premium upgrade.' });
                }
              }
            }
          } catch (raceEx) {
            // Race-detection is best-effort. stripe-webhook's own branch
            // will catch the same race from the other direction (its PATCH
            // return shows auto_sent_at set). Log but don't fail the handler.
            send({ step: 'race_loom_warning', message: 'Race-check error: ' + raceEx.message });
          }
        } else {
          var sendErr = '';
          try { sendErr = (await sendResp.json()).error || ''; } catch(e) {}
          send({ step: 'auto_send_warning', message: 'Auto-send failed (' + sendResp.status + '): ' + sendErr + '. Team can send manually.' });
        }
      } catch (sendEx) {
        send({ step: 'auto_send_warning', message: 'Auto-send error: ' + sendEx.message + '. Team can send manually.' });
      }
    } else if (contact.status === 'lead' && !contact.lost && audit.audit_tier === 'premium') {
      // Premium lead audit: notify team to add Loom and review
      send({ step: 'notify_team', message: 'Notifying team to review premium audit...' });
      try {
        var resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          await fetchT('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
              to: ['notifications@clients.moonraker.ai'],
              subject: 'Premium Entity Audit Ready for Review - ' + sanitizer.sanitizeText(practiceName, 200),
              html: '<p>A premium entity audit has been processed and is ready for your review.</p>' +
                '<p><strong>Client:</strong> ' + sanitizer.sanitizeText(contact.first_name, 100) + ' ' + sanitizer.sanitizeText(contact.last_name, 100) + '</p>' +
                '<p><strong>Practice:</strong> ' + sanitizer.sanitizeText(practiceName, 200) + '</p>' +
                '<p><strong>CRES Score:</strong> ' + sanitizer.sanitizeText(String(cresScore || 'N/A'), 20) + '</p>' +
                '<p style="margin-top:16px;"><strong>Next steps:</strong></p>' +
                '<ol><li>Record a personalized Loom walkthrough</li><li>Add the Loom URL to the audit in admin</li><li>Send the delivery email from admin</li></ol>' +
                '<p><a href="https://clients.moonraker.ai/admin/clients">Open in Admin</a></p>'
            })
          }, 15000);
          send({ step: 'notify_team_done', message: 'Team notified. Premium audit awaiting Loom review.' });
        }
      } catch (notifyEx) {
        send({ step: 'notify_team_warning', message: 'Team notification failed: ' + notifyEx.message });
      }
    } else if (contact.status === 'active' && !contact.lost && audit.audit_period !== 'initial' && audit.audit_period !== 'baseline') {
      // Quarterly active client audit: notify team with variance summary
      send({ step: 'notify_team', message: 'Sending quarterly audit notification to team...' });
      try {
        var resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
          var varianceHtml = '';
          if (varianceFromPrevious) {
            var d = varianceFromPrevious;
            var fmtDelta = function(val) {
              if (!val) return '<span style="color:#6B7599;">-</span>';
              var color = val > 0 ? '#00D47E' : val < 0 ? '#EF4444' : '#6B7599';
              return '<span style="color:' + color + ';">' + (val > 0 ? '+' : '') + val + '</span>';
            };
            varianceHtml =
              '<table cellpadding="0" cellspacing="0" border="0" style="font-size:14px;margin:12px 0;">' +
              '<tr><td style="padding:4px 16px 4px 0;font-weight:600;">CRES</td><td>' + (d.cres.previous || 0) + ' &rarr; ' + d.cres.current + ' ' + fmtDelta(d.cres.delta) + '</td></tr>' +
              '<tr><td style="padding:4px 16px 4px 0;">Credibility</td><td>' + (d.credibility.previous || 0) + ' &rarr; ' + d.credibility.current + ' ' + fmtDelta(d.credibility.delta) + '</td></tr>' +
              '<tr><td style="padding:4px 16px 4px 0;">Optimization</td><td>' + (d.optimization.previous || 0) + ' &rarr; ' + d.optimization.current + ' ' + fmtDelta(d.optimization.delta) + '</td></tr>' +
              '<tr><td style="padding:4px 16px 4px 0;">Reputation</td><td>' + (d.reputation.previous || 0) + ' &rarr; ' + d.reputation.current + ' ' + fmtDelta(d.reputation.delta) + '</td></tr>' +
              '<tr><td style="padding:4px 16px 4px 0;">Engagement</td><td>' + (d.engagement.previous || 0) + ' &rarr; ' + d.engagement.current + ' ' + fmtDelta(d.engagement.delta) + '</td></tr>' +
              '</table>';
          }
          await fetchT('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
              to: ['notifications@clients.moonraker.ai'],
              subject: 'Quarterly Audit Complete - ' + sanitizer.sanitizeText(practiceName, 200) + ' (' + sanitizer.sanitizeText(audit.audit_period, 50) + ')',
              html: '<div style="font-family:Inter,sans-serif;">' +
                '<p>A quarterly entity audit has been completed for <strong>' + sanitizer.sanitizeText(practiceName, 200) + '</strong> (' + sanitizer.sanitizeText(audit.audit_period, 50) + ').</p>' +
                '<p><strong>CRES Score:</strong> ' + sanitizer.sanitizeText(String(cresScore), 20) + '/40</p>' +
                varianceHtml +
                '<p>This audit is for internal reference ahead of the client check-in call. It will not be sent to the client automatically.</p>' +
                '<p><a href="https://clients.moonraker.ai/admin/clients" style="color:#00D47E;">View in Admin</a></p>' +
                '</div>'
            })
          }, 15000);
          send({ step: 'notify_team_done', message: 'Team notified about quarterly audit completion.' });
        }
      } catch (qNotifyEx) {
        send({ step: 'notify_team_warning', message: 'Quarterly notification failed: ' + qNotifyEx.message });
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





