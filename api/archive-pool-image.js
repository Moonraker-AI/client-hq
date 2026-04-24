// /api/archive-pool-image.js
//
// Pagemaster v2: soft-delete a pool image. Sets status='archived' so it stops
// appearing in pickers. Storage files preserved in case any deployed page
// still references the URL.
//
// POST { contact_id, pool_id, reason? }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');
var sanitizer = require('./_lib/html-sanitizer');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  var poolId = body.pool_id;
  var reason = sanitizer.sanitizeText(String(body.reason || 'user_removed'), 200);

  if (!contactId || !UUID_RE.test(contactId)) return res.status(400).json({ error: 'Invalid contact_id' });
  if (!poolId || !UUID_RE.test(poolId)) return res.status(400).json({ error: 'Invalid pool_id' });

  try {
    var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
    var token = null;
    if (tokenStr) { try { token = pageToken.verify(tokenStr, 'onboarding'); } catch (_) { token = null; } }
    if (!token || token.contact_id !== contactId) {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
    }

    // Verify pool row belongs to contact
    var pool = await sb.one(
      'client_image_pool?id=eq.' + encodeURIComponent(poolId) +
      '&contact_id=eq.' + encodeURIComponent(contactId) +
      '&limit=1'
    );
    if (!pool) return res.status(404).json({ error: 'Pool row not found' });

    if (pool.status === 'archived') {
      return res.status(200).json({ ok: true, idempotent: true });
    }

    await sb.mutate('client_image_pool?id=eq.' + pool.id, 'PATCH', {
      status: 'archived',
      archived_at: new Date().toISOString(),
      archived_reason: reason,
    }, 'return=minimal');

    return res.status(200).json({ ok: true });

  } catch (err) {
    monitor.logError('archive-pool-image', err, { detail: { stage: 'handler' } });
    return res.status(500).json({ error: 'Archive failed' });
  }
};
