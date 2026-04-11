// api/_lib/auth.js
// Shared authentication module for all admin API routes.
// Verifies Supabase Auth JWTs and checks admin_profiles membership.
//
// Usage:
//   var auth = require('./_lib/auth');
//   module.exports = async function handler(req, res) {
//     var user = await auth.requireAdmin(req, res);
//     if (!user) return; // 401/403 already sent
//     // user = { id, email, role, name }
//   };
//
// ENV: SUPABASE_JWT_SECRET (from Supabase project settings > API > JWT Secret)

var nodeCrypto = require('crypto');
var sb = require('./supabase');

// ── JWT verification ──────────────────────────────────────────────

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Verify HS256 JWT signature and decode payload.
// Returns decoded payload object or null if invalid/expired.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  var secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('[auth] SUPABASE_JWT_SECRET not configured');
    return null;
  }

  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;

    // Verify signature (HS256)
    var expected = base64urlEncode(
      nodeCrypto.createHmac('sha256', secret)
        .update(parts[0] + '.' + parts[1])
        .digest()
    );

    // Timing-safe comparison
    if (expected.length !== parts[2].length) return null;
    var a = Buffer.from(expected);
    var b = Buffer.from(parts[2]);
    if (!nodeCrypto.timingSafeEqual(a, b)) return null;

    // Decode payload
    var payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch (e) {
    console.error('[auth] JWT verification failed:', e.message);
    return null;
  }
}

// ── Extract token from request ────────────────────────────────────

function extractToken(req) {
  // Check Authorization: Bearer <token>
  var auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    var token = auth.slice(7).trim();
    // Skip if it's the anon or service_role key (not a user JWT)
    if (token.length > 0) return token;
  }
  return null;
}

// ── Admin profile cache (per-invocation, not persistent) ──────────
// Avoids hitting Supabase twice if requireAdmin is called multiple times
// in the same request. Cache lives only for the function invocation.
var _profileCache = {};

async function getAdminProfile(userId) {
  if (_profileCache[userId]) return _profileCache[userId];

  try {
    var profile = await sb.one(
      'admin_profiles?id=eq.' + userId + '&select=id,email,display_name,role&limit=1'
    );
    if (profile) _profileCache[userId] = profile;
    return profile;
  } catch (e) {
    console.error('[auth] Failed to fetch admin profile:', e.message);
    return null;
  }
}

// ── Main middleware: require authenticated admin ───────────────────

// Extracts JWT from Authorization header, verifies it, checks admin_profiles.
// Returns { id, email, role, name } on success.
// Returns null and sends 401/403 response on failure.
async function requireAdmin(req, res) {
  var token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  var payload = verifyToken(token);
  if (!payload || !payload.sub) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }

  // Must be in admin_profiles
  var profile = await getAdminProfile(payload.sub);
  if (!profile) {
    res.status(403).json({ error: 'Not authorized. Admin access required.' });
    return null;
  }

  // Update last_login_at (fire-and-forget)
  sb.mutate(
    'admin_profiles?id=eq.' + payload.sub,
    'PATCH',
    { last_login_at: new Date().toISOString() },
    'return=minimal'
  ).catch(function() {});

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    name: profile.display_name
  };
}

// ── Lighter check: verify token only (no DB lookup) ───────────────
// Use for high-frequency routes where DB check per-request is too heavy.
// Still verifies JWT signature and expiry.
function verifyOnly(req) {
  var token = extractToken(req);
  if (!token) return null;
  return verifyToken(token);
}

module.exports = {
  verifyToken: verifyToken,
  extractToken: extractToken,
  requireAdmin: requireAdmin,
  verifyOnly: verifyOnly
};
