// /api/auth/session.js
// Sync the Supabase-issued JWT into an HttpOnly cookie for /api/* server-side
// auth (C3 migration). The Supabase JS SDK continues to own session lifecycle
// client-side — this endpoint just mirrors the access token into a cookie the
// browser can't read.
//
// Cookie:
//   Name:     mr_admin_sess
//   Value:    <access_token>  (raw ES256 JWT)
//   Path:     /
//   HttpOnly: yes
//   Secure:   yes
//   SameSite: Lax
//   Max-Age:  derived from JWT exp claim, capped at 24h
//
// Requests:
//   POST /api/auth/session  { access_token, expires_at? }   → set cookie
//   DELETE /api/auth/session                                → clear cookie
//
// Security notes:
//   - We verify the submitted JWT with the same JWKS path as api/_lib/auth.js
//     so an attacker can't stuff a random string into the cookie.
//   - No admin_profiles check here — that happens on each /api/admin/* call
//     exactly as before. This endpoint only issues the cookie; authorization
//     is still enforced per-route.

var auth = require('../_lib/auth');

var COOKIE_NAME = 'mr_admin_sess';
var MAX_LIFETIME_SECONDS = 24 * 60 * 60;  // 24h hard cap

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function buildSetCookie(token, ttlSeconds, secure) {
  var parts = [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'Max-Age=' + ttlSeconds,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure !== false) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie(secure) {
  var parts = [
    COOKIE_NAME + '=',
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure !== false) parts.push('Secure');
  return parts.join('; ');
}

module.exports = async function handler(req, res) {
  // Always no-store — cookies are per-user, caches must never see them.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', buildClearCookie());
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var body = req.body || {};
  var accessToken = String(body.access_token || '').trim();
  if (!accessToken) return res.status(400).json({ error: 'access_token required' });

  // Validate shape + signature + expiry + admin profile — same pipeline as the
  // request path so we never issue a cookie for a token we wouldn't accept.
  var payload;
  try {
    payload = await auth.verifyJwt(accessToken);
  } catch (e) {
    return res.status(500).json({ error: 'JWT verification unavailable' });
  }
  if (!payload || !payload.sub) return res.status(401).json({ error: 'Invalid or expired token' });

  // Derive TTL from exp claim, capped at 24h so an accidentally-long-lived
  // token doesn't sit in the cookie jar for days.
  var nowSec = Math.floor(Date.now() / 1000);
  var exp = typeof payload.exp === 'number' ? payload.exp : 0;
  var ttl = Math.max(60, Math.min(MAX_LIFETIME_SECONDS, exp - nowSec));

  res.setHeader('Set-Cookie', buildSetCookie(accessToken, ttl));
  return res.status(200).json({ ok: true, ttl_seconds: ttl });
};

module.exports.COOKIE_NAME = COOKIE_NAME;
