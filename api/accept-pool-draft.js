// /api/accept-pool-draft.js
//
// Pagemaster v2: accept an AI-generated draft into the pool.
// Drafts are pool rows with metadata_json.is_draft = true. Accepting flips
// the flag to false so list-pool-images surfaces the row in the main grid.
// Discarding a draft uses /api/archive-pool-image instead.
//
// POST { contact_id, pool_id }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  var poolId = body.pool_id;

  if (!contactId || !UUID_RE.test(contactId)) return res.status(400).json({ error: 'Invalid contact_id' });
  if (!poolId || !UUID_RE.test(poolId)) return res.status(400).json({ error: 'Invalid pool_id' });

  try {
    var token = pageToken.getTokenFromRequest(req, 'onboarding');
    if (!token || token.contact_id !== contactId) {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
    }

    var pool = await sb.one(
      'client_image_pool?id=eq.' + encodeURIComponent(poolId) +
      '&contact_id=eq.' + encodeURIComponent(contactId) +
      '&limit=1'
    );
    if (!pool) return res.status(404).json({ error: 'Pool row not found' });

    var meta = pool.metadata_json || {};
    if (meta.is_draft !== true) {
      // Already accepted; treat as idempotent success.
      return res.status(200).json({ ok: true, idempotent: true });
    }

    meta.is_draft = false;
    meta.accepted_at = new Date().toISOString();

    await sb.mutate('client_image_pool?id=eq.' + pool.id, 'PATCH', {
      metadata_json: meta,
    }, 'return=minimal');

    return res.status(200).json({ ok: true });

  } catch (err) {
    monitor.logError('accept-pool-draft', err, { detail: { stage: 'handler' } });
    return res.status(500).json({ error: 'Accept failed' });
  }
};
