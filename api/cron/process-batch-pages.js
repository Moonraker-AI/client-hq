/**
 * /api/cron/process-batch-pages.js
 *
 * Cron: runs every 5 minutes.
 * Picks up content_audit_batches in 'processing' status and processes
 * the next unprocessed page in each batch.
 *
 * One page per batch per cron run to stay within serverless timeout.
 * Each page: parse raw Surge text -> extract RTPBA + schema -> update content_pages.
 *
 * When all pages in a batch are processed, marks batch as 'complete'.
 */

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');
var surgeParser = require('../_lib/surge-parser');

async function handler(req, res) {
  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  try {
    // CR-M3 (revised 2026-04-26): Queue snapshot runs in parallel with the
    // batch-claim work below. withTracking now awaits req._snapshotPromise
    // before flushing the response, so the snapshot can no longer die
    // mid-fetch when the lambda freezes. Snapshot still doesn't block claim
    // work (both promises proceed concurrently); only the response flush
    // waits for both to settle.
    if (req._cronRunId) {
      req._snapshotPromise = (async function snapshotAsync() {
        try {
          var qRows = await sb.query(
            'content_pages?surge_status=eq.raw_stored' +
            '&select=created_at&order=created_at.asc&limit=1000'
          );
          if (!Array.isArray(qRows)) return;
          var oldestAge = qRows.length > 0
            ? Math.max(0, Math.floor((Date.now() - new Date(qRows[0].created_at).getTime()) / 1000))
            : 0;
          await cronRuns.snapshot(req._cronRunId, {
            queue_depth: qRows.length,
            oldest_item_age_sec: oldestAge
          });
        } catch (snapErr) { /* telemetry failure never blocks the cron */ }
      })();
    }

    // Find batches in processing status
    var batches = await sb.query('content_audit_batches?status=eq.processing&order=created_at.asc&limit=5');

    if (!batches || batches.length === 0) {
      return res.status(200).json({ message: 'No batches to process', processed: 0 });
    }

    var results = [];

    for (var b = 0; b < batches.length; b++) {
      var batch = batches[b];
      var result = { batch_id: batch.id, client_slug: batch.client_slug };

      try {
        // Atomic page claim via RPC (see migrations/2026-04-19-queue-claim-rpcs.sql).
        // Returns 0 or 1 rows with surge_status already flipped to 'processing'.
        // SKIP LOCKED in the RPC prevents two concurrent cron invocations from
        // parsing the same page's surge_raw_data twice.
        var claimed = await sb.mutate(
          'rpc/claim_next_content_page',
          'POST',
          { p_batch_id: batch.id }
        );

        if (!claimed || !Array.isArray(claimed) || claimed.length === 0) {
          // All pages done (or all currently locked by another claim), check completion
          await checkBatchComplete(batch.id);
          result.action = 'checked_completion';
          results.push(result);
          continue;
        }

        var page = claimed[0];
        result.content_page_id = page.id;
        result.keyword = page.target_keyword || page.page_name;

        // Parse via canonical surge-parser (same parser ingest-surge-content
        // uses for single-page audits). Inline extractRtpba/Schema below are
        // legacy stubs kept only so older batches that never ran through this
        // path don't regress; new code paths must use surgeParser.parse().
        var raw = page.surge_raw_data || '';
        var parsed = surgeParser.parse(raw);

        // Update page with full canonical parse output. Storing the parsed
        // object on surge_data (jsonb) gives downstream consumers structured
        // access (variance_score, structured_scores, blueprint_phases, etc.)
        // without re-parsing the markdown each render.
        await sb.mutate('content_pages?id=eq.' + page.id, 'PATCH', {
          surge_data: parsed,
          rtpba: parsed.rtpba || null,
          schema_recommendations: parsed.schema_recommendations || null,
          variance_score: parsed.variance_score,
          variance_label: parsed.variance_label,
          surge_status: 'processed',
          status: 'audit_loaded',
          updated_at: new Date().toISOString()
        }, 'return=minimal');

        // Update batch progress
        await sb.mutate('content_audit_batches?id=eq.' + batch.id, 'PATCH', {
          pages_processed: (batch.pages_processed || 0) + 1,
          updated_at: new Date().toISOString()
        }, 'return=minimal');

        result.action = 'processed';
        result.has_rtpba = !!parsed.rtpba;
        result.rtpba_length = parsed.rtpba ? parsed.rtpba.length : 0;
        result.schema_block_count = (parsed.schema_recommendations && parsed.schema_recommendations.blocks)
          ? parsed.schema_recommendations.blocks.length : 0;
        result.variance_score = parsed.variance_score;

      } catch(pageErr) {
        console.error('Batch page processing error:', pageErr.message);
        result.action = 'error';
        result.error = pageErr.message;

        // Mark page as error
        if (result.content_page_id) {
          try {
            await sb.mutate('content_pages?id=eq.' + result.content_page_id, 'PATCH', {
              surge_status: 'error',
              generation_notes: 'Cron processing error: ' + (pageErr.message || '').substring(0, 500),
              updated_at: new Date().toISOString()
            }, 'return=minimal');
          } catch(e) {}
        }
      }

      results.push(result);
    }

    return res.status(200).json({
      message: 'Processed ' + results.length + ' batch(es)',
      results: results
    });

  } catch (err) {
    console.error('process-batch-pages cron error:', err);
    monitor.logError('cron/process-batch-pages', err, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Batch pages processing failed' });
  }
}

module.exports = cronRuns.withTracking('process-batch-pages', handler);


async function checkBatchComplete(batchId) {
  var allPages = await sb.query('content_pages?batch_id=eq.' + batchId + '&select=surge_status');
  if (!allPages) return;

  var processed = allPages.filter(function(p) { return p.surge_status === 'processed'; }).length;
  var errors = allPages.filter(function(p) { return p.surge_status === 'error'; }).length;
  var remaining = allPages.filter(function(p) {
    return p.surge_status === 'raw_stored' || p.surge_status === 'processing';
  }).length;

  if (remaining === 0) {
    var finalStatus = errors > 0 && processed === 0 ? 'failed' : 'complete';
    await sb.mutate('content_audit_batches?id=eq.' + batchId, 'PATCH', {
      status: finalStatus,
      pages_processed: processed,
      updated_at: new Date().toISOString()
    }, 'return=minimal');

    // Auto-trigger synthesis processing if batch completed successfully and has synthesis
    if (finalStatus === 'complete') {
      var batchCheck = await sb.one('content_audit_batches?id=eq.' + batchId + '&limit=1');
      if (batchCheck && batchCheck.synthesis_raw && !batchCheck.synthesis_processed) {
        try {
          var synthResp = await fetch('https://clients.moonraker.ai/api/process-batch-synthesis', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + (process.env.CRON_SECRET || ''),
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ batch_id: batchId })
          });
          if (synthResp.ok) {
            var synthResult = await synthResp.json();
            console.log('Auto-processed synthesis:', synthResult);
          }
        } catch(synthErr) {
          console.error('Auto-synthesis processing failed (can retry manually):', synthErr.message);
        }
      }
    }
  }
}


function extractRtpba(raw) {
  if (!raw || typeof raw !== 'string') return null;

  var markers = [
    'Ready-to-Publish Best Answer',
    'Ready to Publish Best Answer',
    'READY-TO-PUBLISH',
    'Best Answer Content',
    'Recommended Page Content'
  ];

  for (var i = 0; i < markers.length; i++) {
    var idx = raw.indexOf(markers[i]);
    if (idx > -1) {
      var startIdx = raw.indexOf('\n', idx);
      if (startIdx === -1) startIdx = idx + markers[i].length;

      var endMarkers = [
        'Action Plan', 'Brand Beacon', 'Off-Page', 'Technical SEO',
        'Schema Recommendations', 'Schema Markup', 'Implementation',
        'Site structure', 'Journey coverage', 'Visibility & Coverage',
        '---', '==='
      ];

      var endIdx = raw.length;
      for (var j = 0; j < endMarkers.length; j++) {
        var eIdx = raw.indexOf(endMarkers[j], startIdx + 100);
        if (eIdx > -1 && eIdx < endIdx) endIdx = eIdx;
      }

      var content = raw.substring(startIdx, endIdx).trim();
      if (content.length > 100) return content;
    }
  }

  return null;
}


function extractSchemaRecommendations(raw) {
  if (!raw || typeof raw !== 'string') return null;

  var schemaIdx = raw.indexOf('Schema');
  if (schemaIdx === -1) schemaIdx = raw.indexOf('Structured Data');
  if (schemaIdx === -1) return null;

  var section = raw.substring(schemaIdx, schemaIdx + 3000);
  var types = [];
  var knownTypes = [
    'MedicalBusiness', 'MedicalWebPage', 'FAQPage', 'Person', 'Service',
    'BreadcrumbList', 'AggregateRating', 'VideoObject', 'Article',
    'LocalBusiness', 'HealthAndBeautyBusiness', 'ProfessionalService',
    'MedicalCondition', 'MedicalTherapy', 'Physician', 'ContactPoint',
    'Organization', 'WebPage', 'HowTo', 'ItemList'
  ];

  knownTypes.forEach(function(t) {
    if (section.indexOf(t) > -1) types.push(t);
  });

  if (types.length > 0) {
    return { recommended_types: types, raw_section: section.substring(0, 1000) };
  }
  return null;
}
