// api/_lib/gsc.js
// Google Search Console helpers — analogous to _lib/gbp.js. Two callers:
//   1. compile-report  — totals + top pages/queries for the report month.
//   2. backfill-gsc-warehouse — per-day rows for the warehouse.
//
// API: https://www.googleapis.com/webmasters/v3/sites/{property}/searchAnalytics/query
// Hard cap: ~16 months sliding window from today. Missed days fall off the
// edge permanently, hence the warehouse + nightly cron.

var google = require('./google');
var fetchT = require('./fetchT');

var GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
var DEFAULT_MAILBOX = 'support@moonraker.ai';
var BASE = 'https://www.googleapis.com/webmasters/v3/sites/';

function buildUrl(property) {
  return BASE + encodeURIComponent(property) + '/searchAnalytics/query';
}

// Per-day rows: dimensions=['date'], rowLimit high enough to cover the full
// window. GSC's max rowLimit is 25000 per page; 18 months of dates is ~550
// rows, so a single page is sufficient.
async function fetchAnalyticsDaily(property, startDate, endDate, opts) {
  opts = opts || {};
  var mailbox = opts.mailbox || DEFAULT_MAILBOX;
  var timeoutMs = opts.timeout_ms || 30000;

  if (!property) {
    return { available: false, error: 'No gsc_property configured' };
  }

  var token;
  try {
    token = await google.getDelegatedAccessToken(mailbox, GSC_SCOPE);
  } catch (e) {
    return { available: false, error: 'Delegated token failed: ' + (e.message || String(e)) };
  }

  var url = buildUrl(property);
  var resp;
  try {
    resp = await fetchT(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: startDate,
        endDate: endDate,
        dimensions: ['date'],
        rowLimit: 25000
      })
    }, timeoutMs);
  } catch (ne) {
    return { available: false, error: 'Network error: ' + (ne.message || String(ne)) };
  }

  var text = await resp.text();
  var data = null;
  try { data = JSON.parse(text); } catch (e2) {}

  if (!resp.ok) {
    var msg = (data && data.error && data.error.message) || text.slice(0, 300);
    return { available: false, http_status: resp.status, error: msg };
  }

  return { available: true, days: parseDaily(data) };
}

// Convert API response into flat per-date rows. CTR is fractional (0–1) and
// stored as a numeric so we don't lose precision; UI/reporting layers can
// multiply by 100 for percentage display. Missing days are not emitted.
function parseDaily(data) {
  var rows = (data && data.rows) || [];
  return rows
    .filter(function(r) { return r.keys && r.keys[0]; })
    .map(function(r) {
      return {
        date:        r.keys[0],
        clicks:      Math.round(r.clicks || 0),
        impressions: Math.round(r.impressions || 0),
        ctr:         Math.round((r.ctr || 0) * 10000) / 10000,
        position:    Math.round((r.position || 0) * 100) / 100
      };
    })
    .sort(function(a, b) { return a.date < b.date ? -1 : 1; });
}

module.exports = {
  fetchAnalyticsDaily: fetchAnalyticsDaily,
  parseDaily: parseDaily
};
