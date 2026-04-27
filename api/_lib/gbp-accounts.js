// api/_lib/gbp-accounts.js
// Resolves Google Places Place IDs to GBP location resource IDs that our
// service account can actually manage. Used to bridge the search UI (which
// returns Places candidates) and the GBP Performance API (which needs the
// numeric location ID we store on report_configs.gbp_location_id).
//
// API surfaces used:
//   1. mybusinessaccountmanagement.googleapis.com/v1/accounts
//   2. mybusinessbusinessinformation.googleapis.com/v1/{account}/locations
//      with read_mask=name,metadata.placeId (cheap; metadata.placeId is the
//      cross-reference we need).
//
// Quotas: Account Management is generous (high QPS). Business Information
// list is per-account; we paginate up to a hard cap.

var google = require('./google-delegated');
var fetchT = require('./fetch-with-timeout');

var SCOPE = 'https://www.googleapis.com/auth/business.manage';
var DEFAULT_MAILBOX = 'support@moonraker.ai';
var ACCOUNT_LIST_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
var LOCATIONS_URL = function(accountName) {
  return 'https://mybusinessbusinessinformation.googleapis.com/v1/' + accountName +
    '/locations?readMask=name,title,metadata.placeId,storefrontAddress&pageSize=100';
};

// Module-level cache to avoid re-listing accounts/locations within a single
// hot Lambda. TTL is short (10 min) because accounts change rarely but
// locations can be added/removed mid-day.
var cache = { byPlaceId: null, builtAt: 0, ttlMs: 10 * 60 * 1000 };

async function getToken(opts) {
  return await google.getDelegatedAccessToken((opts && opts.mailbox) || DEFAULT_MAILBOX, SCOPE);
}

async function listAccounts(opts) {
  var token = await getToken(opts);
  var resp = await fetchT(ACCOUNT_LIST_URL + '?pageSize=50', {
    headers: { 'Authorization': 'Bearer ' + token }
  }, 12000);
  var text = await resp.text();
  var data = null; try { data = JSON.parse(text); } catch (e) {}
  if (!resp.ok) {
    var msg = (data && data.error && data.error.message) || text.slice(0, 300);
    throw new Error('listAccounts failed: ' + msg);
  }
  return (data && data.accounts) || [];
}

async function listLocationsForAccount(accountName, opts) {
  var token = await getToken(opts);
  var url = LOCATIONS_URL(accountName);
  var collected = [];
  var pageToken = null;
  var maxPages = 20; // ~2000 locations cap per account; defensive
  for (var page = 0; page < maxPages; page++) {
    var pagedUrl = pageToken ? url + '&pageToken=' + encodeURIComponent(pageToken) : url;
    var resp = await fetchT(pagedUrl, { headers: { 'Authorization': 'Bearer ' + token } }, 15000);
    var text = await resp.text();
    var data = null; try { data = JSON.parse(text); } catch (e) {}
    if (!resp.ok) {
      var msg = (data && data.error && data.error.message) || text.slice(0, 300);
      throw new Error('listLocations(' + accountName + ') failed: ' + msg);
    }
    var batch = (data && data.locations) || [];
    collected = collected.concat(batch);
    pageToken = data && data.nextPageToken;
    if (!pageToken) break;
  }
  return collected;
}

// Build a map of placeId -> { locationId, displayName, address, accountName }
// for every location reachable by our SA. Cached for ttlMs.
async function buildPlaceIdIndex(opts) {
  opts = opts || {};
  var now = Date.now();
  if (!opts.force && cache.byPlaceId && (now - cache.builtAt) < cache.ttlMs) {
    return cache.byPlaceId;
  }

  var accounts = await listAccounts(opts);
  var index = {};

  for (var i = 0; i < accounts.length; i++) {
    var acct = accounts[i];
    var locations;
    try {
      locations = await listLocationsForAccount(acct.name, opts);
    } catch (e) {
      // Some accounts return PERMISSION_DENIED for the SA — that's normal
      // for unmanaged accounts. Skip and continue.
      continue;
    }
    locations.forEach(function(loc) {
      var pid = loc.metadata && loc.metadata.placeId;
      if (!pid) return;
      var locId = (loc.name || '').replace(/^locations\//, '');
      if (!locId) return;
      // Last write wins if a Place ID appears under multiple accounts —
      // unlikely in practice but defensive.
      index[pid] = {
        location_id: locId,
        display_name: loc.title || '',
        address: formatAddress(loc.storefrontAddress),
        account_name: acct.name
      };
    });
  }

  cache.byPlaceId = index;
  cache.builtAt = now;
  return index;
}

function formatAddress(addr) {
  if (!addr) return '';
  var parts = [];
  if (Array.isArray(addr.addressLines)) parts = parts.concat(addr.addressLines);
  if (addr.locality) parts.push(addr.locality);
  if (addr.administrativeArea) parts.push(addr.administrativeArea);
  if (addr.postalCode) parts.push(addr.postalCode);
  return parts.join(', ');
}

async function resolvePlaceIdToLocation(placeId, opts) {
  if (!placeId) return null;
  var index = await buildPlaceIdIndex(opts);
  return index[placeId] || null;
}

module.exports = {
  listAccounts: listAccounts,
  listLocationsForAccount: listLocationsForAccount,
  buildPlaceIdIndex: buildPlaceIdIndex,
  resolvePlaceIdToLocation: resolvePlaceIdToLocation,
  // For tests/probes:
  _resetCache: function() { cache.byPlaceId = null; cache.builtAt = 0; }
};
