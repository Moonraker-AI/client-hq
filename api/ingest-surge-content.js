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
 * 2. Parses surge_data via canonical surge-parser
 * 3. Updates content_pages with surge_data, rtpba, schema_recommendations,
 *    variance, surge_status -> processed, status -> audit_loaded
 * 4. Sends team notification via Resend
 */

var auth = require('./_lib/auth');
var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var surgeParser = require('./_lib/surge-parser');

module.exports = async function(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var RESEND_KEY = process.env.RESEND_API_KEY;

  var body = req.body;
  if (!body || !body.content_page_id) {
    return res.status(400).json({ error: 'content_page_id required' });
  }
  if (!body.surge_data) {
    return res.status(400).json({ error: 'surge_data required' });
  }

  try {
    // 1. Fetch current content page + contact (contact powers display name in
    // notification subject + Client row, so the team sees a real practice
    // name instead of a slug like "mark-obrien").
    var cp = await sb.one('content_pages?id=eq.' + encodeURIComponent(body.content_page_id) + '&limit=1');
    if (!cp) {
      return res.status(404).json({ error: 'Content page not found' });
    }

    var contact = null;
    if (cp.contact_id) {
      try {
        contact = await sb.one('contacts?id=eq.' + encodeURIComponent(cp.contact_id) + '&limit=1');
      } catch (e) { /* notification falls back to slug if fetch fails */ }
    }

    // 2. Capture the raw payload before any mutation. Useful for re-parsing
    // with a future parser version (parser_version is recorded on each ingest).
    var rawForStorage = '';
    if (typeof body.surge_data === 'string') {
      rawForStorage = body.surge_data;
    } else if (body.surge_data && typeof body.surge_data === 'object') {
      // Prefer raw_text envelope if present; otherwise stringify the object
      rawForStorage = body.surge_data.raw_text || JSON.stringify(body.surge_data);
    }

    // 3. Parse via canonical surge-parser. Handles markdown (Anna's shape),
    // legacy JSON, and mixed envelopes.
    var parsed = surgeParser.parse(body.surge_data);

    // 4. Update content_pages. We store both the raw markdown (for re-parsing)
    // and the structured parse output (for Pagemaster + UI consumption).
    var updateData = {
      surge_raw_data: rawForStorage,
      surge_data: parsed,                                 // structured parse output
      rtpba: parsed.rtpba || null,
      schema_recommendations: parsed.schema_recommendations || null,
      variance_score: parsed.variance_score,              // null when not extractable
      variance_label: parsed.variance_label,
      surge_status: 'processed',
      status: 'audit_loaded',
      agent_task_id: body.agent_task_id || cp.agent_task_id,
      updated_at: new Date().toISOString()
    };
    var rtpba = parsed.rtpba;
    var schemaRecs = parsed.schema_recommendations;

    try {
      await sb.mutate('content_pages?id=eq.' + encodeURIComponent(body.content_page_id), 'PATCH', updateData);
    } catch (e) {
      monitor.logError('ingest-surge-content', e, { detail: { stage: 'update_content_page', content_page_id: body.content_page_id } });
      return res.status(500).json({ error: 'Failed to update content page' });
    }

    // 5. Notify team
    if (RESEND_KEY) {
      try {
        var displayName = buildDisplayName(contact, cp);
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + RESEND_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: email.FROM.notifications,
            to: ['support@moonraker.ai'],
            subject: 'Surge Content Audit Complete: ' + (cp.page_name || cp.target_keyword || 'Unknown') + ' (' + displayName + ')',
            html: buildNotificationHtml(cp, rtpba, body.agent_task_id, displayName)
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
      has_schema: !!schemaRecs && schemaRecs.blocks && schemaRecs.blocks.length > 0,
      schema_block_count: (schemaRecs && schemaRecs.blocks) ? schemaRecs.blocks.length : 0,
      variance_score: parsed.variance_score,
      variance_label: parsed.variance_label,
      parser_version: parsed.parser_version,
      source_shape: parsed.source_shape,
      status: 'audit_loaded'
    });

  } catch (err) {
    console.error('ingest-surge-content error:', err);
    monitor.logError('ingest-surge-content', err, {
      detail: { stage: 'ingest_handler' }
    });
    return res.status(500).json({ error: 'Failed to ingest surge content' });
  }
};


/**
 * Build a display name preferring practice_name, falling back to first+last,
 * then slug. Used in subject + Client row of notification email.
 */
function buildDisplayName(contact, cp) {
  if (contact) {
    if (contact.practice_name) return contact.practice_name;
    var first = (contact.first_name || '').trim();
    var last = (contact.last_name || '').trim();
    var combined = (first + ' ' + last).trim();
    if (combined) return combined;
  }
  return cp && cp.client_slug ? cp.client_slug : '';
}


/**
 * Build notification email HTML
 */
function buildNotificationHtml(cp, rtpba, taskId, displayName) {
  var clientUrl = 'https://clients.moonraker.ai/admin/clients?slug=' + (cp.client_slug || '') + '&tab=content';
  var clientLabel = displayName || cp.client_slug || '';

  // Build detail rows as a simple table
  var details = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">';
  details += detailRow('Client', clientLabel);
  details += detailRow('Page', (cp.page_name || '') + ' (' + (cp.page_type || '') + ')');
  if (cp.target_keyword) details += detailRow('Keyword', cp.target_keyword);
  if (taskId) details += detailRow('Agent Task', taskId);
  details += detailRow('RTPBA Found', rtpba ? 'Yes (' + rtpba.length + ' chars)' : 'No');
  details += '</table>';

  var content = email.sectionHeading('Surge Content Audit Complete') +
    details +
    email.divider() +
    email.pRaw('The content page is now ready for HTML generation in the Content tab.') +
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
