// /api/action.js - Execute confirmed AI actions against Supabase

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  try {
    var body = req.body;
    var action = body.action;
    var table = body.table;
    var filters = body.filters;
    var data = body.data;

    if (!action || !table) {
      return res.status(400).json({ error: 'action and table required' });
    }

    var allowed = ['contacts','practice_details','onboarding_steps','deliverables','checklist_items','audit_scores','report_snapshots','report_highlights','report_configs','bio_materials','social_profiles','signed_agreements','activity_log','settings','entity_audits','account_access','payments','scheduled_touchpoints'];
    if (allowed.indexOf(table) === -1) {
      return res.status(400).json({ error: 'Table not allowed: ' + table });
    }

    var baseUrl = supabaseUrl + '/rest/v1/' + table;
    var headers = {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    if (action === 'read_records') {
      var select = body.select || '*';
      var fp0 = filters ? buildFilter(filters) : '';
      var url0 = baseUrl + '?select=' + encodeURIComponent(select) + (fp0 ? '&' + fp0 : '') + '&limit=' + (body.limit || 50);
      var r0 = await fetch(url0, { method: 'GET', headers: headers });
      var result0 = await r0.json();
      if (!r0.ok) return res.status(r0.status).json({ error: 'Supabase error', detail: result0 });
      return res.status(200).json({ success: true, action: 'read', data: result0, count: Array.isArray(result0) ? result0.length : 0 });
    }

    if (action === 'create_record') {
      if (!data) return res.status(400).json({ error: 'data required' });
      var r = await fetch(baseUrl, { method: 'POST', headers: headers, body: JSON.stringify(data) });
      var result = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'Supabase error', detail: result });
      return res.status(201).json({ success: true, action: 'created', data: result });
    }

    if (action === 'update_record' || action === 'bulk_update') {
      if (!filters || !data) return res.status(400).json({ error: 'filters and data required' });
      var fp = buildFilter(filters);
      var r2 = await fetch(baseUrl + '?' + fp, { method: 'PATCH', headers: headers, body: JSON.stringify(data) });
      var result2 = await r2.json();
      if (!r2.ok) return res.status(r2.status).json({ error: 'Supabase error', detail: result2 });
      return res.status(200).json({ success: true, action: action === 'bulk_update' ? 'bulk_updated' : 'updated', count: Array.isArray(result2) ? result2.length : 1, data: result2 });
    }

    if (action === 'delete_record') {
      if (!filters) return res.status(400).json({ error: 'filters required for delete' });
      var fp2 = buildFilter(filters);
      var r3 = await fetch(baseUrl + '?' + fp2, { method: 'DELETE', headers: headers });
      if (!r3.ok) return res.status(r3.status).json({ error: 'Supabase error' });
      return res.status(200).json({ success: true, action: 'deleted' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('Action error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
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

