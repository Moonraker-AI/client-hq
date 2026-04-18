// api/admin/client-detail.js
// Server-side aggregation endpoint for the client deep-dive overview.
// Collapses 2-phase sequential load (7 requests) into 1 API call.
// Uses service_role (no RLS overhead) and runs all queries in parallel.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug parameter required' });

  try {
    // Phase 1: Get the contact first (we need the id for subsequent queries)
    var contacts = await sb.query('contacts?slug=eq.' + encodeURIComponent(slug) + '&limit=1');
    var contact = (contacts && contacts[0]) || null;

    if (!contact) {
      return res.status(404).json({ error: 'Client not found', slug: slug });
    }

    var cid = contact.id;

    // Phase 2: All remaining queries in parallel
    var results = await Promise.all([
      // All contacts for search dropdown (lightweight fields only)
      sb.query('contacts?select=id,slug,status,practice_name,email,first_name,last_name&order=practice_name'),

      // Practice details
      sb.query('practice_details?select=*&contact_id=eq.' + cid),

      // Tab counts (RPC)
      sb.mutate('rpc/get_tab_counts', 'POST', { p_contact_id: cid, p_slug: slug }),

      // Latest entity audit (all fields except surge_raw_data/surge_data which are huge)
      sb.query('entity_audits?select=id,contact_id,client_slug,status,agent_error_retriable,last_agent_error,last_agent_error_at,last_agent_error_code,last_debug_path,audit_tier,audit_date,audit_period,audit_scope,score_credibility,score_optimization,score_reputation,score_engagement,scores,variance_score,variance_label,cres_score,total_tasks,tasks_p1,tasks_p2,tasks_p3,tasks_moonraker,tasks_client,tasks_collaboration,cited_google_ai,cited_chatgpt,cited_claude,cited_perplexity,cited_bing,cited_youtube,cited_reddit,cited_meta,agent_task_id,geo_target,gbp_share_link,variance_from_previous,brand_query,homepage_url,loom_url,sent_at,sent_to,email_subject,stripe_payment_id,created_at,updated_at&contact_id=eq.' + cid + '&order=created_at.desc&limit=1'),

      // Performance guarantee
      sb.query('performance_guarantees?select=*&contact_id=eq.' + cid + '&limit=1'),

      // Bio materials
      sb.query('bio_materials?select=*&contact_id=eq.' + cid + '&order=sort_order,is_primary.desc')
    ]);

    res.status(200).json({
      contact: contact,
      allContacts: results[0] || [],
      practice: (results[1] && results[1][0]) || null,
      tabCounts: results[2] || {},
      entityAudit: (results[3] && results[3][0]) || null,
      guarantee: (results[4] && results[4][0]) || null,
      bioMaterials: results[5] || []
    });
  } catch (e) {
    console.error('[client-detail] Error:', e.message);
    res.status(500).json({ error: 'Failed to load client detail' });
  }
};
