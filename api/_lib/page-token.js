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
// cookie set by /api/page-token/request. Each scope has its own cookie.
//
// Binding model (post-2026-04-20 Path fix):
//   - The HMAC payload binds the token to contact_id + scope + exp.
//     verify(token, scope) returns the contact_id; callers look up the
//     authoritative slug from `contacts.slug` and enforce equality with the
//     request's slug (body.slug / query.slug) at the endpoint layer.
//   - The cookie itself is Path=/ so it is delivered on every same-origin
//     write regardless of which subpath the fetch originated from. The
//     previous Path=/<slug> scheme broke delivery for cross-subpath fetches
//     in some browsers and added no security (a token leaked from page A
//     would still be accepted if replayed on page B because no endpoint
//     asserted a slug match — the cookie path only controlled *delivery*,
//     not acceptance). Slug enforcement now lives server-side per endpoint.

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
// Path=/ so the cookie is delivered on every same-origin write regardless
// of which subpath the fetch originates from. Slug binding is enforced
// server-side per endpoint (see module-level docs above).
// `slug` parameter is retained for call-site compatibility but ignored.
function buildSetCookie(scope, slug, token, opts) {
  opts = opts || {};
  var ttl = opts.ttl_seconds || DEFAULT_TTL[scope] || 86400;
  var secure = opts.secure !== false;  // default true; tests can disable
  var parts = [
    cookieName(scope) + '=' + token,
    'Path=/',
    'Max-Age=' + ttl,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie(scope, slug) {
  // `slug` retained for call-site compatibility; Path=/ matches buildSetCookie.
  return cookieName(scope) + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure';
}

// Build a Set-Cookie value that expires a *legacy* Path=/<slug> cookie. Browsers
// key cookie storage on (name, domain, path) — an attribute-mismatched clear
// header is silently ignored. We emit this alongside the fresh Path=/ cookie
// from /api/page-token/request so visitors who previously received a
// Path=/<slug> cookie (pre-2026-04-20 bc8fd76b) have the stale entry removed
// instead of colliding with the new one. Per RFC 6265 §5.4, when two cookies
// share a name, more-specific paths sort first — readCookie() returns the
// first match, so a lingering Path=/<slug> cookie wins and verify() rejects it.
function buildLegacyPathClearCookie(scope, slug) {
  if (!slug) return null;
  var safeSlug = String(slug).replace(/[^a-z0-9-]/gi, '');
  if (!safeSlug) return null;
  return cookieName(scope) + '=; Path=/' + safeSlug + '; Max-Age=0; HttpOnly; SameSite=Lax; Secure';
}

// Pull the most likely token for `expectedScope` out of a request. Cookie
// is the only accepted path since C6 cutover — every client-facing page
// mints its token via /api/page-token/request and the browser attaches it
// to subsequent writes automatically. Returns string or null. Does NOT
// verify — call verify() with the result.
function getTokenFromRequest(req, expectedScope) {
  return readCookie(req, cookieName(expectedScope));
}

// Enforce that a request-supplied slug matches the contact the token was
// issued to. Since the HMAC payload only binds {contact_id, scope, exp} —
// not slug — every write endpoint that accepts a slug (body / query) must
// look up contacts.slug by the verified contact_id and compare. Returns
// true if bound OR if no request-side slug was supplied (strict mode off);
// returns false on mismatch. Caller 403s on false.
//
// Usage:
//   var ok = pageToken.assertSlugBinding(body.slug || query.slug, contact.slug);
//   if (!ok) return res.status(403).json({ error: 'Page token not valid for this client' });
function assertSlugBinding(requestSlug, contactSlug) {
  if (!requestSlug) return true; // no client-supplied slug to compare — endpoint-specific check upstream
  if (!contactSlug) return false;
  return String(requestSlug).trim().toLowerCase() === String(contactSlug).trim().toLowerCase();
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
  buildLegacyPathClearCookie: buildLegacyPathClearCookie,
  getTokenFromRequest: getTokenFromRequest,
  assertSlugBinding: assertSlugBinding
};
