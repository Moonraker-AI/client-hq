// api/auth/change-password.js
// FE-H3 remediation. Server-mediated admin password change.
//
// Why this exists:
//   The old admin UI PATCH'd admin_profiles + called supabase.auth.updateUser
//   directly from the browser using the signed-in user's own access token.
//   A future RLS loosening on admin_profiles (e.g. to let an admin edit their
//   own display_name) could inadvertently let them also PATCH their own role
//   to 'owner'. Same request shape, same JWT, different target column.
//
//   Routing through this endpoint strips role/email/id/display_name from any
//   caller payload before we touch Supabase Auth or admin_profiles. The only
//   fields the caller can influence are the password itself and the boolean
//   must_change_password flag (which only ever transitions true -> false).
//
// Method:   POST  (405 otherwise, with Allow header)
// Auth:     requireAdmin — valid admin JWT cookie required
// Body:     { new_password: string, must_change_password?: boolean }
// Returns:  200 { ok: true }
//           400 { error: '...' }         on validation failure
//           401/403                       from requireAdmin
//           429 { error: 'Too many...' } rate-limit
//           500 { error: 'Password change failed' }   generic
//
// Security posture:
//   - Rate limited to 5/60s per admin user (not per IP — the bucket key
//     includes user.id so two admins behind one NAT don't share quota).
//   - Password is never echoed in response or logs. monitor.logError receives
//     stage strings only, not the password.
//   - The `new_password` length validation uses simple length checks (no
//     timing-sensitive comparisons), so there's no per-request timing leak.
//   - Body is validated BEFORE the Supabase Auth call so a malformed payload
//     can't trigger a password rotation.
//   - Payload fields role/email/id/display_name are rejected (400) to make
//     the intent explicit. This endpoint will never write those columns.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var rateLimit = require('../_lib/rate-limit');

var FORBIDDEN_FIELDS = ['role', 'email', 'id', 'display_name'];
var MIN_LEN = 8;
var MAX_LEN = 199; // strictly less than 200 per spec

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return; // requireAdmin already wrote 401/403

  // Rate limit: 5 per user per 60s. fail-closed — if the rate-limit store is
  // unreachable we'd rather 503-ish the caller than let an attacker brute.
  var rl = await rateLimit.check('admin:' + user.id + ':change-password', 5, 60, { failClosed: true });
  rateLimit.setHeaders(res, rl, 5);
  if (!rl.allowed) {
    if (rl.reset_at) {
      var retryAfter = Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
    }
    return res.status(429).json({ error: 'Too many requests' });
  }

  var body = req.body || {};

  // Reject forbidden fields with a generic message — do not echo which one.
  for (var i = 0; i < FORBIDDEN_FIELDS.length; i++) {
    if (Object.prototype.hasOwnProperty.call(body, FORBIDDEN_FIELDS[i])) {
      return res.status(400).json({ error: 'Unsupported field in payload' });
    }
  }

  var newPassword = body.new_password;
  if (typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'new_password required' });
  }
  if (newPassword.length < MIN_LEN || newPassword.length > MAX_LEN) {
    // Single error message for both too-short and too-long so an attacker
    // can't binary-search the bounds via response differences.
    return res.status(400).json({ error: 'new_password must be 8-199 characters' });
  }

  var mustChangeFlag = body.must_change_password;
  if (mustChangeFlag !== undefined && typeof mustChangeFlag !== 'boolean') {
    return res.status(400).json({ error: 'must_change_password must be boolean' });
  }

  // ── Step 1: update the Supabase Auth password via the Admin API ──────
  // Uses the service-role key. The PUT path binds the mutation to user.id
  // from our verified JWT payload, so a caller cannot retarget another
  // account even if they somehow manipulate the body.
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    await monitor.logError('auth-change-password', new Error('SUPABASE_SERVICE_ROLE_KEY not configured'), {
      detail: { stage: 'config_check', user_id: user.id }
    });
    return res.status(500).json({ error: 'Password change failed' });
  }

  var authResp;
  try {
    authResp = await fetch(sb.url() + '/auth/v1/admin/users/' + encodeURIComponent(user.id), {
      method: 'PUT',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: newPassword })
    });
  } catch (err) {
    await monitor.logError('auth-change-password', err, {
      detail: { stage: 'auth_admin_fetch', user_id: user.id }
    });
    return res.status(500).json({ error: 'Password change failed' });
  }

  if (!authResp.ok) {
    var detailSnippet = '';
    try { detailSnippet = (await authResp.text()).substring(0, 400); } catch (e) { /* swallow */ }
    await monitor.logError('auth-change-password', new Error('Supabase Auth admin PUT non-2xx'), {
      detail: {
        stage: 'auth_admin_response',
        user_id: user.id,
        status: authResp.status,
        body_snippet: detailSnippet
      }
    });
    return res.status(500).json({ error: 'Password change failed' });
  }

  // ── Step 2: optionally clear the must_change_password flag ───────────
  // Gated on the caller explicitly sending false. Undefined = don't touch
  // the column at all. A subsequent login will still prompt if the column
  // is already true and the caller didn't opt in to clearing it here.
  if (mustChangeFlag === false) {
    try {
      await sb.mutate(
        'admin_profiles?id=eq.' + encodeURIComponent(user.id),
        'PATCH',
        { must_change_password: false },
        'return=minimal'
      );
    } catch (err) {
      // Password was rotated successfully; failing to clear the flag is
      // non-fatal (the user will just be re-prompted on next login). Log
      // and return success — a 500 here would be misleading.
      await monitor.logError('auth-change-password', err, {
        detail: { stage: 'clear_must_change_flag', user_id: user.id }
      });
    }
  }

  return res.status(200).json({ ok: true });
};
