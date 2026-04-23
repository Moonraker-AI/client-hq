/**
 * /api/trigger-batch-audit.js
 *
 * Triggers a multi-page batch Surge audit on the Moonraker Agent Service.
 * Called from the admin UI (Content tab) when keyword targets are established.
 *
 * POST body: { client_slug }
 *   Optional: { client_slug, keyword_ids: [...] } to audit specific keywords only
 *
 * Flow:
 * 1. Looks up contact + tracked_keywords (P1, active, with target_page)
 * 2. Ensures content_pages rows exist for each keyword (upserts)
 * 3. Creates a content_audit_batches record
 * 4. POSTs to agent service /tasks/surge-batch-audit with full payload
 * 5. Updates batch + content_pages with agent_task_id
 * 6. Returns batch_id + task_id for polling
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (!AGENT_URL || !AGENT_KEY) return res.status(500).json({ error: 'Agent service not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  if (!body.client_slug) return res.status(400).json({ error: 'client_slug required' });

  try {
    // 1. Fetch contact
    var contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(body.client_slug) + '&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    if (!contact.website_url) {
      return res.status(400).json({ error: 'Website URL required. Add it to the contact record.' });
    }
    if (!contact.gbp_url) {
      return res.status(400).json({ error: 'GBP URL required for batch audit.' });
    }

    // 2. Fetch tracked keywords (P1, active, with target page)
    var kwFilter = 'tracked_keywords?client_slug=eq.' + encodeURIComponent(body.client_slug) +
      '&active=eq.true&priority=eq.1&order=keyword.asc';

    // If specific keyword IDs provided, filter to those. Validate every element
    // against a strict UUID regex BEFORE joining + interpolating — PostgREST
    // parses the filter, but an admin with a compromised session could splice
    // arbitrary filter clauses via a crafted array element otherwise.
    if (body.keyword_ids && body.keyword_ids.length > 0) {
      if (!Array.isArray(body.keyword_ids) || !body.keyword_ids.every(function(id) { return typeof id === 'string' && UUID_RE.test(id); })) {
        return res.status(400).json({ error: 'keyword_ids must be an array of UUIDs' });
      }
      kwFilter += '&id=in.(' + body.keyword_ids.map(encodeURIComponent).join(',') + ')';
    }

    var keywords = await sb.query(kwFilter);

    if (!keywords || keywords.length === 0) {
      return res.status(400).json({ error: 'No active P1 keywords with target pages found.' });
    }

    // Filter to keywords that have a target page URL
    var validKeywords = keywords.filter(function(kw) { return kw.target_page; });
    if (validKeywords.length === 0) {
      return res.status(400).json({ error: 'No keywords have target page URLs set.' });
    }

    // 3. Check for existing running batch
    var existing = await sb.query('content_audit_batches?client_slug=eq.' + encodeURIComponent(body.client_slug) +
      '&status=in.(queued,agent_running,extracting,processing)&limit=1');
    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'A batch audit is already in progress for this client.',
        batch_id: existing[0].id,
        status: existing[0].status
      });
    }

    // 4. Create batch record
    var batchData = {
      contact_id: contact.id,
      client_slug: contact.slug,
      status: 'queued',
      pages_total: validKeywords.length,
      triggered_by: body.triggered_by || 'admin'
    };

    var batchResult;
    try {
      batchResult = await sb.mutate('content_audit_batches', 'POST', batchData);
    } catch (e) {
      monitor.logError('trigger-batch-audit', e, { client_slug: body.client_slug, detail: { stage: 'create_batch' } });
      return res.status(500).json({ error: 'Failed to create batch record' });
    }
    var batch = batchResult[0];

    // 5. Upsert content_pages for each keyword
    var pages = [];
    for (var i = 0; i < validKeywords.length; i++) {
      var kw = validKeywords[i];

      // Check if content_page already exists for this keyword
      var existingPage = await sb.one(
        'content_pages?tracked_keyword_id=eq.' + encodeURIComponent(kw.id) + '&client_slug=eq.' + encodeURIComponent(contact.slug) + '&limit=1'
      );

      var pageId;
      if (existingPage) {
        // Update existing page with batch linkage
        await sb.mutate('content_pages?id=eq.' + existingPage.id, 'PATCH', {
          batch_id: batch.id,
          surge_status: 'pending',
          target_url: kw.target_page,
          target_keyword: kw.keyword,
          updated_at: new Date().toISOString()
        }, 'return=minimal');
        pageId = existingPage.id;
      } else {
        // Create new content_page
        var pageSlug = kw.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        var newPage;
        try {
          var newPageResult = await sb.mutate('content_pages', 'POST', {
            contact_id: contact.id,
            client_slug: contact.slug,
            page_type: kw.keyword_type === 'location' ? 'location' : 'service',
            page_name: kw.keyword,
            page_slug: pageSlug,
            tracked_keyword_id: kw.id,
            target_url: kw.target_page,
            target_keyword: kw.keyword,
            batch_id: batch.id,
            surge_status: 'pending',
            status: 'pending_audit'
          });
          newPage = newPageResult[0];
        } catch (e) {
          console.error('Failed to create content page for keyword:', kw.keyword, e.message);
          continue;
        }
        pageId = newPage.id;
      }

      pages.push({
        content_page_id: pageId,
        keyword: kw.keyword,
        target_url: kw.target_page
      });
    }

    if (pages.length === 0) {
      // Cleanup batch if no pages were created
      await sb.mutate('content_audit_batches?id=eq.' + batch.id, 'PATCH', {
        status: 'failed',
        error_message: 'No content pages could be created'
      }, 'return=minimal');
      return res.status(500).json({ error: 'Failed to create any content pages for batch.' });
    }

    // 6. Build agent payload
    var practiceName = contact.practice_name ||
      ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();

    var geoTarget = '';
    if (contact.city || contact.state_province) {
      geoTarget = (contact.city || '') +
        (contact.city && contact.state_province ? ', ' : '') +
        (contact.state_province || '');
    }

    // Determine entity type from GBP URL
    var entityType = 'Local Business';

    var agentPayload = {
      batch_id: batch.id,
      client_slug: contact.slug,
      brand_name: practiceName,
      gbp_url: contact.gbp_url,
      entity_type: entityType,
      geo_target: geoTarget,
      website_url: contact.website_url,
      pages: pages,
      callback_url: 'https://clients.moonraker.ai/api/ingest-batch-audit'
    };

    // 7. Trigger agent
    var agentResp = await fetch(AGENT_URL + '/tasks/surge-batch-audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify(agentPayload)
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}

      // Mark batch as error but don't delete it
      await sb.mutate('content_audit_batches?id=eq.' + batch.id, 'PATCH', {
        status: 'agent_error',
        error_message: 'Agent returned ' + agentResp.status + ': ' + errText.substring(0, 200)
      }, 'return=minimal');

      return res.status(502).json({
        error: 'Agent service returned ' + agentResp.status,
        detail: errText.substring(0, 300),
        batch_id: batch.id
      });
    }

    var agentResult = await agentResp.json();

    // 8. Update batch with agent task ID
    await sb.mutate('content_audit_batches?id=eq.' + batch.id, 'PATCH', {
      status: 'agent_running',
      agent_task_id: agentResult.task_id,
      updated_at: new Date().toISOString()
    }, 'return=minimal');

    return res.status(200).json({
      success: true,
      batch_id: batch.id,
      task_id: agentResult.task_id,
      pages_count: pages.length,
      keywords: pages.map(function(p) { return p.keyword; }),
      message: 'Batch audit triggered for ' + pages.length + ' keywords.'
    });

  } catch (err) {
    console.error('trigger-batch-audit error:', err);
    monitor.logError('trigger-batch-audit', err, {
      detail: { stage: 'trigger_handler' }
    });
    return res.status(500).json({ error: 'Failed to trigger batch audit' });
  }
};
