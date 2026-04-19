// api/_lib/page-token.js
// Stateless HMAC-signed tokens for client-facing pages.
// Issued at template-deploy time (baked into the HTML as window.__PAGE_TOKEN__).
// Verified on write endpoints to prove the bearer came from a legitimate link
// we generated, and to bind the request to a specific contact_id + scope.
//
// Token shape: 'scope.contactIdB64.exp.signatureB64'
//   - scope:           one of SCOPES (e.g. 'proposal', 'onboarding')
//   - contactIdB64:    base64url(utf8(contact_id))
//   - exp:             unix epoch seconds when the token expires
//   - signatureB64:    base64url(HMAC_SHA256('scope.contactIdB64.exp', secret))
//
// Requires PAGE_TOKEN_SECRET env var (32-byte hex string).
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Usage:
//   var pageToken = require('./_lib/page-token');
//   var token = pageToken.sign({ scope: 'proposal', contact_id: '...' });
//   var data  = pageToken.verify(token, 'proposal');  // -> { contact_id, exp, scope } or null
//
// Design reference: docs/phase-4-design.md, Decision 1 Option A.

var nodeCrypto = require('crypto');

var SCOPES = ['onboarding', 'proposal', 'content_preview', 'endorsement', 'report', 'campaign_summary', 'progress'];

// Default token lifetime per scope (in seconds). Callers can override via
// ttl_seconds in sign(). These are deliberately generous: pages are meant to
// outlive the active sales / onboarding window.
var DEFAULT_TTL = {
  onboarding:       90 * 86400,
  proposal:         60 * 86400,
  content_preview:  30 * 86400,
  endorsement:     180 * 86400,
  report:           30 * 86400,
  campaign_summary: 365 * 86400,
  // progress: checklist tracker used across the full active engagement +
  // any long-tail lead/prospect funnel. 365 days covers the longest live
  // campaign; expired tokens produce a 401 on write but the page still
  // renders (reads go through anon_read_visible which is web_visible-scoped).
  progress:         365 * 86400
};

// Loud warning at module load if the secret is missing. Surfaces config
// issues in Vercel logs even before the first sign/verify call.
if (!process.env.PAGE_TOKEN_SECRET) {
  console.error('[page-token] CRITICAL: PAGE_TOKEN_SECRET is not set. sign() and verify() will throw on any call. Set the env var immediately.');
}

function getSecret() {
  var hex = process.env.PAGE_TOKEN_SECRET;
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

// ── base64url helpers ─────────────────────────────────────────────

function b64urlEncode(input) {
  var buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ── sign ──────────────────────────────────────────────────────────

// Sign a new token. Throws on invalid input or missing secret — callers
// wrap in try/catch if they want to handle the "not configured" case
// differently from "validation error."
function sign(opts) {
  opts = opts || {};
  var scope = opts.scope;
  var contact_id = opts.contact_id;
  var ttl_seconds = opts.ttl_seconds;

  if (!scope || SCOPES.indexOf(scope) === -1) {
    throw new Error('Invalid scope: ' + scope);
  }
  if (!contact_id || typeof contact_id !== 'string') {
    throw new Error('contact_id required (string)');
  }
  if (ttl_seconds == null) ttl_seconds = DEFAULT_TTL[scope];
  if (!ttl_seconds || ttl_seconds <= 0) {
    throw new Error('ttl_seconds must be a positive integer');
  }

  var secret = getSecret();
  if (!secret) {
    throw new Error('PAGE_TOKEN_SECRET not configured — refusing to sign');
  }

  var exp = Math.floor(Date.now() / 1000) + ttl_seconds;
  var contactIdB64 = b64urlEncode(contact_id);
  var signingInput = scope + '.' + contactIdB64 + '.' + exp;

  var sigBuf = nodeCrypto.createHmac('sha256', secret).update(signingInput).digest();
  var sigB64 = b64urlEncode(sigBuf);

  return signingInput + '.' + sigB64;
}

// ── verify ────────────────────────────────────────────────────────

// Verify a token. Returns { contact_id, exp, scope } on success, null on
// any validation failure (malformed, bad signature, expired, scope mismatch).
// Throws ONLY if PAGE_TOKEN_SECRET is missing — that's a config error, not
// a token error, and callers should surface it as a 500, not a 403.
function verify(token, expectedScope) {
  if (!token || typeof token !== 'string') return null;

  var secret = getSecret();
  if (!secret) {
    throw new Error('PAGE_TOKEN_SECRET not configured — cannot verify');
  }

  var parts = token.split('.');
  if (parts.length !== 4) return null;

  var scope        = parts[0];
  var contactIdB64 = parts[1];
  var expStr       = parts[2];
  var providedSig  = parts[3];

  if (SCOPES.indexOf(scope) === -1) return null;
  if (expectedScope && scope !== expectedScope) return null;

  var exp = parseInt(expStr, 10);
  if (!exp || isNaN(exp)) return null;
  // Guard against non-integer inputs like "60e9"
  if (String(exp) !== expStr) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  // Recompute signature over the same input and compare in constant time
  var signingInput = scope + '.' + contactIdB64 + '.' + expStr;
  var expectedBuf = nodeCrypto.createHmac('sha256', secret).update(signingInput).digest();

  var providedBuf;
  try {
    providedBuf = b64urlDecode(providedSig);
  } catch (e) {
    return null;
  }

  if (providedBuf.length !== expectedBuf.length) return null;
  if (!nodeCrypto.timingSafeEqual(providedBuf, expectedBuf)) return null;

  var contact_id;
  try {
    contact_id = b64urlDecode(contactIdB64).toString('utf8');
  } catch (e) {
    return null;
  }
  if (!contact_id) return null;

  return { contact_id: contact_id, exp: exp, scope: scope };
}

// ── configured? ───────────────────────────────────────────────────

function isConfigured() {
  return !!process.env.PAGE_TOKEN_SECRET;
}

// ── Cookie helpers (C6: HttpOnly cookie exchange) ─────────────────
//
// Clean cutover from `window.__PAGE_TOKEN__` baked into HTML to an HttpOnly
// cookie set by /api/page-token/request. Each scope has its own cookie and is
// path-scoped to the client slug so one contact's token can't be sent to a
// different client's page.

function cookieName(scope) {
  return 'mr_pt_' + scope;
}

// Parse a single named cookie out of a request's Cookie header.
// Does NOT URL-decode (tokens are already b64url-safe) — avoids the classic
// "percent-encoded signature fails verification" bug.
function readCookie(req, name) {
  if (!req || !req.headers) return null;
  var header = req.headers.cookie || '';
  if (!header) return null;
  var prefix = name + '=';
  var parts = header.split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p.indexOf(prefix) === 0) return p.substring(prefix.length);
  }
  return null;
}

// Build a Set-Cookie header value. Express/Vercel's res.setHeader doesn't
// uppercase cookie attributes — follow the HTTP spec casing for readability.
// Path-scope to /<slug> so cross-client leakage is impossible even with
// SameSite relaxed settings.
function buildSetCookie(scope, slug, token, opts) {
  opts = opts || {};
  var ttl = opts.ttl_seconds || DEFAULT_TTL[scope] || 86400;
  var secure = opts.secure !== false;  // default true; tests can disable
  var path = '/' + String(slug || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path || path === '/') path = '/';
  var parts = [
    cookieName(scope) + '=' + token,
    'Path=' + path,
    'Max-Age=' + ttl,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie(scope, slug) {
  var path = '/' + String(slug || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path || path === '/') path = '/';
  return cookieName(scope) + '=; Path=' + path + '; Max-Age=0; HttpOnly; SameSite=Lax; Secure';
}

// Pull the most likely token for `expectedScope` out of a request. Looks at
// (in order): cookie, request body.page_token, body.token, Authorization
// header. Returns string or null. Does NOT verify — call verify() with the
// result.
function getTokenFromRequest(req, expectedScope) {
  // 1. Preferred: cookie (new path)
  var fromCookie = readCookie(req, cookieName(expectedScope));
  if (fromCookie) return fromCookie;
  // 2. Legacy: page_token in JSON body (deployed pages still POST it)
  if (req && req.body) {
    if (typeof req.body.page_token === 'string' && req.body.page_token) return req.body.page_token;
    if (typeof req.body.token === 'string' && req.body.token) return req.body.token;
  }
  // 3. Authorization: Bearer <token>
  if (req && req.headers) {
    var h = req.headers.authorization || req.headers.Authorization || '';
    if (h.indexOf('Bearer ') === 0) return h.substring(7);
  }
  return null;
}

module.exports = {
  sign: sign,
  verify: verify,
  isConfigured: isConfigured,
  SCOPES: SCOPES,
  DEFAULT_TTL: DEFAULT_TTL,
  cookieName: cookieName,
  readCookie: readCookie,
  buildSetCookie: buildSetCookie,
  buildClearCookie: buildClearCookie,
  getTokenFromRequest: getTokenFromRequest
};
