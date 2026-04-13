/**
 * /api/ingest-batch-audit.js
 *
 * Callback endpoint for the Moonraker Agent Service.
 * Receives all extracted Surge data from a batch audit run.
 *
 * POST body: {
 *   batch_id,
 *   pages: [{ content_page_id, surge_raw_data, variance_score, variance_label }],
 *   synthesis_raw: "..." (optional, if synthesis was generated),
 *   surge_batch_url: "..." (URL to the batch in Surge UI)
 * }
 *
 * Flow:
 * 1. Auth: Bearer token must match AGENT_API_KEY
 * 2. Store raw data on each content_pages row (safety net)
 * 3. Update batch record with synthesis + progress
 * 4. Kick off sequential processing of page 1
 * 5. Notify team
 *
 * Processing happens via process-batch-pages cron or inline here.
 */

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: agent must provide the shared key
  var AGENT_KEY = process.env.AGENT_API_KEY;
  var authHeader = req.headers.authorization || '';
  if (!AGENT_KEY || authHeader !== 'Bearer ' + AGENT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var RESEND_KEY = process.env.RESEND_API_KEY;
  var body = req.body;

  if (!body || !body.batch_id) {
    return res.status(400).json({ error: 'batch_id required' });
  }

  try {
    // 1. Fetch batch record
    var batch = await sb.one('content_audit_batches?id=eq.' + body.batch_id + '&limit=1');
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    // 2. Store raw data on each content page
    var pagesStored = 0;
    var pagesData = body.pages || [];

    for (var i = 0; i < pagesData.length; i++) {
      var page = pagesData[i];
      if (!page.content_page_id || !page.surge_raw_data) {
        console.error('Skipping page missing content_page_id or surge_raw_data');
        continue;
      }

      var pageUpdate = {
        surge_raw_data: page.surge_raw_data,
        surge_status: 'raw_stored',
        updated_at: new Date().toISOString()
      };

      // Store variance scores if provided
      if (page.variance_score !== undefined) pageUpdate.variance_score = page.variance_score;
      if (page.variance_label) pageUpdate.variance_label = page.variance_label;

      var updateResp = await fetch(
        sb.url() + '/rest/v1/content_pages?id=eq.' + page.content_page_id,
        {
          method: 'PATCH',
          headers: Object.assign({}, sb.headers(), { 'Prefer': 'return=minimal' }),
          body: JSON.stringify(pageUpdate)
        }
      );

      if (updateResp.ok) {
        pagesStored++;
      } else {
        var err = await updateResp.text();
        console.error('Failed to store page', page.content_page_id, ':', updateResp.status, err);
      }
    }

    // 3. Update batch record
    var batchUpdate = {
      status: pagesStored > 0 ? 'processing' : 'failed',
      pages_extracted: pagesStored,
      updated_at: new Date().toISOString()
    };

    if (body.synthesis_raw) {
      batchUpdate.synthesis_raw = body.synthesis_raw;
    }
    if (body.surge_batch_url) {
      batchUpdate.surge_batch_url = body.surge_batch_url;
    }
    if (pagesStored === 0) {
      batchUpdate.error_message = 'No pages could be stored from agent callback';
    }

    await sb.mutate('content_audit_batches?id=eq.' + body.batch_id, 'PATCH',
      batchUpdate, 'return=minimal');

    // 4. Trigger processing of first page (if any stored)
    // Processing runs inline for the first page, then the cron picks up the rest.
    // This avoids the 120s timeout issue since each page processes separately.
    if (pagesStored > 0) {
      try {
        await processNextPage(body.batch_id);
      } catch(procErr) {
        console.error('Initial page processing failed (cron will retry):', procErr.message);
      }
    }

    // 5. Notify team
    if (RESEND_KEY) {
      try {
        var contact = await sb.one('contacts?slug=eq.' + batch.client_slug + '&limit=1');
        var practiceName = contact ? (contact.practice_name || contact.first_name + ' ' + contact.last_name) : batch.client_slug;

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: email.FROM.notifications,
            to: ['support@moonraker.ai'],
            subject: 'Batch Audit Data Received: ' + practiceName + ' (' + pagesStored + '/' + batch.pages_total + ' pages)',
            html: buildNotificationHtml(batch, pagesStored, body.synthesis_raw)
          })
        });
      } catch(e) {
        console.error('Notification email failed:', e.message);
      }
    }

    return res.status(200).json({
      success: true,
      batch_id: body.batch_id,
      pages_stored: pagesStored,
      pages_total: batch.pages_total,
      has_synthesis: !!body.synthesis_raw,
      status: pagesStored > 0 ? 'processing' : 'failed'
    });

  } catch (err) {
    console.error('ingest-batch-audit error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


/**
 * Process the next unprocessed page in a batch.
 * Extracts RTPBA + schema from raw Surge data using Claude.
 */
async function processNextPage(batchId) {
  // Find next page with raw_stored status
  var pageResp = await fetch(
    sb.url() + '/rest/v1/content_pages?batch_id=eq.' + batchId +
    '&surge_status=eq.raw_stored&order=created_at.asc&limit=1',
    { headers: sb.headers() }
  );
  var pages = await pageResp.json();
  if (!pages || pages.length === 0) {
    // No more pages to process. Check if batch is complete.
    await checkBatchComplete(batchId);
    return;
  }

  var page = pages[0];

  // Mark as processing
  await sb.mutate('content_pages?id=eq.' + page.id, 'PATCH', {
    surge_status: 'processing',
    updated_at: new Date().toISOString()
  }, 'return=minimal');

  try {
    // Use the existing extraction logic from ingest-surge-content
    var surgeData = page.surge_raw_data || '';
    var rtpba = extractRtpba(surgeData);
    var schemaRecs = extractSchemaRecommendations(surgeData);

    // Update the page with extracted data
    var updateData = {
      surge_data: typeof surgeData === 'string' ? { raw_text: surgeData } : surgeData,
      rtpba: rtpba || null,
      schema_recommendations: schemaRecs || null,
      surge_status: 'processed',
      status: 'audit_loaded',
      updated_at: new Date().toISOString()
    };

    await sb.mutate('content_pages?id=eq.' + page.id, 'PATCH', updateData, 'return=minimal');

    // Update batch progress
    var batch = await sb.one('content_audit_batches?id=eq.' + batchId + '&limit=1');
    if (batch) {
      await sb.mutate('content_audit_batches?id=eq.' + batchId, 'PATCH', {
        pages_processed: (batch.pages_processed || 0) + 1,
        updated_at: new Date().toISOString()
      }, 'return=minimal');
    }

  } catch(err) {
    console.error('Page processing error for', page.id, ':', err.message);
    await sb.mutate('content_pages?id=eq.' + page.id, 'PATCH', {
      surge_status: 'error',
      generation_notes: 'Processing error: ' + (err.message || '').substring(0, 500),
      updated_at: new Date().toISOString()
    }, 'return=minimal');
  }
}


/**
 * Check if all pages in a batch are processed. If so, mark batch complete.
 */
async function checkBatchComplete(batchId) {
  var batch = await sb.one('content_audit_batches?id=eq.' + batchId + '&limit=1');
  if (!batch) return;

  // Count pages by status
  var pagesResp = await fetch(
    sb.url() + '/rest/v1/content_pages?batch_id=eq.' + batchId + '&select=surge_status',
    { headers: sb.headers() }
  );
  var allPages = await pagesResp.json();
  if (!allPages) return;

  var processed = allPages.filter(function(p) { return p.surge_status === 'processed'; }).length;
  var errors = allPages.filter(function(p) { return p.surge_status === 'error'; }).length;
  var remaining = allPages.filter(function(p) {
    return p.surge_status === 'raw_stored' || p.surge_status === 'processing';
  }).length;

  if (remaining === 0) {
    await sb.mutate('content_audit_batches?id=eq.' + batchId, 'PATCH', {
      status: errors > 0 && processed === 0 ? 'failed' : 'complete',
      pages_processed: processed,
      updated_at: new Date().toISOString()
    }, 'return=minimal');
  }
}


/**
 * Extract the Ready-to-Publish Best Answer from raw Surge text.
 * Same logic as ingest-surge-content.js but operates on raw text string.
 */
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


/**
 * Extract schema recommendations from raw Surge text.
 */
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
    return {
      recommended_types: types,
      raw_section: section.substring(0, 1000)
    };
  }

  return null;
}


/**
 * Build notification email HTML
 */
function buildNotificationHtml(batch, pagesStored, hasSynthesis) {
  var clientUrl = 'https://clients.moonraker.ai/admin/clients?slug=' + (batch.client_slug || '') + '&tab=content';

  var details = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">';
  details += detailRow('Client', batch.client_slug || '');
  details += detailRow('Pages Extracted', pagesStored + ' / ' + batch.pages_total);
  details += detailRow('Synthesis', hasSynthesis ? 'Yes' : 'Not yet generated');
  details += detailRow('Status', 'Processing');
  details += '</table>';

  var content = email.sectionHeading('Batch Audit Data Received') +
    details +
    email.divider() +
    email.p('The batch audit data has been stored and processing has started. Each page will be processed sequentially to extract RTPBA content and schema recommendations.') +
    email.cta(clientUrl, 'View in Content Tab');

  return email.wrap({
    headerLabel: 'Team Notification',
    content: content,
    footerNote: 'This is an internal notification for the Moonraker team.',
    year: new Date().getFullYear()
  });
}

function detailRow(label, value) {
  return '<tr>' +
    '<td style="font-family:Inter,sans-serif;font-size:14px;color:#6B7599;padding:6px 0;width:140px;vertical-align:top;">' + email.esc(label) + '</td>' +
    '<td style="font-family:Inter,sans-serif;font-size:14px;font-weight:600;color:#1E2A5E;padding:6px 0;">' + email.esc(value) + '</td>' +
  '</tr>';
}
