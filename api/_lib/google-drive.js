// api/_lib/google-drive.js
// Direct Google Drive API access via service account + domain-wide delegation.
// Uses JWT → access token flow. Impersonates support@moonraker.ai.
//
// Usage:
//   var drive = require('./_lib/google-drive');
//   var files = await drive.listFiles(folderId);
//   var buffer = await drive.downloadFile(fileId);
//
// Requires GOOGLE_SERVICE_ACCOUNT_JSON env var (full JSON key).

var crypto = require('crypto');

var SCOPES = ['https://www.googleapis.com/auth/drive'];
var IMPERSONATE = 'support@moonraker.ai';
var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Cache token in memory (serverless function lifecycle)
var _cachedToken = null;
var _cachedExpiry = 0;

function getServiceAccount() {
  var json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) return null;
  try { return JSON.parse(json); } catch(e) { return null; }
}

function isConfigured() {
  return !!getServiceAccount();
}

// ── JWT Generation ──

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createJwt(sa) {
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var payload = {
    iss: sa.client_email,
    sub: IMPERSONATE,
    scope: SCOPES.join(' '),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };

  var segments = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));

  var sign = crypto.createSign('RSA-SHA256');
  sign.update(segments);
  var signature = sign.sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return segments + '.' + signature;
}

// ── Token Exchange ──

async function getAccessToken() {
  var now = Date.now();
  if (_cachedToken && _cachedExpiry > now + 60000) {
    return _cachedToken;
  }

  var sa = getServiceAccount();
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

  var jwt = createJwt(sa);
  var resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt
  });

  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Token exchange failed: ' + resp.status + ' ' + err.substring(0, 200));
  }

  var data = await resp.json();
  _cachedToken = data.access_token;
  _cachedExpiry = now + (data.expires_in || 3600) * 1000;
  return _cachedToken;
}

// ── Drive API Methods ──

async function driveRequest(path, opts) {
  var token = await getAccessToken();
  var url = path.startsWith('http') ? path : DRIVE_API + path;
  var resp = await fetch(url, Object.assign({
    headers: Object.assign({ 'Authorization': 'Bearer ' + token }, (opts && opts.headers) || {})
  }, opts || {}));
  return resp;
}

/**
 * List files in a folder.
 * @param {string} folderId - Google Drive folder ID
 * @param {object} [opts] - Optional: { mimeType, pageSize, orderBy }
 * @returns {Array} files
 */
async function listFiles(folderId, opts) {
  opts = opts || {};
  var q = "'" + folderId + "' in parents and trashed = false";
  if (opts.mimeType) q += " and mimeType = '" + opts.mimeType + "'";
  var params = 'q=' + encodeURIComponent(q) +
    '&fields=files(id,name,mimeType,size,thumbnailLink,webContentLink,description,modifiedTime)' +
    '&pageSize=' + (opts.pageSize || 100) +
    '&orderBy=' + (opts.orderBy || 'name');

  var resp = await driveRequest('/files?' + params);
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Drive list failed: ' + resp.status + ' ' + err.substring(0, 200));
  }
  var data = await resp.json();
  return data.files || [];
}

/**
 * Get file metadata.
 * @param {string} fileId
 * @returns {object} file metadata
 */
async function getFile(fileId) {
  var resp = await driveRequest('/files/' + fileId + '?fields=id,name,mimeType,size,thumbnailLink,webContentLink,description,modifiedTime');
  if (!resp.ok) throw new Error('Drive getFile failed: ' + resp.status);
  return await resp.json();
}

/**
 * Download file content as Buffer.
 * @param {string} fileId
 * @returns {Buffer} file data
 */
async function downloadFile(fileId) {
  var resp = await driveRequest('/files/' + fileId + '?alt=media');
  if (!resp.ok) throw new Error('Drive download failed: ' + resp.status);
  var arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Search files across accessible drives.
 * @param {string} query - search term (name contains, etc.)
 * @param {object} [opts] - Optional: { mimeType, folderId, pageSize }
 * @returns {Array} files
 */
async function searchFiles(query, opts) {
  opts = opts || {};
  var q = "name contains '" + query.replace(/'/g, "\\'") + "' and trashed = false";
  if (opts.folderId) q += " and '" + opts.folderId + "' in parents";
  if (opts.mimeType) q += " and mimeType = '" + opts.mimeType + "'";
  var params = 'q=' + encodeURIComponent(q) +
    '&fields=files(id,name,mimeType,size,thumbnailLink,description)' +
    '&pageSize=' + (opts.pageSize || 20);

  var resp = await driveRequest('/files?' + params);
  if (!resp.ok) throw new Error('Drive search failed: ' + resp.status);
  var data = await resp.json();
  return data.files || [];
}

module.exports = {
  isConfigured: isConfigured,
  getAccessToken: getAccessToken,
  listFiles: listFiles,
  getFile: getFile,
  downloadFile: downloadFile,
  searchFiles: searchFiles
};
