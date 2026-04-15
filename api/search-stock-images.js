// /api/search-stock-images.js
// Search the stock image library by keyword/description using full-text search.
// Also scans a client's Drive folder for uploaded photos.
//
// POST body: { query, contact_id?, limit? }
// Returns: { stock: [...], client_photos: [...] }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var query = (body.query || '').trim();
  var contactId = body.contact_id || null;
  var limit = Math.min(parseInt(body.limit) || 20, 50);

  try {
    var results = { stock: [], client_photos: [] };

    // 1. Search stock images via full-text search
    if (query) {
      // Convert keyword to search-friendly terms
      // e.g. "EMDR therapy" → "therapy counseling calm professional"
      var searchTerms = query.toLowerCase()
        .replace(/emdr|cbt|dbt|act|ifs/gi, 'therapy')
        .replace(/fibromyalgia|chronic pain/gi, 'wellness health care')
        .trim();

      var stockUrl = sb.url() + '/rest/v1/stock_images' +
        '?select=id,asset_id,rich_description,mood_tags,hosted_url,drive_view_url' +
        '&hosted_url=not.is.null' +
        '&order=asset_id.asc' +
        '&limit=' + limit;

      // Try full-text search first
      var ftsUrl = sb.url() + '/rest/v1/rpc/search_stock_images';
      var ftsResp = await fetch(ftsUrl, {
        method: 'POST',
        headers: sb.headers(),
        body: JSON.stringify({ search_query: searchTerms, result_limit: limit })
      });

      if (ftsResp.ok) {
        results.stock = await ftsResp.json();
      } else {
        // Fallback: simple ILIKE on mood_tags
        var fallbackUrl = sb.url() + '/rest/v1/stock_images' +
          '?select=id,asset_id,rich_description,mood_tags,hosted_url,drive_view_url' +
          '&hosted_url=not.is.null' +
          '&or=(mood_tags.ilike.*' + encodeURIComponent(searchTerms.split(' ')[0]) + '*,rich_description.ilike.*' + encodeURIComponent(searchTerms.split(' ')[0]) + '*)' +
          '&limit=' + limit;
        var fallbackResp = await fetch(fallbackUrl, { headers: sb.headers() });
        if (fallbackResp.ok) results.stock = await fallbackResp.json();
      }
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
    return res.status(500).json({ error: err.message });
  }
};
