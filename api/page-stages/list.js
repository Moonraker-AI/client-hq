// /api/page-stages/list.js
// Read endpoint backing the admin Pages chain UI.
// Returns all content_pages for a client, each with a compact summary of its
// chain state: current status, per-stage most-recent run, notification counts,
// and metadata (contract presence for homepage, last activity).
//
// One query per content_page kept off the request critical path: page rows
// load first; runs load in a single batched query; assemble client-side.
//
// GET /api/page-stages/list?slug=<client-slug>
//   → { pages: [ { ...content_page, stages: { audit: {...}, critique: {...}, ... }, notifications: {...} } ], contract: <row|null> }
//
// Auth: admin JWT or CRON_SECRET (parity with the rest of /api/page-stages/*).
//
// Optional ?include_html=1 to inline html_before/html_after on each stage's
// most recent accepted run. Default off (payload bloat). Card list doesn't
// need it; expanded panels fetch per-run via a future detail endpoint.

var auth = require('../_lib/auth');
var sb   = require('../_lib/supabase');

var STAGES = ['audit', 'critique', 'polish', 'harden', 'clarify', 'verify'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var slug = (req.query && req.query.slug) || '';
  if (!slug) return res.status(400).json({ error: 'slug required' });
  var includeHtml = (req.query && req.query.include_html === '1');

  try {
    // 1. All pages for this client.
    var pages = await sb.query(
      'content_pages?client_slug=eq.' + encodeURIComponent(slug) +
      '&order=created_at.asc' +
      '&select=id,contact_id,client_slug,page_type,page_name,page_slug,status,' +
              'tracked_keyword_id,target_keyword,template_version,nav_label,' +
              'created_at,updated_at,delivered_at,counts_against_budget'
    ) || [];

    if (pages.length === 0) {
      return res.status(200).json({ pages: [], contract: null });
    }

    var pageIds = pages.map(function(p) { return p.id; });

    // 2. Active design contract for this client (homepage-derived).
    var contactId = pages[0].contact_id;
    var contract = null;
    if (contactId) {
      contract = await sb.one(
        'client_design_contracts?contact_id=eq.' + contactId +
        '&status=eq.active&select=id,homepage_content_page_id,created_at,updated_at&limit=1'
      );
    }

    // 3. All page_stage_runs for these pages, newest first per (page,stage).
    //    PostgREST doesn't expose DISTINCT ON cleanly; fetch all relevant runs
    //    and bucket client-side. With 20-30 runs per page and ≤10 pages per
    //    client, this is small (~300 rows) and faster than N+1 queries.
    var idFilter = 'in.(' + pageIds.map(function(id) { return id; }).join(',') + ')';
    var runSelect = 'id,content_page_id,stage,run_status,duration_ms,' +
                    'input_tokens,output_tokens,findings_summary,' +
                    'operator_notes,operator_id,error_message,' +
                    'created_at,started_at,completed_at,accepted_at,rejected_at';
    if (includeHtml) runSelect += ',html_before,html_after,diff_summary,findings';

    var runs = await sb.query(
      'page_stage_runs?content_page_id=' + idFilter +
      '&order=created_at.desc' +
      '&select=' + encodeURIComponent(runSelect) +
      '&limit=2000'
    ) || [];

    // 4. Bucket runs by (page, stage) — keeping most recent active and most
    //    recent accepted for each.
    var runsByPage = {};
    pageIds.forEach(function(id) {
      runsByPage[id] = {};
      STAGES.forEach(function(s) { runsByPage[id][s] = { latest: null, accepted: null, history_count: 0 }; });
    });

    runs.forEach(function(r) {
      var bucket = runsByPage[r.content_page_id];
      if (!bucket) return;
      var stage = bucket[r.stage];
      if (!stage) return;
      stage.history_count++;
      if (!stage.latest) stage.latest = r;
      if (!stage.accepted && r.accepted_at && !r.rejected_at) stage.accepted = r;
    });

    // 5. Compose page envelopes.
    var enriched = pages.map(function(p) {
      var stages = {};
      var clarifyingTotal = 0;
      var pendingReviewTotal = 0;
      var verifyGateFailures = 0;

      STAGES.forEach(function(s) {
        var bucket = runsByPage[p.id][s];
        var latest = bucket.latest;
        var accepted = bucket.accepted;

        // Surface notification signals from the most recent ACCEPTED run.
        // If admin hasn't accepted yet, surface from the latest run regardless
        // (so notifications appear before accept too).
        var source = accepted || latest;
        var clarifyingQuestions = 0;
        var blocking = 0;
        if (source && source.findings_summary) {
          var fs = source.findings_summary;
          if (Array.isArray(fs.clarifying_questions)) {
            clarifyingQuestions = fs.clarifying_questions.length;
            clarifyingTotal += clarifyingQuestions;
          }
          if (s === 'verify' && fs.counts) {
            blocking = (fs.counts.P0 || 0) + (fs.counts.P1 || 0);
            if (blocking > 0 && (!source.accepted_at)) verifyGateFailures += 1;
          }
        }

        // A "pending review" stage is one with a complete-but-unaccepted run.
        if (latest && latest.run_status === 'complete' && !latest.accepted_at && !latest.rejected_at) {
          pendingReviewTotal += 1;
        }

        stages[s] = {
          latest: latest ? trimRun(latest) : null,
          accepted: accepted ? trimRun(accepted) : null,
          history_count: bucket.history_count,
          clarifying_questions: clarifyingQuestions,
          blocking_findings: blocking,
          ui_state: deriveUiState(p, s, latest, accepted)
        };
      });

      return Object.assign({}, p, {
        stages: stages,
        notifications: {
          clarifying_questions: clarifyingTotal,
          pending_review: pendingReviewTotal,
          verify_gate_failures: verifyGateFailures,
          total: clarifyingTotal + pendingReviewTotal + verifyGateFailures
        }
      });
    });

    return res.status(200).json({
      pages: enriched,
      contract: contract,
      counts: {
        total: enriched.length,
        in_chain: enriched.filter(function(p) { return inChainStatuses.indexOf(p.status) !== -1; }).length,
        ready_for_client: enriched.filter(function(p) { return p.status === 'ready_for_client'; }).length,
        delivered: enriched.filter(function(p) { return p.status === 'delivered'; }).length
      }
    });
  } catch (e) {
    console.error('[page-stages/list]', e.message);
    return res.status(500).json({ error: 'List failed', detail: e.message });
  }
};

// Strip noisy/heavy fields from run objects before returning, unless caller asked for them.
function trimRun(r) {
  return {
    id: r.id,
    stage: r.stage,
    run_status: r.run_status,
    duration_ms: r.duration_ms,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    findings_summary: r.findings_summary,
    operator_notes: r.operator_notes,
    operator_id: r.operator_id,
    error_message: r.error_message,
    created_at: r.created_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    accepted_at: r.accepted_at,
    rejected_at: r.rejected_at,
    // Optional, only when include_html=1:
    html_before: r.html_before,
    html_after: r.html_after,
    diff_summary: r.diff_summary,
    findings: r.findings
  };
}

// Per-stage UI state for the dot-track in the collapsed card.
// Returns one of: 'pending' | 'running' | 'review' | 'accepted' | 'failed' | 'questions'.
function deriveUiState(page, stage, latest, accepted) {
  if (!latest) return 'pending';
  if (latest.run_status === 'running') return 'running';
  if (latest.run_status === 'failed' || latest.run_status === 'timeout') return 'failed';
  if (latest.run_status === 'complete' && !latest.accepted_at && !latest.rejected_at) {
    // Distinguish "review" from "questions": questions take priority visually.
    var fs = latest.findings_summary || {};
    if (Array.isArray(fs.clarifying_questions) && fs.clarifying_questions.length > 0) {
      return 'questions';
    }
    return 'review';
  }
  if (accepted) {
    var fs2 = accepted.findings_summary || {};
    if (Array.isArray(fs2.clarifying_questions) && fs2.clarifying_questions.length > 0) {
      return 'questions';
    }
    return 'accepted';
  }
  return 'pending';
}

// Statuses that indicate the page is somewhere in the chain (not pre-chain or post-delivery).
var inChainStatuses = [
  'review', 'audited', 'critiqued', 'polished', 'hardened', 'clarified',
  'ready_for_contract', 'ready_for_client', 'client_review', 'client_revising'
];
