/**
 * /api/onboarding/lock-target-pages.js
 *
 * The "Lock target pages and fire audits" button posts here from the
 * pages-chain admin. This is the campaign-start ceremony: it locks in the
 * client's target pages (creating an audit batch row), auto-links the
 * homepage to a fresh entity audit when one exists, and queues per-service-
 * page Surge audits via the agent VPS.
 *
 * POST body:
 *   { contact_id: uuid,
 *     page_ids?: [uuid, ...]   // optional: lock only specific pages.
 *                              // default = all eligible pages for the contact
 *   }
 *
 * Returns:
 *   { batch_id, queued_pages: N, auto_linked_pages: N, skipped: [...], errors: [...] }
 *
 * Idempotency: if a content_audit_batches row already exists for this contact
 * in queued/agent_running/extracting/processing status, return its id without
 * re-firing. Use ?force=true to override (e.g. after a partial failure).
 *
 * Auth: admin only (this is a campaign-start ceremony, not an automated path).
 */

var sb = require('../_lib/supabase');
var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var surgeParser = require('../_lib/surge-parser');

var ENTITY_AUDIT_FRESHNESS_DAYS = 30;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  if (!AGENT_URL || !AGENT_KEY) return res.status(500).json({ error: 'Agent service not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  var force = req.query && (req.query.force === 'true' || req.query.force === '1');
  var pageIdFilter = Array.isArray(body.page_ids) && body.page_ids.length > 0 ? body.page_ids : null;

  try {
    // 1. Load contact + practice context
    var contact = await sb.one('contacts?id=eq.' + encodeURIComponent(contactId) + '&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    var clientSlug = contact.slug;
    if (!clientSlug) return res.status(400).json({ error: 'Contact missing slug' });

    // 2. Idempotency check: existing in-flight batch?
    var IN_FLIGHT_STATUSES = ['queued', 'agent_running', 'extracting', 'processing'];
    var existing = await sb.query(
      'content_audit_batches?contact_id=eq.' + encodeURIComponent(contactId) +
      '&status=in.(' + IN_FLIGHT_STATUSES.join(',') + ')' +
      '&order=created_at.desc&limit=1'
    );
    if (existing && existing.length > 0 && !force) {
      return res.status(200).json({
        batch_id: existing[0].id,
        already_in_flight: true,
        message: 'A batch is already in flight for this contact. Pass ?force=true to ignore.'
      });
    }

    // 3. Load eligible pages (homepage + service only at this stage; bio/faq/
    //    location have their own flows and aren't audit-driven the same way).
    var pagesQuery = 'content_pages?contact_id=eq.' + encodeURIComponent(contactId) +
      '&page_type=in.(homepage,service)' +
      '&order=page_type.desc,created_at.asc';  // homepage first
    var allPages = await sb.query(pagesQuery);
    if (!allPages || allPages.length === 0) {
      return res.status(400).json({ error: 'No eligible content_pages found. Run /api/seed-content-pages first.' });
    }

    var pages = allPages;
    if (pageIdFilter) {
      var filterSet = new Set(pageIdFilter);
      pages = pages.filter(function(p) { return filterSet.has(p.id); });
      if (pages.length === 0) return res.status(400).json({ error: 'page_ids did not match any eligible pages' });
    }

    // 4. Create the batch row
    var batchInsert = await sb.mutate('content_audit_batches', 'POST', {
      contact_id: contactId,
      client_slug: clientSlug,
      status: 'queued',
      pages_total: pages.length,
      pages_extracted: 0,
      pages_processed: 0,
      triggered_by: user.email || user.id || 'admin'
    }, 'return=representation');
    var batch = Array.isArray(batchInsert) ? batchInsert[0] : batchInsert;
    var batchId = batch && batch.id;
    if (!batchId) {
      monitor.logError('lock-target-pages', new Error('batch insert returned no id'), {
        client_slug: clientSlug, detail: { stage: 'batch_insert', result: batchInsert }
      });
      return res.status(500).json({ error: 'Failed to create audit batch' });
    }

    // 5. Process each page
    var results = {
      batch_id: batchId,
      queued_pages: 0,
      auto_linked_pages: 0,
      skipped: [],
      errors: []
    };

    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var pageRef = { id: page.id, name: page.page_name || page.target_keyword || page.page_slug, type: page.page_type };

      // Stamp every page with the batch_id up front so we can correlate later.
      try {
        await sb.mutate('content_pages?id=eq.' + encodeURIComponent(page.id), 'PATCH',
          { batch_id: batchId, surge_status: 'pending' }, 'return=minimal');
      } catch (e) {
        results.errors.push({ page: pageRef, stage: 'stamp_batch', message: e.message });
        continue;
      }

      // Homepage: try to auto-link a fresh entity audit
      if (page.page_type === 'homepage') {
        var linked = await tryAutoLinkEntityAudit(page, contactId);
        if (linked.auto_linked) {
          results.auto_linked_pages++;
          continue;
        }
        if (linked.error) {
          results.errors.push({ page: pageRef, stage: 'auto_link', message: linked.error });
          // fall through to queue a fresh Surge
        }
      }

      // Queue a Surge audit via the agent
      var queued = await queueSurgeAudit(page, contact, AGENT_URL, AGENT_KEY);
      if (queued.success) {
        results.queued_pages++;
      } else {
        results.errors.push({ page: pageRef, stage: 'queue_surge', message: queued.message });
      }
    }

    // 6. If everything got auto-linked or skipped, advance batch state.
    //    Otherwise leave it queued — ingest-surge-content advances per page,
    //    and the batch summary cron will close it when all pages are processed.
    if (results.queued_pages === 0 && results.errors.length === 0) {
      await sb.mutate('content_audit_batches?id=eq.' + batchId, 'PATCH', {
        status: 'complete',
        pages_extracted: results.auto_linked_pages,
        pages_processed: results.auto_linked_pages,
        updated_at: new Date().toISOString()
      }, 'return=minimal');
    } else if (results.queued_pages > 0) {
      await sb.mutate('content_audit_batches?id=eq.' + batchId, 'PATCH', {
        status: 'agent_running',
        updated_at: new Date().toISOString()
      }, 'return=minimal');
    }

    return res.status(200).json(results);

  } catch (err) {
    console.error('lock-target-pages error:', err);
    monitor.logError('lock-target-pages', err, {
      detail: { stage: 'outer_catch', contact_id: contactId }
    });
    return res.status(500).json({ error: 'Failed to lock target pages' });
  }
};


// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * For a homepage content_page, look up the most recent complete entity audit
 * for the contact. If fresh (≤ N days), copy its surge_raw_data + parsed
 * fields onto the homepage content_page. Returns:
 *   { auto_linked: true } if linked
 *   { auto_linked: false } if no fresh audit found
 *   { auto_linked: false, error: '...' } on error
 */
async function tryAutoLinkEntityAudit(page, contactId) {
  try {
    var audits = await sb.query(
      'entity_audits?contact_id=eq.' + encodeURIComponent(contactId) +
      "&status=eq.complete" +
      '&order=created_at.desc&limit=1'
    );
    if (!audits || audits.length === 0) return { auto_linked: false };

    var audit = audits[0];
    var ageMs = Date.now() - new Date(audit.created_at).getTime();
    var ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > ENTITY_AUDIT_FRESHNESS_DAYS) {
      // Stale — fall through to queue a fresh one. Per Chris's note, signup
      // already triggers an entity audit, so stale should be rare in practice.
      return { auto_linked: false };
    }

    // Source data: prefer raw markdown for clean re-parsing
    var raw = audit.surge_raw_data || '';
    if (!raw && audit.surge_data) {
      raw = typeof audit.surge_data === 'string' ? audit.surge_data : (audit.surge_data.raw_text || JSON.stringify(audit.surge_data));
    }

    // Parse with the canonical parser to fill the same fields a service-page
    // Surge ingest would.
    var parsed = surgeParser.parse(raw || audit.surge_data);

    await sb.mutate('content_pages?id=eq.' + encodeURIComponent(page.id), 'PATCH', {
      entity_audit_id: audit.id,
      surge_raw_data: raw || null,
      surge_data: parsed,
      rtpba: parsed.rtpba || null,
      schema_recommendations: parsed.schema_recommendations || null,
      variance_score: parsed.variance_score,
      variance_label: parsed.variance_label,
      surge_status: 'processed',
      status: 'audit_loaded',
      updated_at: new Date().toISOString()
    }, 'return=minimal');

    return { auto_linked: true };
  } catch (e) {
    return { auto_linked: false, error: e.message };
  }
}

/**
 * Queue a Surge audit for a page via the agent VPS. Mirrors the pattern in
 * api/trigger-content-audit.js but inlined so we can batch many pages
 * without N HTTP hops to ourselves.
 */
async function queueSurgeAudit(page, contact, AGENT_URL, AGENT_KEY) {
  var websiteUrl = contact.website_url || '';
  var practiceName = contact.practice_name ||
    ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var targetKeyword = page.target_keyword || page.page_name || '';

  if (!websiteUrl) return { success: false, message: 'Contact missing website_url' };
  if (!targetKeyword) return { success: false, message: 'Page missing target_keyword' };

  var geoTarget = '';
  if (contact.city || contact.state_province) {
    geoTarget = (contact.city || '') + (contact.city && contact.state_province ? ', ' : '') + (contact.state_province || '');
  }

  var searchQuery = targetKeyword;
  if (contact.campaign_type !== 'national' && geoTarget) {
    var lcKeyword = targetKeyword.toLowerCase();
    var lcCity = (contact.city || '').toLowerCase();
    if (lcCity && lcKeyword.indexOf(lcCity) === -1) {
      searchQuery = targetKeyword + ' ' + geoTarget;
    }
  }

  try {
    var agentResp = await fetch(AGENT_URL + '/tasks/surge-content-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AGENT_KEY },
      body: JSON.stringify({
        content_page_id: page.id,
        practice_name: practiceName,
        website_url: websiteUrl,
        target_keyword: targetKeyword,
        search_query: searchQuery,
        page_type: page.page_type,
        city: contact.city || '',
        state: contact.state_province || '',
        geo_target: geoTarget,
        client_slug: contact.slug,
        callback_url: 'https://clients.moonraker.ai/api/ingest-surge-content'
      })
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch (e) {}
      return { success: false, message: 'Agent returned ' + agentResp.status + ': ' + errText.substring(0, 200) };
    }

    var agentResult = await agentResp.json();
    await sb.mutate('content_pages?id=eq.' + encodeURIComponent(page.id), 'PATCH', {
      agent_task_id: agentResult.task_id,
      surge_status: 'pending'
    }, 'return=minimal');

    return { success: true, task_id: agentResult.task_id };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
