// api/admin/audit-blocks.js
// Returns the set of entity audits frozen in terminal non-retriable
// state, grouped by last_agent_error_code, for the global banner on
// /admin/audits. Read-only drill-in — no action buttons here; actions
// live in the client deep-dive.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

// Human-readable labels for the agent_error_code enum. Any code not
// listed here falls back to the raw code string. Kept in sync with the
// UI copy in admin/audits/index.html and admin/clients/index.html.
var CODE_LABELS = {
  surge_maintenance: 'Surge maintenance mode',
  credits_exhausted: 'Surge credits exhausted',
  surge_rejected: 'Surge silently rejected submission',
  target_blocked: 'Target site WAF blocked Surge crawl',
  surge_timeout: 'Surge audit did not complete in 60 min',
  generic_exception: 'Unhandled agent error'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  try {
    // IMPORTANT: entity_audits has TWO FKs to contacts (contact_id and
    // client_slug). PostgREST embeds must disambiguate via the FK name
    // — `contacts!inner(...)` would 300 with PGRST201.
    //
    // IMPORTANT: entity_audits has heavy JSONB columns (surge_raw_data
    // ~160KB, surge_data, tasks, variance_from_previous, email_body).
    // This explicit select avoids pulling them.
    var rows = await sb.query(
      'entity_audits?status=eq.agent_error&agent_error_retriable=eq.false' +
      '&select=id,client_slug,last_agent_error_code,last_agent_error,' +
      'last_agent_error_at,last_debug_path,contact_id,' +
      'contacts!contact_id(practice_name)' +
      '&order=last_agent_error_at.asc'
    );

    if (!Array.isArray(rows)) rows = [];

    var groupsByCode = {};

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var code = r.last_agent_error_code || 'unknown';
      var practiceName = (r.contacts && r.contacts.practice_name) || null;

      if (!groupsByCode[code]) {
        groupsByCode[code] = {
          code: code,
          label: CODE_LABELS[code] || code,
          count: 0,
          oldest: null,
          audits: []
        };
      }

      var group = groupsByCode[code];
      group.count++;

      if (r.last_agent_error_at) {
        if (!group.oldest || r.last_agent_error_at < group.oldest) {
          group.oldest = r.last_agent_error_at;
        }
      }

      group.audits.push({
        id: r.id,
        client_slug: r.client_slug,
        practice_name: practiceName,
        last_agent_error_at: r.last_agent_error_at || null,
        last_agent_error: r.last_agent_error || null,
        last_debug_path: r.last_debug_path || null
      });
    }

    // Sort groups: highest count first, then oldest ascending so the
    // banner surfaces the worst + most stale issue at the top.
    var groups = Object.keys(groupsByCode).map(function(k) { return groupsByCode[k]; });
    groups.sort(function(a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (!a.oldest) return 1;
      if (!b.oldest) return -1;
      if (a.oldest < b.oldest) return -1;
      if (a.oldest > b.oldest) return 1;
      return 0;
    });

    return res.status(200).json({
      total_blocked: rows.length,
      groups: groups
    });
  } catch (err) {
    console.error('[admin/audit-blocks] error:', err.message);
    return res.status(500).json({ error: 'Failed to load audit blocks' });
  }
};
