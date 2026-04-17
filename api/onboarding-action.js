// /api/onboarding-action.js
// Client-facing action route for onboarding pages.
// No admin JWT required — uses service role key for writes.
//
// Security model (post-Phase-4-session-2):
//   1. Every request MUST carry a page_token that verifies under scope='onboarding'.
//   2. The token's contact_id is the sole source of truth for which rows may be
//      touched. Any contact_id in filters or data from the request body is
//      overridden with the verified value — a prospect cannot modify another
//      prospect's data by swapping the UUID in their request body.
//   3. The contact's status must still be 'onboarding' (defense-in-depth; also
//      gives a clean rejection for clients who completed onboarding and try to
//      reuse their page).

var sb = require('./_lib/supabase');
var pageToken = require('./_lib/page-token');
var pgFilter = require('./_lib/postgrest-filter');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

  try {
    var body = req.body || {};
    var action = body.action;
    var table = body.table;
    var filters = body.filters;
    var data = body.data;
    var submittedToken = body.page_token;

    if (!action || !table) return res.status(400).json({ error: 'action and table required' });

    // ── 1. Verify page token ────────────────────────────────────
    if (!submittedToken) {
      return res.status(403).json({ error: 'Page token required' });
    }
    var tokenData;
    try {
      tokenData = pageToken.verify(submittedToken, 'onboarding');
    } catch (e) {
      // Thrown only when PAGE_TOKEN_SECRET is not configured — surface as 500
      // so it's visible in logs, not as an auth error the client could mistake
      // for a token problem.
      console.error('[onboarding-action] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) {
      return res.status(403).json({ error: 'Invalid or expired page token' });
    }
    var verifiedContactId = tokenData.contact_id;

    // ── 2. Enforce action/table allowlists ──────────────────────
    var allowedTables = ['practice_details', 'bio_materials', 'social_platforms', 'directory_listings'];
    if (allowedTables.indexOf(table) === -1) return res.status(400).json({ error: 'Table not allowed' });

    var allowedActions = ['create_record', 'update_record', 'delete_record'];
    if (allowedActions.indexOf(action) === -1) return res.status(400).json({ error: 'Action not allowed' });

    // ── 3. Defense-in-depth: contact must still be in onboarding ─
    var contactCheck = await sb.query('contacts?select=id,status&id=eq.' + encodeURIComponent(verifiedContactId) + '&limit=1');
    if (!contactCheck || contactCheck.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    if (contactCheck[0].status !== 'onboarding') {
      return res.status(403).json({ error: 'Contact is not in onboarding' });
    }

    // ── 4. Override contact_id with verified value ──────────────
    // Never trust contact_id from the request body. On updates/deletes we
    // force a WHERE contact_id=verified clause; on creates we force the row's
    // contact_id column. If the client's row lookup (id=X) points to another
    // contact's data, the extra contact_id filter ensures 0 rows are touched.
    if (action === 'create_record') {
      data = data || {};
      data.contact_id = verifiedContactId;
    } else {
      // update_record or delete_record
      filters = filters || {};
      filters.contact_id = verifiedContactId;
    }

    var baseUrl = sb.url() + '/rest/v1/' + table;
    var headers = sb.headers('return=representation');

    if (action === 'create_record') {
      var r = await fetch(baseUrl, { method: 'POST', headers: headers, body: JSON.stringify(data) });
      var result = await r.json();
      if (!r.ok) { console.error('onboarding create error:', JSON.stringify(result)); return res.status(r.status).json({ error: 'Database write failed' }); }
      return res.status(201).json({ success: true, action: 'created', data: result });
    }

    if (action === 'update_record') {
      if (!data) return res.status(400).json({ error: 'data required' });
      var fp;
      try { fp = pgFilter.buildFilter(filters); }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }
      var r2 = await fetch(baseUrl + '?' + fp, { method: 'PATCH', headers: headers, body: JSON.stringify(data) });
      var result2 = await r2.json();
      if (!r2.ok) { console.error('onboarding update error:', JSON.stringify(result2)); return res.status(r2.status).json({ error: 'Database update failed' }); }
      return res.status(200).json({ success: true, action: 'updated', data: result2 });
    }

    if (action === 'delete_record') {
      var fp2;
      try { fp2 = pgFilter.buildFilter(filters); }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }
      var r3 = await fetch(baseUrl + '?' + fp2, { method: 'DELETE', headers: headers });
      if (!r3.ok) return res.status(r3.status).json({ error: 'Database error' });
      return res.status(200).json({ success: true, action: 'deleted' });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Onboarding action error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
