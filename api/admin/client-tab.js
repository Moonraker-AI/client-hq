// api/admin/client-tab.js
// Server-side aggregation for client deep-dive tab data.
// Proxies tab-specific queries through the service role (no RLS overhead).
// Supports pagination via limit/offset for large datasets.
//
// Query params:
//   slug    - client slug (required)
//   tab     - tab name (required)
//   limit   - max rows for paginated tables (default varies by tab)
//   offset  - pagination offset (default 0)

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var slug = req.query.slug;
  var tab = req.query.tab;
  if (!slug || !tab) return res.status(400).json({ error: 'slug and tab parameters required' });

  var limit = Math.min(parseInt(req.query.limit) || 100, 500);
  var offset = parseInt(req.query.offset) || 0;

  try {
    // Get contact_id from slug
    var contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id&limit=1');
    if (!contact) return res.status(404).json({ error: 'Client not found' });

    var cid = contact.id;
    var s = encodeURIComponent(slug);
    var data = {};

    switch (tab) {
      case 'proposals': {
        var proposals = await sb.query('proposals?select=*&contact_id=eq.' + cid + '&order=created_at.desc');
        data.proposals = proposals || [];
        // Load followups if there are proposals
        if (data.proposals.length > 0) {
          var pids = data.proposals.map(function(p) { return p.id; }).join(',');
          data.followups = await sb.query('proposal_followups?proposal_id=in.(' + pids + ')&order=sequence_number.asc');
        } else {
          data.followups = [];
        }
        break;
      }

      case 'onboarding': {
        var results = await Promise.all([
          sb.query('onboarding_steps?select=*&order=sort_order&contact_id=eq.' + cid),
          sb.query('signed_agreements?select=*&contact_id=eq.' + cid + '&limit=1')
        ]);
        data.onboarding = results[0] || [];
        data.agreement = (results[1] && results[1][0]) || null;
        break;
      }

      case 'intro-call': {
        data.steps = await sb.query('intro_call_steps?select=*&order=sort_order&contact_id=eq.' + cid);
        break;
      }

      case 'rising-tide': {
        var results = await Promise.all([
          sb.query('social_platforms?select=*&contact_id=eq.' + cid + '&order=platform'),
          sb.query('directory_listings?select=*&contact_id=eq.' + cid + '&order=directory&limit=' + limit + '&offset=' + offset)
        ]);
        data.socialPlatforms = results[0] || [];
        data.directoryListings = results[1] || [];
        break;
      }

      case 'deliverables': {
        var results = await Promise.all([
          sb.query('deliverables?select=*&order=created_at.desc&contact_id=eq.' + cid + '&limit=' + limit + '&offset=' + offset),
          sb.query('tracked_keywords?select=id,keyword&client_slug=eq.' + s + '&active=eq.true')
        ]);
        data.deliverables = results[0] || [];
        data.keywords = results[1] || [];
        break;
      }

      case 'content': {
        var results = await Promise.all([
          sb.query('content_pages?select=*&contact_id=eq.' + cid + '&order=created_at.desc&limit=' + limit + '&offset=' + offset),
          sb.query('design_specs?select=*&contact_id=eq.' + cid + '&limit=1'),
          sb.query('neo_images?select=*&contact_id=eq.' + cid + '&order=created_at.desc&limit=20'),
          sb.query('endorsements?select=*&contact_id=eq.' + cid + '&order=created_at.desc&limit=50'),
          sb.query('content_audit_batches?select=*&client_slug=eq.' + s + '&order=created_at.desc&limit=5'),
          sb.query('tracked_keywords?select=*&client_slug=eq.' + s + '&active=eq.true&order=keyword.asc'),
          sb.query('bio_materials?select=*&contact_id=eq.' + cid + '&order=sort_order,is_primary.desc')
        ]);
        data.contentPages = results[0] || [];
        data.designSpec = (results[1] && results[1][0]) || null;
        data.neoImages = results[2] || [];
        data.endorsements = results[3] || [];
        data.auditBatches = results[4] || [];
        data.keywords = results[5] || [];
        data.bioMaterials = results[6] || [];
        break;
      }

      case 'audit': {
        var results = await Promise.all([
          sb.query('entity_audits?select=id,contact_id,client_slug,status,audit_tier,audit_date,audit_period,audit_scope,score_credibility,score_optimization,score_reputation,score_engagement,variance_score,variance_label,cres_score&contact_id=eq.' + cid + '&order=audit_date.desc'),
          sb.query('checklist_items?select=*&client_slug=eq.' + s + '&order=sort_order&limit=' + limit + '&offset=' + offset)
        ]);
        data.audits = results[0] || [];
        data.checklistItems = results[1] || [];
        break;
      }

      case 'reports': {
        var results = await Promise.all([
          sb.query('report_configs?select=*&client_slug=eq.' + s + '&limit=1'),
          sb.query('report_snapshots?select=*&client_slug=eq.' + s + '&order=report_month.desc&limit=20'),
          sb.query('tracked_keywords?select=id,keyword,keyword_type,priority&client_slug=eq.' + s + '&active=eq.true&retired_at=is.null&order=priority.asc,keyword.asc')
        ]);
        data.config = (results[0] && results[0][0]) || null;
        data.snapshots = results[1] || [];
        data.keywords = results[2] || [];
        break;
      }

      case 'attribution': {
        // Pull all periods for this contact, then all sources linked to
        // those periods in a second query. Downstream pullAttribution()
        // in api/campaign-summary.js uses the same shape.
        // Also include the sheet-sync config from report_configs so the UI
        // can render the Connected-Sheet card.
        var results = await Promise.all([
          sb.query(
            'client_attribution_periods?select=*&contact_id=eq.' + cid
            + '&order=period_start.asc'
          ),
          sb.query(
            'report_configs?select=attribution_sync&client_slug=eq.' + s + '&limit=1'
          )
        ]);
        var periods = results[0] || [];
        var syncConfigRow = (results[1] && results[1][0]) || null;
        var sources = [];
        if (periods.length > 0) {
          var pids = periods.map(function(p) { return p.id; }).join(',');
          sources = await sb.query(
            'client_attribution_sources?select=*&period_id=in.(' + pids + ')'
            + '&order=created_at.asc'
          );
        }
        data.periods = periods;
        data.sources = sources || [];
        data.syncConfig = (syncConfigRow && syncConfigRow.attribution_sync) || null;
        break;
      }

      default:
        return res.status(400).json({ error: 'Unknown tab: ' + tab });
    }

    res.status(200).json(data);
  } catch (e) {
    console.error('[client-tab] Error loading tab=' + tab + ' slug=' + slug + ':', e.message);
    res.status(500).json({ error: 'Failed to load tab data' });
  }
};

