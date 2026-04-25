// /api/search-stock-images.js
// Search the stock image library by keyword/description using full-text search.
// Also scans a client's Drive folder for uploaded photos.
//
// POST body: { query, contact_id?, limit? }
// Returns: { stock: [...], client_photos: [...] }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var query = (body.query || '').trim();
  var contactId = body.contact_id || null;
  var limit = Math.min(parseInt(body.limit) || 20, 60);

  // Auth: page-token (client onboarding) OR admin
  if (contactId && UUID_RE.test(contactId)) {
    var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
    var token = null;
    if (tokenStr) { try { token = pageToken.verify(tokenStr, 'onboarding'); } catch (_) { token = null; } }
    if (!token || token.contact_id !== contactId) {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
    }
  } else {
    var admin2 = await auth.requireAdminOrInternal(req, res);
    if (!admin2) return;
  }

  try {
    var results = { stock: [], client_photos: [] };

    // 1. Stock images: query → FTS; no query → browse (recent / asset_id order)
    if (query) {
      var searchTerms = query.toLowerCase()
        .replace(/\b(emdr|cbt|dbt|act|ifs)\b/gi, 'therapy')
        .replace(/\b(fibromyalgia|chronic pain)\b/gi, 'wellness health care')
        .trim();

      var ftsUrl = sb.url() + '/rest/v1/rpc/search_stock_images';
      var ftsResp = await fetch(ftsUrl, {
        method: 'POST',
        headers: sb.headers(),
        body: JSON.stringify({ search_query: searchTerms, result_limit: limit })
      });

      if (ftsResp.ok) {
        results.stock = await ftsResp.json();
      } else {
        var firstTerm = searchTerms.split(' ')[0] || '';
        var fallbackUrl = sb.url() + '/rest/v1/stock_images' +
          '?select=id,asset_id,rich_description,mood_tags,hosted_url,drive_view_url' +
          '&hosted_url=not.is.null' +
          '&or=(mood_tags.ilike.*' + encodeURIComponent(firstTerm) + '*,rich_description.ilike.*' + encodeURIComponent(firstTerm) + '*)' +
          '&limit=' + limit;
        var fallbackResp = await fetch(fallbackUrl, { headers: sb.headers() });
        if (fallbackResp.ok) results.stock = await fallbackResp.json();
      }
    } else {
      // Browse mode: return recent stock images, hosted_url not null
      var browseUrl = sb.url() + '/rest/v1/stock_images' +
        '?select=id,asset_id,rich_description,mood_tags,hosted_url,drive_view_url' +
        '&hosted_url=not.is.null' +
        '&order=asset_id.desc' +
        '&limit=' + limit;
      var browseResp = await fetch(browseUrl, { headers: sb.headers() });
      if (browseResp.ok) results.stock = await browseResp.json();
    }

    // 2. Scan client Drive folder for photos (if contact has drive_folder_id)
    if (contactId) {
      try {
        var drive = require('./_lib/google-drive');
        if (drive.isConfigured()) {
          var contact = await sb.one('contacts?id=eq.' + contactId + '&select=drive_folder_id&limit=1');
          if (contact && contact.drive_folder_id) {
            var files = await drive.listFiles(contact.drive_folder_id, {
              mimeType: 'image/*',
              pageSize: 30
            });
            results.client_photos = files.map(function(f) {
              return {
                id: f.id,
                name: f.name,
                mimeType: f.mimeType,
                thumbnailLink: f.thumbnailLink,
                size: f.size,
                modifiedTime: f.modifiedTime
              };
            });
          }
        }
      } catch (driveErr) {
        console.log('Drive scan skipped:', driveErr.message);
      }
    }

    return res.status(200).json(results);

  } catch (err) {
    console.error('search-stock-images error:', err);
    monitor.logError('search-stock-images', err, {
      detail: { stage: 'search_handler' }
    });
    return res.status(500).json({ error: 'Stock image search failed' });
  }
};
