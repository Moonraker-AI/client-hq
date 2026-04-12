/**
 * /api/trigger-agent.js
 * 
 * Triggers a Surge audit on the Moonraker Agent Service.
 * Called from the admin UI when "Run Automated Audit" is clicked.
 * 
 * POST body: { audit_id, contact_id }
 * 
 * Flow:
 * 1. Looks up contact + entity_audit data from Supabase
 * 2. Validates required fields (website_url, practice_name)
 * 3. POSTs to agent service to start the audit
 * 4. Updates entity_audit status to 'agent_running'
 * 5. Returns task_id for client-side polling
 */

var sb = require('./_lib/supabase');
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
  if (!body || !body.audit_id || !body.contact_id) {
    return res.status(400).json({ error: 'audit_id and contact_id required' });
  }

  try {
    // 1. Fetch contact data
    var contact = await sb.one('contacts?id=eq.' + body.contact_id + '&select=*&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // 2. Fetch entity audit
    var audit = await sb.one('entity_audits?id=eq.' + body.audit_id + '&select=*&limit=1');
    if (!audit) return res.status(404).json({ error: 'Entity audit not found' });

    // 3. Assemble fields: prefer audit row, fall back to contact
    var websiteUrl = audit.homepage_url || contact.website_url || '';
    var practiceName = audit.brand_query || contact.practice_name || (contact.first_name + ' ' + contact.last_name);
    var geoTarget = audit.geo_target || '';
    var gbpLink = audit.gbp_share_link || '';

    if (!geoTarget && (contact.city || contact.state_province)) {
      geoTarget = (contact.city || '') + (contact.city && contact.state_province ? ', ' : '') + (contact.state_province || '');
    }

    if (!websiteUrl) return res.status(400).json({ error: 'Website URL is required. Add it to the audit before running.' });
    if (!practiceName) return res.status(400).json({ error: 'Practice name or brand query is required.' });

    // 4. Trigger agent
    var agentResp = await fetch(AGENT_URL + '/tasks/surge-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AGENT_KEY },
      body: JSON.stringify({
        audit_id: body.audit_id, practice_name: practiceName,
        website_url: websiteUrl, city: contact.city || '',
        state: contact.state_province || '', geo_target: geoTarget,
        gbp_link: gbpLink, client_slug: contact.slug
      })
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}
      return res.status(502).json({ error: 'Agent service returned ' + agentResp.status, detail: errText.substring(0, 300) });
    }

    var agentResult = await agentResp.json();

    // 5. Update entity_audit status
    await sb.mutate('entity_audits?id=eq.' + body.audit_id, 'PATCH', {
      status: 'agent_running', agent_task_id: agentResult.task_id
    }, 'return=minimal');

    return res.status(200).json({
      success: true, task_id: agentResult.task_id,
      message: 'Surge audit triggered. The agent will handle everything automatically.'
    });

  } catch (err) {
    console.error('trigger-agent error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
