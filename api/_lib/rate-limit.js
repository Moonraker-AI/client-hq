// api/_lib/rate-limit.js
// Fixed-window rate-limit helper backed by Supabase rate_limits table.
// Decision 2A from docs/phase-4-design.md.
//
// Usage:
//   var rateLimit = require('./_lib/rate-limit');
//
//   // Inside a handler:
//   var ip = rateLimit.getIp(req);
//   var r = await rateLimit.check('ip:' + ip + ':proposal-chat', 20, 60);
//   if (!r.allowed) {
//     res.setHeader('Retry-After', Math.ceil((r.reset_at - new Date()) / 1000));
//     return res.status(429).json({ error: 'Too many requests' });
//   }
//
// Failure semantics: if the Supabase store is unreachable, check() defaults
// to fail-closed (allowed=false). This protects expensive endpoints (Anthropic
// API cost) during a store outage. Pass { failClosed: false } to override —
// suitable only for non-expensive endpoints where denial of service to
// legitimate users is worse than potential abuse during an outage.
//
// Buckets are fixed-window, not sliding — first request after expiry resets
// the counter and window_start. For the purposes of protecting expensive
// endpoints from bursts this is fine; a sliding window is more complex and
// the precision gain isn't worth it at our scale.

var sb = require('./supabase');

// Check whether a bucket is under its limit, and atomically increment.
//
// key:           bucket identifier. Convention: 'ip:<ip>:<route>' for per-IP
//                limits, 'contact:<uuid>:<route>' for per-user limits.
// limit:         max requests allowed per window (positive integer).
// windowSeconds: window size in seconds (positive integer).
// options:
//   failClosed:  boolean, default true. If the store is unreachable, return
//                allowed=false (fail-closed) or allowed=true (fail-open).
//
// Returns: { allowed: bool, count: int, reset_at: Date|null, error?: string }
//   - allowed  is true if this request is under the limit.
//   - count    is the post-increment count (note: continues past the limit,
//              so useful for observability).
//   - reset_at is when the current window ends and the bucket resets.
//   - error    is set on store failure ('store_unavailable' or 'invalid_response').
async function check(key, limit, windowSeconds, options) {
  options = options || {};
  var failClosed = options.failClosed !== false; // default true

  if (!key || typeof key !== 'string') {
    throw new Error('rate-limit.check: key required (non-empty string)');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('rate-limit.check: limit must be positive integer (got ' + limit + ')');
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error('rate-limit.check: windowSeconds must be positive integer (got ' + windowSeconds + ')');
  }

  if (!sb.isConfigured()) {
    console.error('[rate-limit] SUPABASE_SERVICE_ROLE_KEY not configured');
    return failureResult(failClosed, 'store_unavailable');
  }

  try {
    var rows = await sb.mutate('rpc/rate_limit_check', 'POST', {
      p_bucket_key:     key,
      p_limit_count:    limit,
      p_window_seconds: windowSeconds
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('[rate-limit] unexpected RPC response shape:', JSON.stringify(rows).slice(0, 200));
      return failureResult(failClosed, 'invalid_response');
    }

    var row = rows[0];
    return {
      allowed:  !!row.allowed,
      count:    typeof row.count === 'number' ? row.count : 0,
      reset_at: row.reset_at ? new Date(row.reset_at) : null
    };
  } catch (e) {
    console.error('[rate-limit] store unavailable:', e.message);
    return failureResult(failClosed, 'store_unavailable');
  }
}

function failureResult(failClosed, errCode) {
  return {
    allowed:  failClosed ? false : true,
    count:    0,
    reset_at: null,
    error:    errCode
  };
}

// Extract client IP from Vercel request headers.
// Vercel always sets x-forwarded-for; the first entry in the list is the
// real client IP (subsequent entries are proxies). Falls back to x-real-ip,
// then 'unknown' as a last resort. Unknown IPs all share a bucket, which is
// safe (they'd be rate-limited together) but means a misconfigured proxy
// could cause noisy-neighbor denials — hence the fallback.
function getIp(req) {
  if (!req || !req.headers) return 'unknown';
  var xff = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] || '';
  if (xff) {
    var first = xff.split(',')[0];
    if (first) return first.trim();
  }
  var real = req.headers['x-real-ip'] || req.headers['X-Real-IP'];
  if (real) return String(real).trim();
  return 'unknown';
}

// Convenience: set standard rate-limit headers on a response.
// Safe to call even on the success path to inform clients of their budget.
function setHeaders(res, result, limit) {
  if (!res || !result) return;
  try {
    res.setHeader('X-RateLimit-Limit',     String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - (result.count || 0))));
    if (result.reset_at) {
      res.setHeader('X-RateLimit-Reset', String(Math.floor(result.reset_at.getTime() / 1000)));
    }
  } catch (e) { /* headers may be locked; ignore */ }
}

module.exports = {
  check:      check,
  getIp:      getIp,
  setHeaders: setHeaders
};
