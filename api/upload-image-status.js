// /api/upload-image-status.js
//
// Pagemaster v2 image upload — polling endpoint.
// Client polls this every 1.5-3s while images are processing to
// flip the UI from "processing..." to "ready" with the final hosted_url.
//
// GET /api/upload-image-status?contact_id=X&pool_ids=a,b,c
//   Returns: { items: [{ id, status, hosted_url, alt_text, error? }, ...] }
//
// Designed for batch polling (one fetch covers all in-flight uploads).

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var MAX_BATCH = 50;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var q = req.query || {};
  var contactId = q.contact_id;
  var poolIdsRaw = q.pool_ids || '';

  if (!contactId || !UUID_RE.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact_id' });
  }

  var poolIds = String(poolIdsRaw).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  if (poolIds.length === 0) return res.status(400).json({ error: 'pool_ids required' });
  if (poolIds.length > MAX_BATCH) return res.status(400).json({ error: 'Too many ids; max ' + MAX_BATCH });
  for (var i = 0; i < poolIds.length; i++) {
    if (!UUID_RE.test(poolIds[i])) return res.status(400).json({ error: 'Invalid pool_id in list' });
  }

  try {
    // Auth: page-token first (typical), admin fallback
    var token = pageToken.getTokenFromRequest(req, 'onboarding');
    if (!token || token.contact_id !== contactId) {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
    }

    // Build a PostgREST in.() filter
    var inList = '(' + poolIds.map(encodeURIComponent).join(',') + ')';
    var rows = await sb.query(
      'client_image_pool?contact_id=eq.' + encodeURIComponent(contactId) +
      '&id=in.' + inList +
      '&select=id,status,hosted_url,alt_text,filename,width,height,bytes,metadata_json'
    );

    var items = (rows || []).map(function(r) {
      var item = {
        id: r.id,
        status: r.status,
        filename: r.filename,
      };
      if (r.status === 'ready') {
        item.hosted_url = r.hosted_url;
        item.alt_text = r.alt_text || '';
        item.width = r.width;
        item.height = r.height;
        item.bytes = r.bytes;
      } else if (r.status === 'failed') {
        var meta = r.metadata_json || {};
        item.error = meta.processing_error || meta.sign_error || 'Processing failed';
      }
      return item;
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ items: items });

  } catch (err) {
    monitor.logError('upload-image-status', err, {
      detail: { stage: 'status_handler' },
    });
    return res.status(500).json({ error: 'Status check failed' });
  }
};
