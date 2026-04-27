// api/admin/search-gbp.js
// Search Google Places for a candidate listing AND tag each result with
// whether our service account can manage that GBP location. The Reports
// tab "Search" button calls this, then the operator picks one and we
// save the GBP location ID directly to report_configs.gbp_location_id.
//
// Why two-stage: Places gives us authoritative business listings (name,
// address, place_id). The GBP Performance API needs a *location* resource
// ID (numeric, e.g. 12446916804880561539) which is account-scoped — only
// listings the SA has been granted access to are usable. We cross-reference
// here so the UI can mark "manageable" candidates clearly.
//
// POST body: { practice_name, city?, state?, country? }
// Returns:   { results: [{ place_id, name, address, location_id|null,
//                          manageable: bool, account_name|null }] }
//
// Auth: admin only.

var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var places = require('../_lib/google-places');
var gbpAccounts = require('../_lib/gbp-accounts');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var name = (body.practice_name || '').trim();
  if (!name) return res.status(400).json({ error: 'practice_name required' });

  var locality = [body.city, body.state || body.province].filter(Boolean).join(', ');
  var query = locality ? (name + ' ' + locality) : name;

  try {
    // 1. Hit Places.
    var search = await places.searchText(query, { maxResults: 10 });
    if (!search.available) {
      return res.status(502).json({
        error: 'Places search failed',
        detail: search.error,
        http_status: search.http_status
      });
    }
    if (search.results.length === 0) {
      return res.status(200).json({ query: query, results: [] });
    }

    // 2. Build the SA-managed Place ID index in parallel with Places call
    //    on warm Lambdas (cache hits in <5ms). Cold starts may add a few
    //    seconds for the index build but it's worth it for the access flag.
    var placeIdIndex = {};
    var indexError = null;
    try {
      placeIdIndex = await gbpAccounts.buildPlaceIdIndex();
    } catch (e) {
      // Don't fail the search; just return without manageability data.
      indexError = e.message || String(e);
      monitor.logError('admin/search-gbp', e, { detail: { stage: 'place_id_index' } });
    }

    var enriched = search.results.map(function(r) {
      var match = placeIdIndex[r.place_id];
      return {
        place_id: r.place_id,
        name: r.name,
        address: r.address,
        types: r.types,
        location_id: match ? match.location_id : null,
        manageable: !!match,
        account_name: match ? match.account_name : null
      };
    });

    // Sort manageable ones first.
    enriched.sort(function(a, b) {
      if (a.manageable !== b.manageable) return a.manageable ? -1 : 1;
      return 0;
    });

    return res.status(200).json({
      query: query,
      results: enriched,
      index_error: indexError,
      manageable_count: enriched.filter(function(r) { return r.manageable; }).length
    });
  } catch (e) {
    monitor.logError('admin/search-gbp', e, { detail: { name: name, locality: locality } });
    return res.status(500).json({ error: 'Search failed', detail: e.message || String(e) });
  }
};
