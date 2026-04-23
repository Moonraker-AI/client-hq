// api/admin/onboarding-directory.js
// FE-H2 extras. Consolidated admin-gated read for the onboarding directory
// page (admin/onboarding/index.html).
//
// Replaces the two anon-key PostgREST fetches at admin/onboarding/index.html
// lines 376-377:
//   fetch(SB + '/rest/v1/contacts?select=id,slug,status,practice_name,email,first_name,last_name,onboarding_completed,agreement_signed,campaign_start&order=practice_name')
//   fetch(SB + '/rest/v1/onboarding_steps?select=contact_id,step_key,status,sort_order&order=contact_id,sort_order&limit=5000')
//
// Scope narrowing:
//   The existing page fetches EVERY contact ordered by practice_name and
//   filters to status=onboarding client-side. That's a full-table anon
//   enumeration path. This endpoint moves the filter server-side to
//   status IN ('onboarding') so only the relevant rows cross the wire.
//   If the page ever wants to show other statuses for context, widen the
//   status list here rather than returning every contact.
//
// Method:   GET   (405 otherwise, with Allow header)
// Auth:     requireAdmin
// Query:    none
// Returns:  200 { contacts: [...], onboarding_steps: [...] }
//           500 generic
//
// Column set matches what the page renders today. Extra columns
// (onboarding_paid_at, onboarding_started_at, onboarding_completed_at) noted
// in the task spec are included as a superset; harmless to the existing
// render code and a real improvement if the page adds timestamps later.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

var CONTACT_COLS = [
  'id',
  'slug',
  'first_name',
  'last_name',
  'email',
  'practice_name',
  'website_url',
  'status',
  'onboarding_completed',
  'onboarding_paid_at',
  'onboarding_started_at',
  'onboarding_completed_at',
  'agreement_signed',
  'campaign_start'
].join(',');

var STEP_COLS = 'contact_id,step_key,status,sort_order';

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
        'contacts?status=in.(onboarding)' +
        '&select=' + CONTACT_COLS +
        '&order=practice_name'
      ),
      sb.query(
        'onboarding_steps?select=' + STEP_COLS +
        '&order=contact_id,sort_order' +
        '&limit=5000'
      )
    ]);

    return res.status(200).json({
      contacts: results[0] || [],
      onboarding_steps: results[1] || []
    });
  } catch (err) {
    await monitor.logError('admin-onboarding-directory', err, {
      detail: { stage: 'parallel_reads' }
    });
    return res.status(500).json({ error: 'Failed to load onboarding directory' });
  }
};
