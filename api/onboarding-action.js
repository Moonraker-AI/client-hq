// /api/onboarding-action.js
// Client-facing action route for onboarding pages.
// Validates that contact_id belongs to a contact in onboarding status.
// No admin JWT required — uses service role key for writes.

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

  try {
    var body = req.body;
    var action = body.action;
    var table = body.table;
    var filters = body.filters;
    var data = body.data;

    if (!action || !table) return res.status(400).json({ error: 'action and table required' });

    // Only allow tables needed during onboarding
    var allowed = ['practice_details', 'bio_materials', 'social_platforms', 'directory_listings'];
    if (allowed.indexOf(table) === -1) return res.status(400).json({ error: 'Table not allowed' });

    // Only allow safe actions
    var allowedActions = ['create_record', 'update_record', 'delete_record'];
    if (allowedActions.indexOf(action) === -1) return res.status(400).json({ error: 'Action not allowed' });

    // Extract contact_id from data or filters
    var contactId = (data && data.contact_id) || (filters && filters.contact_id);
    if (!contactId) return res.status(400).json({ error: 'contact_id required' });
    // Strip PostgREST operator prefix if present (e.g. "eq.abc" → "abc")
    var cleanContactId = String(contactId).replace(/^eq\./, '');

    // Verify this contact exists and is in onboarding status
    var contactCheck = await sb.query('contacts?select=id,status&id=eq.' + encodeURIComponent(cleanContactId) + '&limit=1');
    if (!contactCheck || contactCheck.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    if (contactCheck[0].status !== 'onboarding') {
      return res.status(403).json({ error: 'Contact is not in onboarding' });
    }

    var baseUrl = sb.url() + '/rest/v1/' + table;
    var headers = sb.headers('return=representation');

    if (action === 'create_record') {
      if (!data) return res.status(400).json({ error: 'data required' });
      var r = await fetch(baseUrl, { method: 'POST', headers: headers, body: JSON.stringify(data) });
      var result = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'Database error', detail: result });
      return res.status(201).json({ success: true, action: 'created', data: result });
    }

    if (action === 'update_record') {
      if (!filters || !data) return res.status(400).json({ error: 'filters and data required' });
      var fp = buildFilter(filters);
      var r2 = await fetch(baseUrl + '?' + fp, { method: 'PATCH', headers: headers, body: JSON.stringify(data) });
      var result2 = await r2.json();
      if (!r2.ok) return res.status(r2.status).json({ error: 'Database error', detail: result2 });
      return res.status(200).json({ success: true, action: 'updated', data: result2 });
    }

    if (action === 'delete_record') {
      if (!filters) return res.status(400).json({ error: 'filters required for delete' });
      // For delete, we need contact_id from the filters or from data
      var fp2 = buildFilter(filters);
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

function buildFilter(filters) {
  var parts = [];
  for (var key in filters) {
    var val = filters[key];
    if (typeof val === 'string' && /^(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\./i.test(val)) {
      parts.push(key + '=' + val);
    } else {
      parts.push(key + '=eq.' + encodeURIComponent(val));
    }
  }
  return parts.join('&');
}
