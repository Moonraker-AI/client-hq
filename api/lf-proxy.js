// api/lf-proxy.js — LocalFalcon location search & add proxy
// Used by Campaign Readiness orchestration in client deep-dive
//
// POST { action: 'search', name: 'Sky Therapies', city: 'Toronto', state: 'ON' }
//   → Search LF for matching GBP listings (returns candidates with place_id)
//
// POST { action: 'add', place_id: 'ChIJ...' }
//   → Add a GBP location to LF account (returns LF place_id)
//
// POST { action: 'saved', query: 'Sky Therapies' }
//   → Check already-saved LF locations (LF hides saved from search)
//
// ENV: LOCALFALCON_API_KEY

var auth = require('./_lib/auth');
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;


  var lfKey = process.env.LOCALFALCON_API_KEY;
  if (!lfKey) return res.status(500).json({ error: 'LOCALFALCON_API_KEY not configured' });

  var action = req.body && req.body.action;
  if (!action) return res.status(400).json({ error: 'action required (search, add, saved)' });

  res.setHeader('Content-Type', 'application/json');

  try {
    // ─── SEARCH: Find GBP listings by name + proximity ─────────
    if (action === 'search') {
      var name = req.body.name;
      if (!name) return res.status(400).json({ error: 'name required for search' });

      var city = req.body.city || '';
      var state = req.body.state || '';
      var proximity = [city, state].filter(Boolean).join(', ');

      var body = 'api_key=' + encodeURIComponent(lfKey)
        + '&name=' + encodeURIComponent(name)
        + (proximity ? '&proximity=' + encodeURIComponent(proximity) : '');

      var searchResp = await fetch('https://api.localfalcon.com/v2/locations/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
      });
      var searchData = await searchResp.json();

      if (!searchResp.ok || !searchData.success) {
        return res.status(502).json({
          error: 'LF search failed',
          detail: searchData.message || searchData.error || JSON.stringify(searchData)
        });
      }

      var results = (searchData.data && searchData.data.results) || [];
      return res.status(200).json({
        success: true,
        action: 'search',
        count: results.length,
        results: results.map(function(r) {
          return {
            place_id: r.place_id,
            name: r.name,
            address: r.address || r.formatted_address,
            category: r.category || r.type,
            lat: r.lat || r.latitude,
            lng: r.lng || r.longitude
          };
        })
      });
    }

    // ─── ADD: Add a location to LF by GBP place_id ─────────────
    if (action === 'add') {
      var placeId = req.body.place_id;
      if (!placeId) return res.status(400).json({ error: 'place_id required for add' });

      var addBody = 'api_key=' + encodeURIComponent(lfKey)
        + '&platform=google'
        + '&place_id=' + encodeURIComponent(placeId);

      var addResp = await fetch('https://api.localfalcon.com/v2/locations/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: addBody
      });
      var addData = await addResp.json();

      if (!addResp.ok || !addData.success) {
        // Check if it's "already added" — LF returns an error for duplicates
        var msg = (addData.message || '').toLowerCase();
        if (msg.indexOf('already') >= 0 || msg.indexOf('exists') >= 0) {
          return res.status(200).json({
            success: true,
            action: 'add',
            already_saved: true,
            place_id: placeId,
            message: addData.message
          });
        }
        return res.status(502).json({
          error: 'LF add failed',
          detail: addData.message || addData.error || JSON.stringify(addData)
        });
      }

      return res.status(200).json({
        success: true,
        action: 'add',
        place_id: placeId,
        data: addData.data || null
      });
    }

    // ─── SAVED: Check already-saved locations ──────────────────
    if (action === 'saved') {
      var query = req.body.query || '';

      var savedBody = 'api_key=' + encodeURIComponent(lfKey)
        + (query ? '&query=' + encodeURIComponent(query) : '')
        + '&limit=20';

      var savedResp = await fetch('https://api.localfalcon.com/v1/locations/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: savedBody
      });
      var savedData = await savedResp.json();

      var locations = (savedData.data && savedData.data.locations) || [];
      return res.status(200).json({
        success: true,
        action: 'saved',
        count: locations.length,
        locations: locations.map(function(l) {
          return {
            place_id: l.place_id,
            name: l.name,
            address: l.address || l.formatted_address,
            category: l.category,
            lat: l.lat,
            lng: l.lng
          };
        })
      });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action + '. Use search, add, or saved.' });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
};
