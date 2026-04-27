// api/admin/build-page-schema.js
//
// Generates content_pages.schema_jsonb for one page from canonical sources.
// Called automatically by the trg_auto_build_page_schema trigger on INSERT
// (and on demand from the admin UI's "Regenerate schema" button).
//
// Sources fanned out:
//   - contacts row                   (org name, address, phone, logo, sameAs columns)
//   - practice_details row           (modalities, specialties, populations, hours)
//   - bio_materials                  (Person blocks per clinician with credentials)
//   - social_platforms               (sameAs)
//   - directory_listings (live/active/verified) (sameAs)
//   - tracked_keywords (active)      (knowsAbout)
//   - the page row itself            (page_type, target_url, page_slug, page_name, faqs)
//
// FAQPage schema is generated on the fly from page.faqs when present.
// We do not store FAQPage in schema_jsonb — it gets emitted at render time
// from page.faqs directly so it always reflects current FAQ content.
//
// POST body: { content_page_id }
// Auth: requireAdminOrInternal (admin JWT, CRON_SECRET, or AGENT_API_KEY).

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var schemaBuilder = require('../_lib/schema-builder');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};
  var pageId = body.content_page_id;
  if (!pageId) return res.status(400).json({ error: 'content_page_id required' });

  try {
    // 1. Load the page row.
    var page = await sb.one('content_pages?id=eq.' + encodeURIComponent(pageId) + '&limit=1');
    if (!page) return res.status(404).json({ error: 'Content page not found' });

    var contactId = page.contact_id;
    if (!contactId) return res.status(400).json({ error: 'Page has no contact_id' });

    // 2. Fan-out fetch in parallel.
    var results = await Promise.all([
      sb.one('contacts?id=eq.' + contactId + '&limit=1'),
      sb.one('practice_details?contact_id=eq.' + contactId + '&limit=1'),
      sb.query('bio_materials?contact_id=eq.' + contactId + '&order=is_primary.desc,sort_order.asc'),
      sb.query('social_platforms?contact_id=eq.' + contactId),
      sb.query('directory_listings?contact_id=eq.' + contactId),
      sb.query('tracked_keywords?contact_id=eq.' + contactId + '&active=eq.true&retired_at=is.null&order=priority.asc')
    ]);

    var contact = results[0];
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    var client = {
      contact: contact,
      practice: results[1] || {},
      bios: results[2] || [],
      social_platforms: results[3] || [],
      directory_listings: results[4] || [],
      tracked_keywords: results[5] || []
    };

    // 3. Build. schemaRecs is null here — we generate the full standard set
    //    regardless of Surge recommendations. Service blocks are emitted when
    //    practice.modalities is non-empty (schema-builder treats null
    //    schemaRecs as "no Service block"; we handle that downstream).
    //
    //    We pass a fake schemaRecs that opts into Service + FAQPage so the
    //    builder includes them when source data exists.
    var schemaRecs = {
      blocks: [
        { parsed: { '@type': 'Service' } },
        { parsed: { '@type': 'FAQPage' } }
      ]
    };

    var blocks = schemaBuilder.build(client, schemaRecs, page);
    var placeholders = schemaBuilder.detectPlaceholders(blocks);

    // 4. Write back. schema_jsonb stores the array of blocks; render layer
    //    iterates and emits each as <script type="application/ld+json">.
    await sb.mutate(
      'content_pages?id=eq.' + encodeURIComponent(pageId),
      'PATCH',
      { schema_jsonb: blocks },
      'return=minimal'
    );

    return res.json({
      success: true,
      content_page_id: pageId,
      block_count: blocks.length,
      types: blocks.map(function(b) { return b['@type']; }),
      placeholders: placeholders,
      sources: {
        bios: client.bios.length,
        socials: client.social_platforms.length,
        directories: client.directory_listings.length,
        keywords: client.tracked_keywords.length
      }
    });
  } catch (err) {
    await monitor.logError('admin/build-page-schema', err, { detail: { content_page_id: pageId } });
    return res.status(500).json({ error: 'Failed to build schema' });
  }
};
