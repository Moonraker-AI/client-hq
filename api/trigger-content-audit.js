/**
 * /api/trigger-content-audit.js
 *
 * Triggers a Surge content audit on the Moonraker Agent Service.
 * Called from the admin UI for keyword-specific page audits (not homepage entity audits).
 *
 * POST body: { content_page_id }
 *
 * Flow:
 * 1. Looks up content_page + contact data from Supabase
 * 2. Validates required fields (target_keyword, website_url)
 * 3. POSTs to agent service to start a content-specific Surge audit
 * 4. Updates content_pages status to 'pending_audit' with agent_task_id
 * 5. Returns task_id for client-side polling
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;


  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (!AGENT_URL || !AGENT_KEY) return res.status(500).json({ error: 'Agent service not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  if (!body || !body.content_page_id) return res.status(400).json({ error: 'content_page_id required' });

  try {
    // 1. Fetch content page
    var cp = await sb.one('content_pages?id=eq.' + encodeURIComponent(body.content_page_id) + '&limit=1');
    if (!cp) return res.status(404).json({ error: 'Content page not found' });

    // 2. Fetch contact
    var contact = await sb.one('contacts?id=eq.' + encodeURIComponent(cp.contact_id) + '&select=*&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // 3. Assemble audit parameters per Surge entity-audit protocol:
    //   - Search Query  : exact page name / target keyword (no geo concat)
    //   - Geographic Target : city + state (separate Surge field)
    //   - Google Maps URL : contact.gbp_url (separate Surge field)
    //   - Brand : practice_name (or first+last fallback)
    //   - Category / Industry : "Mental Health" (hardcoded — covers all clients in this niche)
    var websiteUrl = contact.website_url || '';
    var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
    // Surge respects exact casing of the keyword. Use cp.page_name (which is
    // human-formatted, e.g. "Life Coaching for Men") rather than the slug.
    var targetKeyword = cp.page_name || cp.target_keyword || '';
    var geoTarget = '';

    if (contact.city || contact.state_province) {
      geoTarget = (contact.city || '') + (contact.city && contact.state_province ? ', ' : '') + (contact.state_province || '');
    }

    if (!websiteUrl) return res.status(400).json({ error: 'Website URL required. Add it to the contact record.' });
    if (!targetKeyword) return res.status(400).json({ error: 'Target keyword required for content audit.' });
    // GBP is now part of the Surge content-audit form per the entity-audit protocol.
    if (!contact.gbp_url) return res.status(400).json({ error: 'GBP URL required. Add the contact\'s Google Business Profile share link.' });

    // 4. Trigger agent.  search_query equals targetKeyword verbatim — Surge
    // wants the keyword and the geo target in separate inputs.
    var agentResp = await fetch(AGENT_URL + '/tasks/surge-content-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AGENT_KEY },
      body: JSON.stringify({
        content_page_id: body.content_page_id, practice_name: practiceName,
        website_url: websiteUrl, target_keyword: targetKeyword,
        search_query: targetKeyword, page_type: cp.page_type,
        city: contact.city || '', state: contact.state_province || '',
        geo_target: geoTarget, gbp_url: contact.gbp_url,
        category: 'Mental Health',
        client_slug: contact.slug,
        callback_url: 'https://clients.moonraker.ai/api/ingest-surge-content'
      })
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}
      return res.status(502).json({ error: 'Agent service returned ' + agentResp.status, detail: errText.substring(0, 300) });
    }

    var agentResult = await agentResp.json();

    // 5. Update content_pages with agent task ID
    await sb.mutate('content_pages?id=eq.' + encodeURIComponent(body.content_page_id), 'PATCH', {
      agent_task_id: agentResult.task_id
    }, 'return=minimal');

    return res.status(200).json({
      success: true, task_id: agentResult.task_id,
      search_query: targetKeyword, message: 'Content audit triggered for "' + targetKeyword + '".'
    });

  } catch (err) {
    console.error('trigger-content-audit error:', err);
    monitor.logError('trigger-content-audit', err, {
      detail: { stage: 'trigger_handler' }
    });
    return res.status(500).json({ error: 'Failed to trigger content audit' });
  }
};
