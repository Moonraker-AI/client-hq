// api/_lib/gbp.js
// Shared Google Business Profile Performance API helper.
//
// Used by: api/compile-report.js (monthly snapshots)
//          api/campaign-summary.js (full-engagement rollups)
//          api/probe-gbp.js       (ops probe — has its own inline copy for debugging)
//
// Handles both response shapes we've observed from Google:
//   (A) Flat:   multiDailyMetricTimeSeries[i] = { dailyMetric, timeSeries }
//   (B) Nested: multiDailyMetricTimeSeries[i] = { dailyMetricTimeSeries: [...] }
// The live API currently returns shape (B). Shape (A) is documented in Google's
// reference docs. Parsing both makes us robust to shape drift.

var google = require('./google-delegated');
var fetchT = require('./fetch-with-timeout');

var GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
var DEFAULT_MAILBOX = 'support@moonraker.ai';

var METRICS = [
  'CALL_CLICKS',
  'WEBSITE_CLICKS',
  'BUSINESS_DIRECTION_REQUESTS',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
];

function buildUrl(locationId, startDate, endDate) {
  var s = new Date(startDate + 'T00:00:00Z');
  var e = new Date(endDate + 'T00:00:00Z');
  var q = METRICS.map(function(m) { return 'dailyMetrics=' + m; }).join('&');
  return 'https://businessprofileperformance.googleapis.com/v1/locations/' + locationId
    + ':fetchMultiDailyMetricsTimeSeries?' + q
    + '&dailyRange.startDate.year='  + s.getUTCFullYear()
    + '&dailyRange.startDate.month=' + (s.getUTCMonth() + 1)
    + '&dailyRange.startDate.day='   + s.getUTCDate()
    + '&dailyRange.endDate.year='    + e.getUTCFullYear()
    + '&dailyRange.endDate.month='   + (e.getUTCMonth() + 1)
    + '&dailyRange.endDate.day='     + e.getUTCDate();
}

function sumDatedValues(ts) {
  var pts = (ts && ts.datedValues) || [];
  var t = 0;
  for (var i = 0; i < pts.length; i++) t += parseInt(pts[i].value || 0, 10);
  return t;
}

// Walk the response and total one metric, handling both shapes.
function sumMetric(series, metricName) {
  var total = 0;
  for (var i = 0; i < series.length; i++) {
    var entry = series[i] || {};
    if (entry.dailyMetric === metricName) {
      total += sumDatedValues(entry.timeSeries);
      continue;
    }
    var inner = entry.dailyMetricTimeSeries;
    if (Array.isArray(inner)) {
      for (var j = 0; j < inner.length; j++) {
        if (inner[j] && inner[j].dailyMetric === metricName) {
          total += sumDatedValues(inner[j].timeSeries);
        }
      }
    }
  }
  return total;
}

function parseMetrics(data) {
  var series = (data && data.multiDailyMetricTimeSeries) || [];
  var imp = {
    desktop_maps:   sumMetric(series, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS'),
    desktop_search: sumMetric(series, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'),
    mobile_maps:    sumMetric(series, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'),
    mobile_search:  sumMetric(series, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH')
  };
  return {
    calls:              sumMetric(series, 'CALL_CLICKS'),
    website_clicks:     sumMetric(series, 'WEBSITE_CLICKS'),
    direction_requests: sumMetric(series, 'BUSINESS_DIRECTION_REQUESTS'),
    impressions_total:  imp.desktop_maps + imp.desktop_search + imp.mobile_maps + imp.mobile_search,
    impressions_breakdown: imp
  };
}

// Main entry point. Returns { available: true, ...metrics } on success,
// { available: false, error } otherwise. Never throws — callers can treat
// a missing result as "no data" rather than writing error-handling boilerplate.
async function fetchPerformance(locationId, startDate, endDate, opts) {
  opts = opts || {};
  var mailbox = opts.mailbox || DEFAULT_MAILBOX;
  var timeoutMs = opts.timeout_ms || 15000;

  if (!locationId) {
    return { available: false, error: 'No gbp_location_id configured' };
  }

  var token;
  try {
    token = await google.getDelegatedAccessToken(mailbox, GBP_SCOPE);
  } catch (e) {
    return { available: false, error: 'Delegated token failed: ' + (e.message || String(e)) };
  }

  var url = buildUrl(locationId, startDate, endDate);
  var resp;
  try {
    resp = await fetchT(url, { headers: { 'Authorization': 'Bearer ' + token } }, timeoutMs);
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

  var parsed = parseMetrics(data);
  return Object.assign({ available: true }, parsed);
}

module.exports = {
  fetchPerformance: fetchPerformance,
  // Exposed for probe-gbp.js / tests
  parseMetrics: parseMetrics,
  buildUrl: buildUrl,
  GBP_SCOPE: GBP_SCOPE,
  DEFAULT_MAILBOX: DEFAULT_MAILBOX
};
