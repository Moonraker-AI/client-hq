// api/admin/audits-directory.js
// Server-side aggregation for the audits summary page.
// Replaces 3 browser-to-Supabase requests (including 1,806+ raw checklist rows)
// with 1 API call using a pre-aggregated task summary RPC.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  try {
    var results = await Promise.all([
      // Contacts
      sb.query('contacts?select=id,slug,status,practice_name,email,first_name,last_name,website_url,lost&order=practice_name'),

      // Entity audits (lightweight fields for summary view; omits scores JSONB ~1MB and tasks JSONB ~588KB)
      sb.query('entity_audits?select=id,contact_id,client_slug,status,audit_tier,audit_date,audit_period,score_credibility,score_optimization,score_reputation,score_engagement,total_tasks,tasks_p1,tasks_p2,tasks_p3,tasks_moonraker,tasks_client,tasks_collaboration,brand_query,agent_task_id,created_at,updated_at&order=created_at.desc'),

      // Task summary per audit (RPC - replaces 1,806+ raw rows)
      sb.mutate('rpc/get_audit_task_summary', 'POST', {})
    ]);

    res.status(200).json({
      contacts: results[0] || [],
      audits: results[1] || [],
      taskSummary: results[2] || []
    });
  } catch (e) {
    console.error('[audits-directory] Error:', e.message);
    res.status(500).json({ error: 'Failed to load audits data' });
  }
};
