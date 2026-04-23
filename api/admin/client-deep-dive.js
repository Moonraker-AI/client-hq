// api/admin/client-deep-dive.js
// FE-H2 extras. Consolidated admin-gated read of all per-client deep-dive
// data that the admin/clients/index.html page currently fetches against the
// anon PostgREST key across ~22 separate requests.
//
// Naming note:
//   `api/admin/client-detail.js` already exists as the overview-tab
//   aggregator (contact + tabCounts + entity audit + practice + guarantee
//   + bio materials + all-contacts dropdown). This endpoint is the sister
//   route that returns the wider surface of related tables used by the
//   other deep-dive tabs. Kept as a separate file rather than extending
//   client-detail.js to avoid changing that endpoint's response shape and
//   breaking the existing callers.
//
// Method:   GET   (405 otherwise, with Allow header)
// Auth:     requireAdmin
// Query:    ?slug=<string>    OR   ?contact_id=<uuid>    (one required)
// Returns:  200 {
//             contact,
//             audit_followups,
//             client_sites,
//             report_configs,
//             tracked_keywords,
//             content_pages,
//             intro_call_steps,
//             content_audit_batches,
//             entity_audits,
//             cms_scouts,
//             design_specs,
//             deliverables,
//             report_snapshots,
//             sitemap_scouts
//           }
//           400  missing slug/contact_id
//           404  { error: 'Client not found' }
//           500  generic
//
// All per-table reads go through sb.query with encodeURIComponent on any
// interpolated identifier. No user-provided operators ever reach the URL —
// every filter is a hardcoded operator ('eq.', 'in.', 'is.', 'order=...')
// against a trusted column name, so pgFilter.buildFilter is not required
// (the helper is for filter construction FROM admin input; here the admin
// input is limited to an identifier that is wrapped in encodeURIComponent).
//
// No pagination: each child table is bounded by the contact itself. The one
// unbounded list, tracked_keywords, is filtered to active + not-retired
// which matches the existing page behavior.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var slug = (req.query.slug || '').trim();
  var contactIdIn = (req.query.contact_id || '').trim();

  if (!slug && !contactIdIn) {
    return res.status(400).json({ error: 'slug or contact_id required' });
  }

  // ── Resolve contact ───────────────────────────────────────────────
  var contact;
  try {
    if (contactIdIn) {
      var rows = await sb.query(
        'contacts?id=eq.' + encodeURIComponent(contactIdIn) + '&select=*&limit=1'
      );
      contact = (rows && rows[0]) || null;
    } else {
      var rows2 = await sb.query(
        'contacts?slug=eq.' + encodeURIComponent(slug) + '&select=*&limit=1'
      );
      contact = (rows2 && rows2[0]) || null;
    }
  } catch (err) {
    await monitor.logError('admin-client-deep-dive', err, {
      detail: { stage: 'resolve_contact', slug: slug, contact_id_hint: contactIdIn ? 'yes' : 'no' }
    });
    return res.status(500).json({ error: 'Failed to load client detail' });
  }

  if (!contact) {
    return res.status(404).json({ error: 'Client not found' });
  }

  var cid = encodeURIComponent(contact.id);
  var cslug = encodeURIComponent(contact.slug || '');

  // ── Parallel child reads ──────────────────────────────────────────
  // Every filter uses a hardcoded operator against a known column; the
  // only interpolated values are contact.id and contact.slug coming from
  // the row we just fetched (trusted). They're still encodeURIComponent'd
  // for defense-in-depth.
  try {
    var results = await Promise.all([
      // audit_followups — joined through entity_audits.contact_id.
      // Cheaper than a separate latest-audit lookup: in. gathers every audit
      // the contact has ever had, the admin UI filters to current one.
      sb.query(
        'audit_followups?select=*&audit_id=in.(' +
        'select id from entity_audits where contact_id=eq.' + cid +
        ')&order=sequence_number.asc'
      ).catch(function() {
        // PostgREST doesn't support inline subqueries via REST; fall back to
        // a two-step fetch below if this path returns a 4xx.
        return null;
      }),

      sb.query('client_sites?contact_id=eq.' + cid + '&select=*&order=created_at.desc&limit=50'),

      sb.query('report_configs?client_slug=eq.' + cslug + '&select=*&limit=5'),

      sb.query(
        'tracked_keywords?client_slug=eq.' + cslug +
        '&active=eq.true&retired_at=is.null' +
        '&select=*&order=priority.asc,keyword.asc'
      ),

      sb.query('content_pages?contact_id=eq.' + cid + '&select=*&order=created_at.desc'),

      sb.query('intro_call_steps?contact_id=eq.' + cid + '&select=*&order=sort_order'),

      sb.query('content_audit_batches?client_slug=eq.' + cslug + '&select=*&order=created_at.desc&limit=5'),

      sb.query('entity_audits?contact_id=eq.' + cid + '&select=*&order=created_at.desc&limit=20'),

      sb.query(
        'cms_scouts?client_slug=eq.' + cslug +
        '&select=id,status,summary,platform,scanned_at,report,created_at' +
        '&order=created_at.desc&limit=5'
      ),

      sb.query('design_specs?contact_id=eq.' + cid + '&select=*&limit=1'),

      sb.query('deliverables?contact_id=eq.' + cid + '&select=*&order=created_at.desc'),

      sb.query('report_snapshots?client_slug=eq.' + cslug + '&select=*&order=report_month.desc&limit=20'),

      sb.query('sitemap_scouts?contact_id=eq.' + cid + '&select=*&order=created_at.desc&limit=5')
    ]);

    // Two-step fallback for audit_followups when the subquery form doesn't
    // come through. Most PostgREST deployments don't support 'in.(select ...)'
    // — the first slot will be null and we do the join client-side.
    var auditFollowups = results[0];
    if (auditFollowups === null) {
      var ea = results[7] || [];
      if (ea.length === 0) {
        auditFollowups = [];
      } else {
        var auditIds = ea.map(function(r) { return r.id; }).filter(Boolean);
        if (auditIds.length === 0) {
          auditFollowups = [];
        } else {
          auditFollowups = await sb.query(
            'audit_followups?audit_id=in.(' + auditIds.map(encodeURIComponent).join(',') +
            ')&select=*&order=sequence_number.asc'
          );
        }
      }
    }

    return res.status(200).json({
      contact: contact,
      audit_followups: auditFollowups || [],
      client_sites: results[1] || [],
      report_configs: results[2] || [],
      tracked_keywords: results[3] || [],
      content_pages: results[4] || [],
      intro_call_steps: results[5] || [],
      content_audit_batches: results[6] || [],
      entity_audits: results[7] || [],
      cms_scouts: results[8] || [],
      design_specs: (results[9] && results[9][0]) || null,
      deliverables: results[10] || [],
      report_snapshots: results[11] || [],
      sitemap_scouts: results[12] || []
    });
  } catch (err) {
    await monitor.logError('admin-client-deep-dive', err, {
      detail: { stage: 'child_reads', contact_id: contact.id, slug: contact.slug }
    });
    return res.status(500).json({ error: 'Failed to load client detail' });
  }
};
