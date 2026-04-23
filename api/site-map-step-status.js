/**
 * /api/site-map-step-status.js
 *
 * Returns the gating state for the onboarding "site map" step for a given
 * client. Used by the wizard panel to show progress copy and enable the
 * "Submit for review" button. Also reflects whether the step is already
 * submitted or complete.
 *
 * GET ?slug=<slug>
 * Auth: admin JWT OR onboarding page-token (bound to own contact).
 *
 * Returns:
 *   {
 *     site_map: { id, status },              // null if no site_map yet
 *     onboarding_step_status: 'pending'|'in_progress'|'complete'|null,
 *     counts: { service: { highlighted, cap }, location: { highlighted, cap } },
 *     ready_to_submit: boolean,              // >= 1 service + 1 location
 *     blockers: { service: int, location: int }   // how many more needed
 *   }
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');

var PLAN_LIMITS = {
  core_existing: { service: 5, location: 2 },
  core_new:      { service: 5, location: 1 },
  standalone:    { service: 5, location: 1 }
};
var HIGHLIGHTED_STATUSES = ['existing_keep', 'existing_update', 'new', 'drafting'];

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Dual auth — same shape as site-map-get
  var isAdmin = false;
  var verifiedContactId = null;
  var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
  if (tokenStr) {
    var tokenData;
    try { tokenData = pageToken.verify(tokenStr, 'onboarding'); }
    catch (e) {
      console.error('[site-map-step-status] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
    verifiedContactId = tokenData.contact_id;
  } else {
    var user = await auth.requireAdmin(req, res);
    if (!user) return;
    isAdmin = true;
  }

  var slug = req.query && req.query.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'slug query param required' });
  }

  try {
    var contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!isAdmin && contact.id !== verifiedContactId) {
      return res.status(403).json({ error: 'Not authorized for this client' });
    }

    // Most recent non-abandoned site_map (if any). No site_map = step can't
    // be started yet (admin needs to adopt a scout or the scout hasn't run).
    var siteMap = await sb.one(
      'site_maps?contact_id=eq.' + contact.id
      + '&status=neq.abandoned&select=id,status,source_type&order=created_at.desc&limit=1'
    );

    var stepRow = await sb.one(
      'onboarding_steps?contact_id=eq.' + contact.id
      + '&step_key=eq.site_map&select=status&limit=1'
    );

    if (!siteMap) {
      return res.json({
        site_map: null,
        onboarding_step_status: stepRow ? stepRow.status : null,
        counts: { service: { highlighted: 0, cap: 5 }, location: { highlighted: 0, cap: 1 } },
        ready_to_submit: false,
        blockers: { service: 1, location: 1 },
        reason: 'no_site_map'
      });
    }

    // Count highlighted pages in service + location.
    var inList = HIGHLIGHTED_STATUSES.map(encodeURIComponent).join(',');
    var rows = await sb.query(
      'site_map_pages?site_map_id=eq.' + siteMap.id
      + '&status=in.(' + inList + ')'
      + '&category=in.(service,location)'
      + '&select=category'
    );
    rows = rows || [];
    var serviceHl = rows.filter(function(r) { return r.category === 'service'; }).length;
    var locationHl = rows.filter(function(r) { return r.category === 'location'; }).length;

    var caps = PLAN_LIMITS[siteMap.source_type] || PLAN_LIMITS.core_existing;
    var readyToSubmit = serviceHl >= 1 && locationHl >= 1;

    return res.json({
      site_map: { id: siteMap.id, status: siteMap.status },
      onboarding_step_status: stepRow ? stepRow.status : null,
      counts: {
        service:  { highlighted: serviceHl, cap: caps.service },
        location: { highlighted: locationHl, cap: caps.location }
      },
      ready_to_submit: readyToSubmit,
      blockers: {
        service:  Math.max(0, 1 - serviceHl),
        location: Math.max(0, 1 - locationHl)
      }
    });

  } catch (err) {
    console.error('site-map-step-status error:', err);
    monitor.logError('site-map-step-status', err, { client_slug: slug });
    return res.status(500).json({ error: 'Failed to load step status' });
  }
};
