// /api/list-pool-images.js
//
// Pagemaster v2: list non-archived pool images for a contact, optionally
// filtered by category. Used by the image-uploader widget to hydrate
// existing items when the page loads.
//
// GET /api/list-pool-images?contact_id=X&category=practice
//
// Returns: { items: [{ id, status, hosted_url, alt_text, filename, category, ... }] }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ALLOWED_CATEGORIES = ['practice', 'logo', 'headshot', 'credential', 'hero', 'misc'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var q = req.query || {};
  var contactId = q.contact_id;
  var category = q.category || null;
  var bioMaterialId = q.bio_material_id || null;

  if (!contactId || !UUID_RE.test(contactId)) return res.status(400).json({ error: 'Invalid contact_id' });
  if (category && ALLOWED_CATEGORIES.indexOf(category) === -1) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  if (bioMaterialId && !UUID_RE.test(bioMaterialId)) {
    return res.status(400).json({ error: 'Invalid bio_material_id' });
  }

  try {
    var token = pageToken.getTokenFromRequest(req, 'onboarding');
    if (!token || token.contact_id !== contactId) {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
    }

    var query = 'client_image_pool' +
      '?contact_id=eq.' + encodeURIComponent(contactId) +
      '&status=neq.archived' +
      '&order=created_at.desc' +
      '&select=id,category,bio_material_id,source_type,status,hosted_url,filename,alt_text,title,width,height,bytes,is_primary,tags,metadata_json,created_at';

    if (category) query += '&category=eq.' + encodeURIComponent(category);
    if (bioMaterialId) query += '&bio_material_id=eq.' + encodeURIComponent(bioMaterialId);

    var rows = await sb.query(query);

    // Filter out unaccepted AI drafts (metadata_json.is_draft === true). The
    // widget surfaces drafts in its own Generate-tab UI; they don't belong
    // in the pool grid until the user clicks Accept.
    var filtered = (rows || []).filter(function (r) {
      return !(r.metadata_json && r.metadata_json.is_draft === true);
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ items: filtered });

  } catch (err) {
    monitor.logError('list-pool-images', err, { detail: { stage: 'handler' } });
    return res.status(500).json({ error: 'Listing failed' });
  }
};
