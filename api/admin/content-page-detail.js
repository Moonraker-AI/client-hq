// api/admin/content-page-detail.js
//
// Single endpoint returning everything the per-page editor needs:
//   - page row (incl. content_jsonb, schema_jsonb, faqs, meta_*, og_image_url, generated_html)
//   - bio_materials for the contact (used to enrich schema regeneration UI)
//   - neo_images: per-page rows + legacy contact-scoped rows (flagged shared=true)
//   - version history (content_page_versions, latest 20)
//   - schema_placeholders array (so admin sees which fields still need real data)
//
// GET ?content_page_id=<uuid>

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var schemaBuilder = require('../_lib/schema-builder');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var pageId = req.query.content_page_id;
  if (!pageId) return res.status(400).json({ error: 'content_page_id required' });

  try {
    var page = await sb.one('content_pages?id=eq.' + encodeURIComponent(pageId) + '&limit=1');
    if (!page) return res.status(404).json({ error: 'Content page not found' });

    var contactId = page.contact_id;

    var results = await Promise.all([
      // Per-page NEO images
      sb.query('neo_images?content_page_id=eq.' + encodeURIComponent(pageId) + '&order=created_at.desc'),
      // Legacy contact-scoped NEO images (shared across all pages of this contact)
      sb.query('neo_images?contact_id=eq.' + contactId + '&content_page_id=is.null&order=created_at.desc'),
      // Bios for the contact (read-only here, used by schema regenerate flow)
      sb.query('bio_materials?contact_id=eq.' + contactId + '&order=is_primary.desc,sort_order.asc'),
      // Version history
      sb.query('content_page_versions?content_page_id=eq.' + encodeURIComponent(pageId) + '&order=created_at.desc&limit=20')
    ]);

    var pageImages = (results[0] || []).map(function(img) {
      img.shared = false;
      return img;
    });
    var sharedImages = (results[1] || []).map(function(img) {
      img.shared = true;
      return img;
    });

    var schemaPlaceholders = [];
    if (page.schema_jsonb) {
      schemaPlaceholders = schemaBuilder.detectPlaceholders(page.schema_jsonb);
    }

    return res.json({
      success: true,
      page: page,
      neo_images: {
        page_scoped: pageImages,
        shared: sharedImages
      },
      bios: results[2] || [],
      versions: results[3] || [],
      schema_placeholders: schemaPlaceholders
    });
  } catch (err) {
    await monitor.logError('admin/content-page-detail', err, { detail: { content_page_id: pageId } });
    return res.status(500).json({ error: 'Failed to load page detail' });
  }
};
