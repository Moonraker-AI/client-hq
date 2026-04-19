// /api/progress-update.js
// Page-token-gated endpoint for the client-facing progress tracker.
// Replaces the legacy direct anon PATCH against /rest/v1/checklist_items
// (security audit H4). Dropping the anon_update_status RLS policy removed
// any anon write path on the table; all checklist status toggles from
// clients-facing pages flow through here.
//
// Request shape:
//   POST /api/progress-update
//   Content-Type: application/json
//   Body: {
//     page_token: "<scope=progress HMAC>",   // baked into the page at deploy
//     item_id:    "<checklist_items.id>",
//     status:     "not_started" | "in_progress" | "complete"
//   }
//
// Auth posture:
//   1. Origin validation — blocks cross-origin abuse.
//   2. scope='progress' page token verify — binds the request to a contact
//      we provisioned. Token TTL 365 days (see _lib/page-token.js).
//   3. Per-IP rate limit 120 req/min — clients can fire multiple toggles
//      when cycling status; 120 is generous but caps spamming.
//   4. Row-level binding — the item's client_slug must match the slug of
//      the contact the token was issued to. Prevents a valid token from one
//      client being replayed against another client's checklist_items.
//   5. Visibility gate — web_visible=true required, mirroring the legacy
//      policy's intent that internal-only items stay admin-editable.
//
// ENV VARS: PAGE_TOKEN_SECRET, SUPABASE_SERVICE_ROLE_KEY.

var sb = require('./_lib/supabase');
var rateLimit = require('./_lib/rate-limit');
var pageToken = require('./_lib/page-token');

var ALLOWED_STATUSES = ['not_started', 'in_progress', 'complete'];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://clients.moonraker.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Origin validation
  var origin = req.headers.origin || '';
  if (origin && origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'Service not configured' });
  }

  var body = req.body || {};
  var submittedToken = pageToken.getTokenFromRequest(req, 'progress') || '';
  var itemId = (body.item_id || '').toString().trim();
  var nextStatus = (body.status || '').toString();

  if (!itemId || !nextStatus) {
    return res.status(400).json({ error: 'item_id and status required' });
  }
  if (ALLOWED_STATUSES.indexOf(nextStatus) === -1) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  // checklist_items.id is a text column. Legacy format is "<8-hex>-<3-digit>";
  // newer rows may be UUIDs. Accept both by whitelisting a loose identifier
  // shape (alphanumerics + hyphens + underscores, up to 64 chars) — tight
  // enough to keep bogus input out, broad enough to cover both formats.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(itemId)) {
    return res.status(400).json({ error: 'Invalid item_id' });
  }

  // 2. Page-token verify (scope='progress')
  var tokenData;
  try {
    tokenData = pageToken.verify(submittedToken, 'progress');
  } catch (e) {
    console.error('[progress-update] page-token verify threw:', e.message);
    return res.status(500).json({ error: 'Page token service unavailable' });
  }
  if (!tokenData) {
    return res.status(401).json({ error: 'Invalid or expired page token' });
  }

  // 3. Per-IP rate limit (fail-closed; checklist writes are cheap but not free)
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':progress-update', 120, 60);
  rateLimit.setHeaders(res, rl, 120);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    // 4a. Resolve token.contact_id → slug
    var contact = await sb.one('contacts?id=eq.' + encodeURIComponent(tokenData.contact_id)
      + '&select=slug&limit=1');
    if (!contact || !contact.slug) {
      return res.status(403).json({ error: 'Token contact not found' });
    }

    // 4b + 5. Load the item, check ownership + visibility
    var item = await sb.one('checklist_items?id=eq.' + encodeURIComponent(itemId)
      + '&select=id,client_slug,web_visible&limit=1');
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.client_slug !== contact.slug) {
      return res.status(403).json({ error: 'Item does not belong to token contact' });
    }
    if (!item.web_visible) {
      return res.status(403).json({ error: 'Item is not web-editable' });
    }

    // 6. Service-role PATCH
    var nowIso = new Date().toISOString();
    var patch = {
      status: nextStatus,
      updated_at: nowIso,
      completed_at: nextStatus === 'complete' ? nowIso : null
    };
    await sb.mutate('checklist_items?id=eq.' + encodeURIComponent(itemId),
      'PATCH', patch, 'return=minimal');

    return res.status(200).json({ success: true, status: nextStatus });
  } catch (e) {
    console.error('[progress-update] error:', e);
    return res.status(500).json({ error: 'Failed to update progress' });
  }
};
