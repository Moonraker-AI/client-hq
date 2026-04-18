// api/_lib/google-sheets.js
// Thin wrapper around the Google Sheets API v4 using our service-account
// token (no impersonation). Clients grant access by sharing their sheet with
// reporting@moonraker-client-hq.iam.gserviceaccount.com as Viewer.
//
// Used by the attribution-sync pipeline to read client lead-tracker sheets
// once a month and roll them up into client_attribution_periods +
// client_attribution_sources.

var google = require('./google-delegated');
var fetchT = require('./fetch-with-timeout');

var SHEETS_SCOPE  = 'https://www.googleapis.com/auth/spreadsheets.readonly';
var DRIVE_SCOPE   = 'https://www.googleapis.com/auth/drive.readonly';

// Extract a sheet ID from any of the common URL shapes users paste.
//   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=...
//   https://docs.google.com/spreadsheets/d/<ID>
//   <ID>  (bare)
function extractSheetId(urlOrId) {
  if (!urlOrId) return null;
  var s = String(urlOrId).trim();
  var m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

// Fetch sheet metadata: title, tabs, and their gid + title.
// Throws with structured { status, message } if Google returns an error.
async function fetchSheetMetadata(sheetId) {
  var token = await google.getServiceAccountToken(SHEETS_SCOPE);
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/'
    + encodeURIComponent(sheetId)
    + '?fields=properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))';

  var r = await fetchT(url, {
    headers: { 'Authorization': 'Bearer ' + token }
  }, 15000);
  var body = await r.text();
  if (!r.ok) {
    throw buildError(r.status, body, 'Failed to read sheet metadata');
  }
  var json = JSON.parse(body);
  return {
    title: (json.properties && json.properties.title) || '',
    tabs: (json.sheets || []).map(function(s) {
      var p = s.properties || {};
      return {
        sheet_id: p.sheetId,
        title: p.title,
        index: p.index,
        row_count: (p.gridProperties && p.gridProperties.rowCount) || 0,
        column_count: (p.gridProperties && p.gridProperties.columnCount) || 0
      };
    })
  };
}

// Fetch cell values from a tab. Range uses A1 notation.
// If range is just a tab name (no !), returns the whole tab.
async function fetchSheetValues(sheetId, range) {
  var token = await google.getServiceAccountToken(SHEETS_SCOPE);
  var url = 'https://sheets.googleapis.com/v4/spreadsheets/'
    + encodeURIComponent(sheetId)
    + '/values/' + encodeURIComponent(range)
    + '?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE'
    + '&dateTimeRenderOption=FORMATTED_STRING';

  var r = await fetchT(url, {
    headers: { 'Authorization': 'Bearer ' + token }
  }, 25000);
  var body = await r.text();
  if (!r.ok) {
    throw buildError(r.status, body, 'Failed to read sheet values');
  }
  var json = JSON.parse(body);
  return json.values || [];
}

// Translate a Google API error response into a friendly message the admin
// can act on. We care especially about the "not shared" case.
function buildError(status, body, fallback) {
  var parsed = null;
  try { parsed = JSON.parse(body); } catch (e) {}
  var msg = fallback;
  var reason = null;
  if (parsed && parsed.error) {
    msg = parsed.error.message || msg;
    reason = parsed.error.status;
  }
  if (status === 404) {
    msg = 'Sheet not found. Double-check the URL, or confirm the sheet exists and has not been deleted.';
  } else if (status === 403) {
    msg = 'Access denied. Share this sheet with reporting@moonraker-client-hq.iam.gserviceaccount.com (Viewer) and try again.';
  } else if (status === 400) {
    // e.g. "Unable to parse range: SomeTab!A:Z"
    msg = 'Google Sheets rejected the request: ' + msg;
  }
  var err = new Error(msg);
  err.status = status;
  err.googleReason = reason;
  err.raw = body && body.slice(0, 500);
  return err;
}

module.exports = {
  SHEETS_SCOPE: SHEETS_SCOPE,
  DRIVE_SCOPE: DRIVE_SCOPE,
  extractSheetId: extractSheetId,
  fetchSheetMetadata: fetchSheetMetadata,
  fetchSheetValues: fetchSheetValues
};
