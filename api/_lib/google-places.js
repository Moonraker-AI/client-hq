// api/_lib/google-places.js
// Thin wrapper around Google Places API Text Search. Used by /api/admin/search-gbp
// to find candidate listings before resolving them to GBP location resource IDs.
//
// Why Places (not LocalFalcon): Places returns Google's own canonical record
// for a business, including the Place ID we need to cross-reference against
// the GBP location set our service account can manage. LocalFalcon is a
// rank-tracking provider; their search returns a different (often outdated)
// index and gives us no path to a verifiable GBP record.
//
// Auth: GOOGLE_API_KEY (server-side only, never returned to clients).
// API: places.googleapis.com (the New API). Cheaper than the old "v1
// textsearch" because we only request the basic SKU fields.

var fetchT = require('./fetch-with-timeout');

var ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

// Field mask kept tight — name/address/placeId are all we need; pulling
// reviews/photos/hours would push us into Atmosphere SKU pricing.
var FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.types,places.location';

async function searchText(query, opts) {
  opts = opts || {};
  var apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return { available: false, error: 'GOOGLE_API_KEY not configured' };
  }

  var resp;
  try {
    resp = await fetchT(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK
      },
      body: JSON.stringify({
        textQuery: query,
        // Restrict to business listings; Places returns plenty of generic
        // points of interest that aren't relevant for our use case.
        includedType: opts.includedType || undefined,
        maxResultCount: opts.maxResults || 10,
        // Region biasing helps when names are ambiguous across countries.
        // Default US since 100% of clients are US-based today.
        regionCode: opts.regionCode || 'US'
      })
    }, opts.timeoutMs || 12000);
  } catch (e) {
    return { available: false, error: 'Network error: ' + (e.message || String(e)) };
  }

  var text = await resp.text();
  var data = null;
  try { data = JSON.parse(text); } catch (e2) {}

  if (!resp.ok) {
    var msg = (data && data.error && data.error.message) || text.slice(0, 300);
    return { available: false, http_status: resp.status, error: msg };
  }

  var places = (data && data.places) || [];
  return {
    available: true,
    results: places.map(function(p) {
      return {
        place_id: p.id,
        name: (p.displayName && p.displayName.text) || '',
        address: p.formattedAddress || '',
        types: p.types || [],
        latitude: p.location && p.location.latitude,
        longitude: p.location && p.location.longitude
      };
    })
  };
}

module.exports = {
  searchText: searchText
};
