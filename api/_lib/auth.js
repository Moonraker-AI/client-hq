// api/_lib/auth.js
// Shared authentication module for all admin API routes.
//
// Verifies Supabase Auth ES256 JWTs locally using cached JWKS public keys.
// No network call needed per request (only on cold start or key rotation).
//
// Flow:
//   1. Extract JWT from Authorization header
//   2. Fetch JWKS public key (cached in-memory across warm invocations)
//   3. Verify ES256 signature + expiry locally
//   4. Check admin_profiles membership
//
// Usage:
//   var auth = require('./_lib/auth');
//   var user = await auth.requireAdmin(req, res);
//   if (!user) return;

var nodeCrypto = require('crypto');
var sb = require('./supabase');

// ── JWKS cache (persists across warm invocations) ─────────────────

var _jwksCache = null;        // { keys: { kid: KeyObject }, fetchedAt: timestamp }
var JWKS_MAX_AGE = 300000;    // Re-fetch JWKS every 5 minutes at most
var JWKS_URL = null;

function getJwksUrl() {
  if (!JWKS_URL) JWKS_URL = sb.url() + '/auth/v1/.well-known/jwks.json';
  return JWKS_URL;
}

// Fetch JWKS and convert to Node KeyObjects, keyed by kid
async function fetchJwks() {
  var resp = await fetch(getJwksUrl());
  if (!resp.ok) throw new Error('JWKS fetch failed: ' + resp.status);

  var data = await resp.json();
  if (!data.keys || !Array.isArray(data.keys)) throw new Error('Invalid JWKS response');

  var keys = {};
  for (var i = 0; i < data.keys.length; i++) {
    var jwk = data.keys[i];
    if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
      try {
        keys[jwk.kid] = nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' });
      } catch (e) {
        console.error('[auth] Failed to import JWK kid=' + jwk.kid + ':', e.message);
      }
    }
  }

  _jwksCache = { keys: keys, fetchedAt: Date.now() };
  return keys;
}

// Get cached keys or fetch fresh
async function getKeys(forceRefresh) {
  if (!forceRefresh && _jwksCache && (Date.now() - _jwksCache.fetchedAt) < JWKS_MAX_AGE) {
    return _jwksCache.keys;
  }
  return fetchJwks();
}

// ── Base64url helpers ─────────────────────────────────────────────

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ── JWT verification ──────────────────────────────────────────────

async function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;

  var parts = token.split('.');
  if (parts.length !== 3) return null;

  // Decode header to get kid
  var header;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
  } catch (e) { return null; }

  if (header.alg !== 'ES256' || !header.kid) return null;

  // Get the public key for this kid
  var keys = await getKeys(false);
  var publicKey = keys[header.kid];

  // If key not found, try refreshing JWKS (key rotation scenario)
  if (!publicKey) {
    keys = await getKeys(true);
    publicKey = keys[header.kid];
    if (!publicKey) return null;
  }

  // Verify ES256 signature
  var signingInput = parts[0] + '.' + parts[1];
  var signature = b64urlDecode(parts[2]);

  var valid = nodeCrypto.verify(
    'sha256',
    Buffer.from(signingInput),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );

  if (!valid) {
    // Try with refreshed keys (in case of key rotation mid-flight)
    keys = await getKeys(true);
    publicKey = keys[header.kid];
    if (!publicKey) return null;

    valid = nodeCrypto.verify(
      'sha256',
      Buffer.from(signingInput),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
    if (!valid) return null;
  }

  // Decode and validate payload
  var payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (e) { return null; }

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// ── Token extraction ──────────────────────────────────────────────

function extractToken(req) {
  var auth = req.headers.authorization || req.headers.Authorization || '';
  if (auth.startsWith('Bearer ')) {
    var token = auth.slice(7).trim();
    if (token.length > 0) return token;
  }
  return null;
}

// ── Admin profile cache (per-invocation, 60s TTL) ─────────────────
//
// Cache entries are { profile, fetched_at } keyed by userId. The TTL
// bounds how long a revoked admin's access survives after their row is
// removed from admin_profiles (previously unbounded — only a cold start
// would clear the cache, which can be 15+ minutes on a warm Vercel
// instance).
//
// The cached profile also holds last_login_at so maybeUpdateLastLogin
// can throttle writes to at most one PATCH per 60s per admin without
// an extra DB read on every request.

var _profileCache = {};
var PROFILE_CACHE_TTL_MS = 60000;
var LAST_LOGIN_THROTTLE_MS = 60000;

async function getAdminProfile(userId) {
  var cached = _profileCache[userId];
  if (cached && (Date.now() - cached.fetched_at) < PROFILE_CACHE_TTL_MS) {
    return cached.profile;
  }
  try {
    var profile = await sb.one(
      'admin_profiles?id=eq.' + userId + '&select=id,email,display_name,role,last_login_at&limit=1'
    );
    if (profile) _profileCache[userId] = { profile: profile, fetched_at: Date.now() };
    return profile;
  } catch (e) {
    console.error('[auth] Admin profile lookup failed:', e.message);
    return null;
  }
}

// Fire-and-forget last_login_at update, throttled to >=60s per admin.
// 29+ admin routes x several calls per page view means the old
// unthrottled version was a sustained PATCH/second stream during normal
// use. Updates the cached value before firing so concurrent calls in
// the same window short-circuit without hitting the DB again.
function maybeUpdateLastLogin(userId) {
  var cached = _profileCache[userId];
  if (!cached || !cached.profile) return;
  var prevTs = cached.profile.last_login_at
    ? new Date(cached.profile.last_login_at).getTime() : 0;
  var now = Date.now();
  if ((now - prevTs) < LAST_LOGIN_THROTTLE_MS) return;
  var nowIso = new Date(now).toISOString();
  cached.profile.last_login_at = nowIso;
  sb.mutate(
    'admin_profiles?id=eq.' + userId,
    'PATCH',
    { last_login_at: nowIso },
    'return=minimal'
  ).catch(function() {});
}

// ── Main middleware ────────────────────────────────────────────────

async function requireAdmin(req, res) {
  var token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  var payload = await verifyJwt(token);
  if (!payload || !payload.sub) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  var profile = await getAdminProfile(payload.sub);
  if (!profile) {
    res.status(403).json({ error: 'Not authorized. Admin access required.' });
    return null;
  }

  // Update last_login_at (throttled, fire-and-forget)
  maybeUpdateLastLogin(payload.sub);

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    name: profile.display_name
  };
}

// ── Dual auth: admin JWT OR server-to-server key ──────────────────
//
// Use on routes called from both the admin UI and from internal
// server-to-server callers (crons, stripe webhook, agent service).
// Accepts: admin JWT, CRON_SECRET, or AGENT_API_KEY as Bearer token.

async function requireAdminOrInternal(req, res) {
  var token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  // Check CRON_SECRET (used by cron jobs and stripe webhook for internal calls)
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret && cronSecret.length === token.length && nodeCrypto.timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))) {
    return { id: 'system', email: 'system@internal', role: 'internal', name: 'System' };
  }

  // Check AGENT_API_KEY (used by agent service callbacks)
  var agentKey = process.env.AGENT_API_KEY;
  if (agentKey && agentKey.length === token.length && nodeCrypto.timingSafeEqual(Buffer.from(token), Buffer.from(agentKey))) {
    return { id: 'agent', email: 'agent@internal', role: 'agent', name: 'Agent Service' };
  }

  // Fall back to admin JWT verification
  var payload = await verifyJwt(token);
  if (!payload || !payload.sub) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  var profile = await getAdminProfile(payload.sub);
  if (!profile) {
    res.status(403).json({ error: 'Not authorized. Admin access required.' });
    return null;
  }

  // Update last_login_at (throttled, fire-and-forget)
  maybeUpdateLastLogin(payload.sub);

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    name: profile.display_name
  };
}

module.exports = {
  verifyJwt: verifyJwt,
  extractToken: extractToken,
  requireAdmin: requireAdmin,
  requireAdminOrInternal: requireAdminOrInternal
};
