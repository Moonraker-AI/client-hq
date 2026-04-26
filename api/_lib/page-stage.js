// api/_lib/page-stage.js
// Shared helper for the audit→critique→polish→harden→clarify chain.
//
// Each stage route in /api/page-stages/{stage}.js wraps runStage(), which:
//   1. Loads context for the stage (content_pages row, design_specs, contract).
//   2. Resolves html_before from the most recent accepted stage run, or from
//      content_pages.generated_html for the first stage in the chain.
//   3. Inserts a page_stage_runs row in 'running' state with started_at.
//   4. Builds the Claude prompt: SKILL.md + reference/<stage>.md + context.
//   5. Calls Claude with a hard timeout (default 50s; well under Vercel Pro's
//      60s function ceiling).
//   6. Parses the response (either structured findings JSON or rewritten HTML).
//   7. For 'audit' and 'verify' stages, additionally posts to /api/design-audit
//      to merge deterministic detector findings into the run.
//   8. Updates the row with html_after / findings / observability fields.
//   9. Returns the run record so the route can hand it back to the admin UI.
//
// Stage references are read from GitHub at runtime via the gh helper. This
// trades a ~200ms cold-start cost (one Contents API GET) for the ability to
// edit reference files and have changes take effect without a redeploy.
// Acceptable for admin-triggered routes; not used by client-facing paths.
//
// Acceptance is a separate concern: routes return the run record; admin UI
// later PATCHes accepted_at to advance content_pages.status. See the
// per-stage route files for the status transition map.

var sb       = require('./supabase');
var monitor  = require('./monitor');
var fetchT   = require('./fetch-with-timeout');
var fs       = require('fs');
var path     = require('path');

// Stage ordering for the homepage chain. Subsequent-page chain skips
// 'critique' (the design-judgment stage; locked once the contract exists).
var HOMEPAGE_CHAIN  = ['audit','critique','polish','harden','clarify'];
var SUBSEQUENT_CHAIN = ['audit','polish','harden','clarify'];

// Status that a content_pages row should be in BEFORE running each stage.
// Maps to the previous stage's accepted_at completion. 'audit' is the entry
// point and accepts any of the pre-chain statuses.
var PRE_STAGE_STATUS = {
  audit:    ['review','generating','audited'],         // entry: post-generation
  critique: ['audited','critiqued'],                    // homepage only
  polish:   ['audited','critiqued','polished'],         // critiqued for homepage; audited for subsequent
  harden:   ['polished','hardened'],
  clarify:  ['hardened','clarified'],
  verify:   ['clarified']                                // automated, post-clarify
};

// Status the row is moved to AFTER a stage run is accepted.
var POST_STAGE_STATUS = {
  audit:    'audited',
  critique: 'critiqued',
  polish:   'polished',
  harden:   'hardened',
  clarify:  'clarified',
  verify:   null  // verify gates ready_for_contract / ready_for_client; route handles transition
};

var STAGE_REFERENCE_FILE = {
  audit:    'audit.md',
  critique: 'critique.md',
  polish:   'polish.md',
  harden:   'harden.md',
  clarify:  'clarify.md',
  verify:   'audit.md'  // verify uses the audit reference
};

var SKILL_FILE = 'SKILL.md';
var REFERENCE_DIR = path.join(__dirname, 'page-stage-references');

// Defensive caps. Token-cost is not the constraint per Q1 discussion, but
// runaway prompts are. ~30K tokens of input ≈ 120KB of plain text; html_before
// at 15KB plus 8KB of context plus ~6KB of reference is well under the cap.
var MAX_INPUT_CHARS  = 120000;   // ~30K tokens
var MAX_OUTPUT_TOKENS = 6000;    // headroom for full HTML rewrite of homepage
var DEFAULT_CLAUDE_TIMEOUT_MS = 50000;
var CLAUDE_MODEL = 'claude-sonnet-4-6';

// Cache for reference markdown — loaded synchronously at module init.
// Vercel bundles files referenced via __dirname-relative reads.
var _referenceCache = {};

function loadReference(filename) {
  if (_referenceCache[filename]) return _referenceCache[filename];
  var fp = path.join(REFERENCE_DIR, filename);
  var content;
  try {
    content = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    throw new Error('Reference file not found: ' + filename + ' (' + e.message + ')');
  }
  _referenceCache[filename] = content;
  return content;
}

// Resolve html_before for a stage. The chain is sequential and accept-gated,
// so the html_before is always the html_after of the most recent ACCEPTED run
// in the chain. For 'audit' (first stage), fall back to content_pages.generated_html.
async function resolveHtmlBefore(contentPageId, stage) {
  // Find the most recent accepted run for any prior stage of this page.
  var runs = await sb.query(
    'page_stage_runs?content_page_id=eq.' + contentPageId +
    '&accepted_at=not.is.null&rejected_at=is.null' +
    '&order=accepted_at.desc&limit=1' +
    '&select=stage,html_after,accepted_at'
  );
  if (runs && runs.length > 0 && runs[0].html_after) {
    return runs[0].html_after;
  }
  // No accepted prior run: pull generated_html from content_pages.
  var page = await sb.one('content_pages?id=eq.' + contentPageId + '&select=generated_html&limit=1');
  return page && page.generated_html ? page.generated_html : null;
}

// Build the Claude prompt for a stage. System prompt is SKILL.md + the stage's
// reference markdown. User prompt contains the structured context and html_before.
function buildPrompt(opts) {
  var skill = loadReference(SKILL_FILE);
  var reference = loadReference(STAGE_REFERENCE_FILE[opts.stage]);

  var systemPrompt =
    'You are running the "' + opts.stage + '" stage of the Moonraker page production chain.\n\n' +
    '--- IMPECCABLE SKILL ---\n' + skill + '\n\n' +
    '--- STAGE REFERENCE: ' + opts.stage.toUpperCase() + ' ---\n' + reference + '\n\n' +
    '--- OUTPUT CONTRACT ---\n' +
    outputContract(opts.stage);

  // Build user message with context + html_before + operator notes.
  var userParts = [];

  userParts.push('## Page context\n');
  userParts.push('- Client: ' + (opts.clientSlug || 'unknown'));
  userParts.push('- Page type: ' + (opts.pageType || 'unknown'));
  userParts.push('- Page name: ' + (opts.pageName || 'unknown'));
  if (opts.targetKeyword) userParts.push('- Target keyword: ' + opts.targetKeyword);
  if (opts.isHomepage) userParts.push('- This is the HOMEPAGE — its output sets the design contract for all subsequent pages.');

  if (opts.designSpec) {
    userParts.push('\n## Design spec (captured from client source site)\n');
    userParts.push('```json\n' + JSON.stringify({
      typography: opts.designSpec.typography,
      color_palette: opts.designSpec.color_palette,
      voice_dna: opts.designSpec.voice_dna
    }, null, 2) + '\n```');
  }

  if (opts.contract) {
    userParts.push('\n## Active client design contract (from homepage)\n');
    userParts.push('All choices below are LOCKED for this client. Do not deviate from these tokens, voice patterns, or component shapes.');
    userParts.push('```json\n' + JSON.stringify({
      tokens: opts.contract.tokens,
      voice: opts.contract.voice,
      components: opts.contract.components,
      copy_conventions: opts.contract.copy_conventions
    }, null, 2) + '\n```');
  }

  if (opts.priorFindings && opts.priorFindings.length > 0) {
    userParts.push('\n## Prior findings to address\n');
    userParts.push('The previous stage flagged these. Resolve them in this pass:');
    userParts.push('```json\n' + JSON.stringify(opts.priorFindings.slice(0, 30), null, 2) + '\n```');
  }

  if (opts.operatorNotes) {
    userParts.push('\n## Operator instructions for this run\n');
    userParts.push(opts.operatorNotes);
  }

  userParts.push('\n## HTML to ' + (opts.stage === 'audit' || opts.stage === 'verify' ? 'audit' : 'process') + '\n');
  userParts.push('```html\n' + opts.htmlBefore + '\n```');

  return {
    system: systemPrompt,
    user: userParts.join('\n')
  };
}

// What each stage must return. Keeps parsing deterministic and lets us reject
// off-contract responses without burning a re-run.
function outputContract(stage) {
  if (stage === 'audit' || stage === 'verify') {
    return [
      'Return ONLY valid JSON, no markdown fences, matching this shape:',
      '{',
      '  "audit_score": { "accessibility": 0-4, "performance": 0-4, "theming": 0-4, "responsive": 0-4, "anti_patterns": 0-4, "total": 0-20 },',
      '  "anti_patterns_verdict": "string — does this look AI-generated, with specific tells",',
      '  "executive_summary": "string",',
      '  "findings": [ { "severity": "P0"|"P1"|"P2"|"P3", "category": "string", "location": "string", "impact": "string", "recommendation": "string", "suggested_command": "string" } ],',
      '  "patterns_systemic": [ "string" ],',
      '  "positive_findings": [ "string" ]',
      '}'
    ].join('\n');
  }
  // Rewriting stages return both the new HTML and a structured diff summary.
  return [
    'Return ONLY valid JSON, no markdown fences, matching this shape:',
    '{',
    '  "html_after": "the rewritten HTML, full document",',
    '  "diff_summary": "1-3 sentence plain-English summary of what changed and why",',
    '  "changes": [ { "section": "string", "before": "string (short snippet)", "after": "string (short snippet)", "reason": "string" } ],',
    '  "findings_resolved": [ "string — descriptions of prior findings this pass addressed" ],',
    '  "findings_new": [ { "severity": "P0"|"P1"|"P2"|"P3", "category": "string", "location": "string", "impact": "string", "recommendation": "string" } ]',
    '}'
  ].join('\n');
}

// Run the deterministic detector against a rendered URL. Used by audit/verify.
// Returns the agent's design-audit response or null on failure (logged).
async function runDetector(opts) {
  if (!opts.previewUrl) return null;
  try {
    var detectorResp = await fetchT(opts.baseUrl + '/api/design-audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + opts.cronSecret
      },
      body: JSON.stringify({
        url: opts.previewUrl,
        viewport_width: opts.viewportWidth || 1440,
        viewport_height: opts.viewportHeight || 900
      })
    }, 70000);
    if (!detectorResp.ok) {
      monitor.logError('page-stage:detector', new Error('detector ' + detectorResp.status), {
        detail: { url: opts.previewUrl, status: detectorResp.status }
      });
      return null;
    }
    return await detectorResp.json();
  } catch (e) {
    monitor.logError('page-stage:detector', e, { detail: { url: opts.previewUrl } });
    return null;
  }
}

// Call Claude with the constructed prompt. Returns parsed response or throws.
async function callClaude(opts) {
  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured');

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
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }]
    })
  }, opts.timeoutMs || DEFAULT_CLAUDE_TIMEOUT_MS);

  var durationMs = Date.now() - startedAt;
  var requestId = resp.headers && resp.headers.get ? resp.headers.get('request-id') : null;

  if (!resp.ok) {
    var errText = '';
    try { errText = await resp.text(); } catch (e) {}
    var err = new Error('Anthropic ' + resp.status);
    err.upstreamStatus = resp.status;
    err.upstreamBody = errText.slice(0, 500);
    err.durationMs = durationMs;
    err.requestId = requestId;
    throw err;
  }

  var data = await resp.json();
  var responseText = '';
  if (data.content && data.content.length > 0) {
    responseText = data.content[0].text || '';
  }

  // Strip optional code fences and parse.
  var clean = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  var parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    var perr = new Error('Claude response not valid JSON');
    perr.rawResponse = responseText.slice(0, 1000);
    perr.parseError = e.message;
    perr.durationMs = durationMs;
    perr.requestId = requestId;
    throw perr;
  }

  return {
    parsed: parsed,
    inputTokens: (data.usage && data.usage.input_tokens) || null,
    outputTokens: (data.usage && data.usage.output_tokens) || null,
    durationMs: durationMs,
    requestId: requestId,
    rawText: responseText
  };
}

// Main entry point. Routes call this with a stage name + content_page_id +
// optional operator inputs. Returns the run record ready for response.
async function runStage(stage, opts) {
  if (!STAGE_REFERENCE_FILE[stage]) {
    throw new Error('Unknown stage: ' + stage);
  }
  if (!opts.contentPageId) throw new Error('contentPageId required');

  // Load page + design spec + contract.
  var page = await sb.one(
    'content_pages?id=eq.' + opts.contentPageId +
    '&select=*&limit=1'
  );
  if (!page) throw new Error('content_page not found: ' + opts.contentPageId);

  // Pre-stage status check. 'verify' is the only one we let run from any
  // post-clarified state; everything else gates on the prior stage.
  var allowedStatuses = PRE_STAGE_STATUS[stage] || [];
  if (allowedStatuses.indexOf(page.status) === -1) {
    var statusErr = new Error(
      'Cannot run stage "' + stage + '" — page is in status "' + page.status +
      '". Expected one of: ' + allowedStatuses.join(', ')
    );
    statusErr.code = 'STATUS_MISMATCH';
    throw statusErr;
  }

  var designSpec = null;
  if (page.contact_id) {
    designSpec = await sb.one(
      'design_specs?contact_id=eq.' + page.contact_id +
      '&select=typography,color_palette,voice_dna&limit=1'
    );
  }

  var contract = null;
  var isHomepage = page.page_type === 'homepage';
  if (!isHomepage && page.contact_id) {
    contract = await sb.one(
      'client_design_contracts?contact_id=eq.' + page.contact_id +
      '&status=eq.active&select=*&limit=1'
    );
  }

  // Resolve html_before. Reject if there's nothing to operate on.
  var htmlBefore = await resolveHtmlBefore(opts.contentPageId, stage);
  if (!htmlBefore || htmlBefore.length < 200) {
    throw new Error('No HTML available for stage input — content_pages.generated_html is empty or too short');
  }
  if (htmlBefore.length > MAX_INPUT_CHARS) {
    throw new Error('html_before exceeds size cap (' + htmlBefore.length + ' > ' + MAX_INPUT_CHARS + ')');
  }

  // Pull prior findings to thread into the prompt (most recent accepted run).
  var priorFindings = null;
  var lastAccepted = await sb.one(
    'page_stage_runs?content_page_id=eq.' + opts.contentPageId +
    '&accepted_at=not.is.null&rejected_at=is.null' +
    '&order=accepted_at.desc&limit=1&select=findings'
  );
  if (lastAccepted && lastAccepted.findings && Array.isArray(lastAccepted.findings)) {
    priorFindings = lastAccepted.findings;
  }

  // Insert the run row in 'running' state. We commit this BEFORE the Claude
  // call so partial failures (timeout, parse error) leave a trace.
  var runInsert = await sb.mutate('page_stage_runs', 'POST', {
    content_page_id: opts.contentPageId,
    stage: stage,
    run_status: 'running',
    html_before: htmlBefore,
    operator_notes: opts.operatorNotes || null,
    operator_id: opts.operatorId || null,
    started_at: new Date().toISOString()
  }, 'return=representation');

  if (!runInsert || !runInsert[0] || !runInsert[0].id) {
    throw new Error('Failed to insert page_stage_run');
  }
  var runId = runInsert[0].id;

  // Build prompt and call Claude.
  var prompt;
  var claudeResult;
  try {
    prompt = buildPrompt({
      stage: stage,
      clientSlug: page.client_slug,
      pageType: page.page_type,
      pageName: page.page_name,
      targetKeyword: page.target_keyword,
      isHomepage: isHomepage,
      designSpec: designSpec,
      contract: contract,
      priorFindings: priorFindings,
      operatorNotes: opts.operatorNotes,
      htmlBefore: htmlBefore
    });
    claudeResult = await callClaude({
      system: prompt.system,
      user: prompt.user,
      timeoutMs: opts.timeoutMs
    });
  } catch (e) {
    // Mark the run as failed. Distinguish timeout from other failures.
    var runStatus = 'failed';
    if (e.name === 'AbortError' || /timeout/i.test(e.message || '')) {
      runStatus = 'timeout';
    }
    await sb.mutate('page_stage_runs?id=eq.' + runId, 'PATCH', {
      run_status: runStatus,
      error_message: e.message,
      error_detail: {
        upstream_status: e.upstreamStatus,
        upstream_body: e.upstreamBody,
        request_id: e.requestId,
        raw_response: e.rawResponse,
        parse_error: e.parseError
      },
      duration_ms: e.durationMs || null,
      claude_request_id: e.requestId || null,
      completed_at: new Date().toISOString()
    }, 'return=minimal').catch(function(){});
    monitor.logError('page-stage:' + stage, e, {
      content_page_id: opts.contentPageId,
      run_id: runId
    });
    throw e;
  }

  // Optionally run the deterministic detector for audit/verify stages.
  var detectorResult = null;
  if ((stage === 'audit' || stage === 'verify') && opts.previewUrl) {
    detectorResult = await runDetector({
      previewUrl: opts.previewUrl,
      baseUrl: opts.baseUrl,
      cronSecret: opts.cronSecret,
      viewportWidth: opts.viewportWidth,
      viewportHeight: opts.viewportHeight
    });
  }

  // Compose findings + html_after from Claude's structured output.
  var parsed = claudeResult.parsed;
  var htmlAfter = null;
  var diffSummary = null;
  var findings = [];
  var findingsSummary = null;

  if (stage === 'audit' || stage === 'verify') {
    // Audit/verify don't rewrite HTML. They produce findings + score.
    findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    if (detectorResult && Array.isArray(detectorResult.findings)) {
      // Merge detector findings into the same array, tagged with source.
      detectorResult.findings.forEach(function(f) {
        findings.push({
          severity: severityToP(f.severity),
          category: f.category || 'detector',
          location: f.selector || '',
          impact: f.detail || '',
          recommendation: '',
          suggested_command: 'polish',
          source: 'detector'
        });
      });
    }
    findingsSummary = {
      claude_score: parsed.audit_score || null,
      anti_patterns_verdict: parsed.anti_patterns_verdict || null,
      executive_summary: parsed.executive_summary || null,
      detector_summary: detectorResult ? detectorResult.summary : null,
      counts: countSeverities(findings)
    };
    diffSummary = parsed.executive_summary || null;
  } else {
    // Rewriting stages.
    htmlAfter = typeof parsed.html_after === 'string' ? parsed.html_after : null;
    diffSummary = parsed.diff_summary || null;
    findings = Array.isArray(parsed.findings_new) ? parsed.findings_new : [];
    findingsSummary = {
      changes: parsed.changes || [],
      findings_resolved: parsed.findings_resolved || [],
      counts: countSeverities(findings)
    };
    if (!htmlAfter || htmlAfter.length < 200) {
      // Reject the run as malformed; admin can rerun.
      await sb.mutate('page_stage_runs?id=eq.' + runId, 'PATCH', {
        run_status: 'failed',
        error_message: 'Stage returned no html_after or output too short',
        error_detail: { raw_response: claudeResult.rawText.slice(0, 1000) },
        input_tokens: claudeResult.inputTokens,
        output_tokens: claudeResult.outputTokens,
        duration_ms: claudeResult.durationMs,
        claude_request_id: claudeResult.requestId,
        model: CLAUDE_MODEL,
        completed_at: new Date().toISOString()
      }, 'return=minimal').catch(function(){});
      throw new Error('Stage "' + stage + '" produced no usable HTML output');
    }
  }

  // Persist the completed run.
  var updateBody = {
    run_status: 'complete',
    html_after: htmlAfter,
    diff_summary: diffSummary,
    findings: findings,
    findings_summary: findingsSummary,
    input_tokens: claudeResult.inputTokens,
    output_tokens: claudeResult.outputTokens,
    duration_ms: claudeResult.durationMs,
    claude_request_id: claudeResult.requestId,
    model: CLAUDE_MODEL,
    completed_at: new Date().toISOString()
  };
  var updated = await sb.mutate(
    'page_stage_runs?id=eq.' + runId,
    'PATCH',
    updateBody,
    'return=representation'
  );

  return updated && updated[0] ? updated[0] : Object.assign({ id: runId }, updateBody);
}

// Accept a stage run: marks it accepted, advances content_pages.status,
// and rejects any other unaccepted runs for the same (page, stage).
async function acceptRun(runId, opts) {
  var run = await sb.one('page_stage_runs?id=eq.' + runId + '&select=*&limit=1');
  if (!run) throw new Error('run not found');
  if (run.run_status !== 'complete') {
    throw new Error('Only complete runs can be accepted (got: ' + run.run_status + ')');
  }
  if (run.accepted_at) return run; // already accepted, idempotent

  var nowIso = new Date().toISOString();

  // Reject any other completed-but-unaccepted runs for this (page, stage).
  await sb.mutate(
    'page_stage_runs?content_page_id=eq.' + run.content_page_id +
    '&stage=eq.' + run.stage + '&id=neq.' + runId +
    '&accepted_at=is.null&rejected_at=is.null',
    'PATCH',
    { rejected_at: nowIso, run_status: 'rejected' },
    'return=minimal'
  ).catch(function(){});

  // Mark this run accepted.
  var accepted = await sb.mutate(
    'page_stage_runs?id=eq.' + runId,
    'PATCH',
    { accepted_at: nowIso },
    'return=representation'
  );

  // Advance content_pages.status if this stage has a post-stage transition.
  // 'verify' is special — its acceptance triggers ready_for_contract (homepage)
  // or ready_for_client (subsequent), handled by the route, not here.
  var nextStatus = POST_STAGE_STATUS[run.stage];
  if (nextStatus) {
    var pageUpdate = { status: nextStatus, updated_at: nowIso };
    // For rewriting stages, also update content_pages.generated_html so the
    // preview endpoint reflects the latest accepted state.
    if (run.html_after && run.stage !== 'audit' && run.stage !== 'verify') {
      pageUpdate.generated_html = run.html_after;
    }
    await sb.mutate(
      'content_pages?id=eq.' + run.content_page_id,
      'PATCH',
      pageUpdate,
      'return=minimal'
    );
  }

  return accepted && accepted[0] ? accepted[0] : run;
}

function severityToP(severity) {
  if (severity === 'absolute') return 'P1';
  if (severity === 'strong') return 'P2';
  if (severity === 'advisory') return 'P3';
  return 'P3';
}

function countSeverities(findings) {
  var counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  if (!Array.isArray(findings)) return counts;
  findings.forEach(function(f) {
    var s = f.severity || 'P3';
    if (counts[s] != null) counts[s]++;
  });
  return counts;
}

module.exports = {
  runStage: runStage,
  acceptRun: acceptRun,
  HOMEPAGE_CHAIN: HOMEPAGE_CHAIN,
  SUBSEQUENT_CHAIN: SUBSEQUENT_CHAIN,
  PRE_STAGE_STATUS: PRE_STAGE_STATUS,
  POST_STAGE_STATUS: POST_STAGE_STATUS,
  STAGE_REFERENCE_FILE: STAGE_REFERENCE_FILE,
  CLAUDE_MODEL: CLAUDE_MODEL
};
