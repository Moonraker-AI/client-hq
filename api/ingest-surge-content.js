/**
 * /api/ingest-surge-content.js
 *
 * Callback endpoint for the Moonraker Agent Service.
 * Receives Surge audit results for a content page and processes them.
 *
 * POST body: { content_page_id, surge_data, agent_task_id }
 *
 * Flow:
 * 1. Validates auth (Bearer token must match AGENT_API_KEY)
 * 2. Parses surge_data to extract RTPBA and schema recommendations
 * 3. Updates content_pages with surge_data, rtpba, schema_recommendations, status -> audit_loaded
 * 4. Sends team notification via Resend
 */

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');
var sb = require('./_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: agent must provide the shared key
  var AGENT_KEY = process.env.AGENT_API_KEY;
  var authHeader = req.headers.authorization || '';
  if (!AGENT_KEY || authHeader !== 'Bearer ' + AGENT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var RESEND_KEY = process.env.RESEND_API_KEY;

  var body = req.body;
  if (!body || !body.content_page_id) {
    return res.status(400).json({ error: 'content_page_id required' });
  }
  if (!body.surge_data) {
    return res.status(400).json({ error: 'surge_data required' });
  }

  var sbHeaders = {
    'apikey': sb.key(),
    'Authorization': 'Bearer ' + sb.key(),
    'Content-Type': 'application/json'
  };

  try {
    // 1. Fetch current content page
    var cpResp = await fetch(
      sb.url() + '/rest/v1/content_pages?id=eq.' + body.content_page_id + '&limit=1',
      { headers: { 'apikey': sb.key(), 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    var pages = await cpResp.json();
    if (!pages || !pages[0]) {
      return res.status(404).json({ error: 'Content page not found' });
    }
    var cp = pages[0];

    // 2. Parse surge data
    var surgeData = body.surge_data;
    if (typeof surgeData === 'string') {
      try { surgeData = JSON.parse(surgeData); } catch(e) { surgeData = { raw_text: surgeData }; }
    }

    // 3. Extract RTPBA and schema from surge data
    var rtpba = extractRtpba(surgeData);
    var schemaRecs = extractSchemaRecommendations(surgeData);

    // 4. Update content_pages
    var updateData = {
      surge_data: surgeData,
      rtpba: rtpba || null,
      schema_recommendations: schemaRecs || null,
      status: 'audit_loaded',
      agent_task_id: body.agent_task_id || cp.agent_task_id,
      updated_at: new Date().toISOString()
    };

    var updateResp = await fetch(
      sb.url() + '/rest/v1/content_pages?id=eq.' + body.content_page_id,
      {
        method: 'PATCH',
        headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }),
        body: JSON.stringify(updateData)
      }
    );

    if (!updateResp.ok) {
      var updateErr = await updateResp.text();
      console.error('Supabase update error:', updateResp.status, updateErr);
      return res.status(500).json({ error: 'Failed to update content page', detail: updateErr.substring(0, 300) });
    }

    // 5. Notify team
    if (RESEND_KEY) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: email.FROM.notifications,
            to: ['support@moonraker.ai'],
            subject: 'Surge Content Audit Complete: ' + (cp.page_name || cp.target_keyword || 'Unknown') + ' (' + cp.client_slug + ')',
            html: buildNotificationHtml(cp, rtpba, body.agent_task_id)
          })
        });
      } catch(e) {
        console.error('Notification email failed:', e.message);
      }
    }

    return res.status(200).json({
      success: true,
      content_page_id: body.content_page_id,
      has_rtpba: !!rtpba,
      rtpba_length: rtpba ? rtpba.length : 0,
      has_schema: !!schemaRecs && Object.keys(schemaRecs).length > 0,
      status: 'audit_loaded'
    });

  } catch (err) {
    console.error('ingest-surge-content error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


/**
 * Extract the Ready-to-Publish Best Answer from Surge data.
 * Surge outputs vary in structure, so we try multiple paths.
 */
function extractRtpba(surgeData) {
  if (!surgeData) return null;

  // Structured JSON paths (from agent extraction)
  if (surgeData.opportunities) {
    var opps = surgeData.opportunities;
    if (typeof opps === 'object') {
      if (opps.ready_to_publish) return opps.ready_to_publish;
      if (opps.ready_to_publish_best_answer) return opps.ready_to_publish_best_answer;
      if (opps.rtpba) return opps.rtpba;
      if (opps.best_answer) return opps.best_answer;
    }
  }

  // Raw text extraction
  var raw = surgeData.raw_text || '';
  if (typeof surgeData === 'string') raw = surgeData;

  if (!raw) return null;

  // Look for RTPBA section markers
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
      // Extract from after the marker to the next major section
      var startIdx = raw.indexOf('\n', idx);
      if (startIdx === -1) startIdx = idx + markers[i].length;

      // Find the end: next major section header or end of text
      var endMarkers = [
        'Action Plan', 'Brand Beacon', 'Off-Page', 'Technical SEO',
        'Schema Recommendations', 'Implementation', '---', '==='
      ];

      var endIdx = raw.length;
      for (var j = 0; j < endMarkers.length; j++) {
        var eIdx = raw.indexOf(endMarkers[j], startIdx + 100); // Skip at least 100 chars
        if (eIdx > -1 && eIdx < endIdx) endIdx = eIdx;
      }

      var content = raw.substring(startIdx, endIdx).trim();
      if (content.length > 100) return content;
    }
  }

  return null;
}


/**
 * Extract schema recommendations from Surge data.
 */
function extractSchemaRecommendations(surgeData) {
  if (!surgeData) return null;

  // Structured paths
  if (surgeData.action_plan && typeof surgeData.action_plan === 'object') {
    var ap = surgeData.action_plan;
    if (ap.schema) return ap.schema;
    if (ap.schema_recommendations) return ap.schema_recommendations;
    if (ap.structured_data) return ap.structured_data;
  }

  if (surgeData.intelligence && typeof surgeData.intelligence === 'object') {
    if (surgeData.intelligence.schema) return surgeData.intelligence.schema;
  }

  // Raw text: look for schema section
  var raw = surgeData.raw_text || '';
  if (typeof surgeData === 'string') raw = surgeData;
  if (!raw) return null;

  var schemaIdx = raw.indexOf('Schema');
  if (schemaIdx === -1) schemaIdx = raw.indexOf('Structured Data');
  if (schemaIdx > -1) {
    var section = raw.substring(schemaIdx, schemaIdx + 2000);
    // Extract schema types mentioned
    var types = [];
    var knownTypes = ['MedicalBusiness', 'MedicalWebPage', 'FAQPage', 'Person', 'Service',
      'BreadcrumbList', 'AggregateRating', 'VideoObject', 'Article', 'LocalBusiness',
      'HealthAndBeautyBusiness', 'ProfessionalService'];
    knownTypes.forEach(function(t) {
      if (section.indexOf(t) > -1) types.push(t);
    });
    if (types.length > 0) {
      return { recommended_types: types, raw_section: section.substring(0, 500) };
    }
  }

  return null;
}


/**
 * Build notification email HTML
 */
function buildNotificationHtml(cp, rtpba, taskId) {
  var clientUrl = 'https://clients.moonraker.ai/admin/clients?slug=' + (cp.client_slug || '') + '&tab=content';

  // Build detail rows as a simple table
  var details = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">';
  details += detailRow('Client', cp.client_slug || '');
  details += detailRow('Page', (cp.page_name || '') + ' (' + (cp.page_type || '') + ')');
  if (cp.target_keyword) details += detailRow('Keyword', cp.target_keyword);
  if (taskId) details += detailRow('Agent Task', taskId);
  details += detailRow('RTPBA Found', rtpba ? 'Yes (' + rtpba.length + ' chars)' : 'No');
  details += '</table>';

  var content = email.sectionHeading('Surge Content Audit Complete') +
    details +
    email.divider() +
    email.p('The content page is now ready for HTML generation in the Content tab.') +
    email.cta(clientUrl, 'Open in Client HQ');

  return email.wrap({
    headerLabel: 'Team Notification',
    content: content,
    footerNote: 'This is an internal notification for the Moonraker team.',
    year: new Date().getFullYear()
  });
}

function detailRow(label, value) {
  return '<tr>' +
    '<td style="font-family:Inter,sans-serif;font-size:14px;color:#6B7599;padding:6px 0;width:120px;vertical-align:top;">' + email.esc(label) + '</td>' +
    '<td style="font-family:Inter,sans-serif;font-size:14px;font-weight:600;color:#1E2A5E;padding:6px 0;">' + email.esc(value) + '</td>' +
  '</tr>';
}
