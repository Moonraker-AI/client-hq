// api/newsletter-subscribers-delete.js
// Hard-deletes one or more newsletter subscribers.
// Cascades to newsletter_sends via ON DELETE CASCADE.
//
// POST body: { ids: ['uuid', 'uuid', ...] }
// Admin authentication required.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MAX_IDS_PER_REQUEST = 500;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var ids = Array.isArray(body.ids) ? body.ids : [];

  if (ids.length === 0) {
    return res.status(400).json({ error: 'ids required (array of subscriber UUIDs)' });
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return res.status(400).json({ error: 'Too many ids. Maximum ' + MAX_IDS_PER_REQUEST + ' per request.' });
  }

  // Validate every id before touching the DB
  var valid = [];
  var invalid = [];
  for (var i = 0; i < ids.length; i++) {
    if (typeof ids[i] === 'string' && UUID_RE.test(ids[i])) {
      valid.push(ids[i]);
    } else {
      invalid.push(ids[i]);
    }
  }
  if (invalid.length) {
    return res.status(400).json({ error: 'Invalid UUID(s) in ids', invalid_count: invalid.length });
  }

  try {
    // Fetch the emails we're about to delete so we can return them for the
    // admin's confirmation log / undo toast context.
    var existing = await sb.query(
      'newsletter_subscribers?id=in.(' + valid.join(',') + ')&select=id,email'
    );
    var existingIds = existing.map(function(r) { return r.id; });

    if (existingIds.length === 0) {
      return res.status(200).json({
        deleted: 0,
        requested: valid.length,
        message: 'No matching subscribers found (already deleted or invalid IDs)'
      });
    }

    // Delete. PostgREST DELETE needs Prefer: return=representation to get rows back,
    // but we already have the emails from the select above.
    await sb.mutate(
      'newsletter_subscribers?id=in.(' + existingIds.join(',') + ')',
      'DELETE'
    );

    return res.status(200).json({
      deleted: existingIds.length,
      requested: valid.length,
      emails: existing.map(function(r) { return r.email; })
    });

  } catch (e) {
    monitor.logError('newsletter-subscribers-delete', e, { detail: { stage: 'delete_handler', id_count: valid.length } });
    return res.status(500).json({ error: 'Delete failed' });
  }
};
