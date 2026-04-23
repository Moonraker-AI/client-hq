// api/admin/reports-directory.js
// FE-H2 extras. Consolidated admin-gated read for the reports directory
// page (admin/reports/index.html).
//
// Replaces the three anon-key PostgREST fetches at admin/reports/index.html
// lines ~904-906:
//   sbFetch('contacts?select=slug,status,practice_name,email,gsc_property,ga4_property&status=eq.active&order=practice_name')
//   sbFetch('report_configs?select=*&order=client_slug')
//   sbFetch('report_snapshots?select=client_slug,report_month,report_status,created_at&order=created_at.desc&limit=50')
//
// Scope change vs. current page:
//   The current page filters contacts to status=active only. The task spec
//   widens that to status IN ('active','onboarding') AND lost=false. That's
//   the intended long-term filter (active clients plus onboarding clients
//   that are about to start producing reports). Kept as the endpoint
//   contract — the page can iterate.
//
// Method:   GET   (405 otherwise, with Allow header)
// Auth:     requireAdmin
// Query:    none
// Returns:  200 { contacts: [...], report_snapshots: [...], report_configs: [...] }
//           500 generic

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

var CONTACT_COLS = [
  'id',
  'slug',
  'first_name',
  'last_name',
  'practice_name',
  'email',
  'status',
  'lost',
  'gsc_property',
  'ga4_property',
  'campaign_start'
].join(',');

var SNAPSHOT_COLS = 'client_slug,report_month,report_status,created_at';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  try {
    var results = await Promise.all([
      sb.query(
        'contacts?status=in.(active,onboarding)' +
        '&lost=eq.false' +
        '&select=' + CONTACT_COLS +
        '&order=practice_name'
      ),
      sb.query('report_snapshots?select=' + SNAPSHOT_COLS + '&order=created_at.desc&limit=50'),
      sb.query('report_configs?select=*&order=client_slug')
    ]);

    return res.status(200).json({
      contacts: results[0] || [],
      report_snapshots: results[1] || [],
      report_configs: results[2] || []
    });
  } catch (err) {
    await monitor.logError('admin-reports-directory', err, {
      detail: { stage: 'parallel_reads' }
    });
    return res.status(500).json({ error: 'Failed to load reports directory' });
  }
};
