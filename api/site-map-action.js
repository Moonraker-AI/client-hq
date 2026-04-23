/**
 * /api/site-map-action.js
 *
 * Scoped write endpoint for the site map configurator. Handles the small,
 * bounded set of edits the configurator UI is allowed to make on
 * site_maps and site_map_pages.
 *
 * Auth: admin JWT OR page-token scoped to the configurator (phase 3 will
 * mint a page-token for the client-facing configurator embedded in the
 * onboarding flow). For now admin-only is acceptable.
 *
 * POST body:
 *   { action: 'set_page_status',  site_map_id, page_id, status }
 *   { action: 'rename_page',      site_map_id, page_id, title, notes? }
 *   { action: 'reorder_pages',    site_map_id, category, page_ids: [...] }
 *   { action: 'add_page',         site_map_id, category, title, notes?, url? }
 *   { action: 'delete_page',      site_map_id, page_id }
 *
 * Plan limits are enforced server-side per site_maps.source_type:
 *   core_existing: 1 home, <=5 services, <=2 locations, 1 FAQ, 10 bios
 *   core_new:      1 home, <=5 services, 1 location, 1 FAQ, 10 bios, 1 contact (10-page base)
 *   standalone:    same shape as core_new but with per-page pricing
 *
 * All writes go through sb (service role key, bypasses RLS). Identity (i.e.
 * which contact's data this touches) is derived from site_maps.contact_id,
 * never from the request body — caller can't pivot across tenants.
 */

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var fetchT = require('./_lib/fetch-with-timeout');

// ── Validation helpers ───────────────────────────────────────────────────

var VALID_CATEGORIES = [
  'home', 'service', 'location', 'bio', 'blog_index', 'blog_post',
  'faq', 'contact', 'about', 'testimonials', 'fees', 'careers', 'store',
  'services_index', 'legal_privacy', 'legal_terms', 'legal_other', 'other'
];

var VALID_PAGE_STATUSES = [
  'discovered', 'existing_keep', 'existing_update', 'existing_remove', 'new', 'drafting'
];

// Plan limits by source_type + category. Only categories listed are capped.
// Categories absent from a plan's map are unlimited (e.g. blog_post).
// Enforced on add_page (and status transitions that would cross the cap).
var PLAN_LIMITS = {
  core_existing: { home: 1, service: 5, location: 2, faq: 1, bio: 10, contact: 1 },
  core_new:      { home: 1, service: 5, location: 1, faq: 1, bio: 10, contact: 1 },
  standalone:    { home: 1, service: 5, location: 1, faq: 1, bio: 10, contact: 1 }
};

// Actions that reduce the active page count (existing_remove takes a page
// out of the "active" set for cap purposes, same as delete).
var REMOVED_STATUSES = ['existing_remove'];
// Pages that count toward the plan cap. The cap is a "highlight target" —
// discovered pages are inventory awaiting triage and don't count. Once a page
// is committed to keep/update/draft/new it enters the highlighted set and
// counts against the cap.
var HIGHLIGHTED_STATUSES = ['existing_keep', 'existing_update', 'new', 'drafting'];

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Text sanitizer — we don't accept HTML for any field; all fields are plain
// text rendered with textContent / escaping in the templates.
function sanitizeText(s, maxLen) {
  if (s === null || s === undefined) return null;
  var str = String(s).trim();
  if (!str) return null;
  return str.slice(0, maxLen || 500);
}

// Slugify a title into a URL path segment. Mirrors the client-side preview
// in admin/site-map/index.html so server and client agree on the auto-URL.
function slugifyTitle(title) {
  if (!title) return null;
  var s = String(title).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s ? '/' + s.slice(0, 80) : null;
}

// Count "highlighted" pages in a category — these count toward the plan cap.
// Discovered pages are excluded (they're inventory) and removed pages are
// excluded (they won't ship).
async function countHighlightedInCategory(siteMapId, category) {
  var rows = await sb.query(
    'site_map_pages?site_map_id=eq.' + siteMapId
    + '&category=eq.' + encodeURIComponent(category)
    + '&status=in.(' + HIGHLIGHTED_STATUSES.join(',') + ')'
    + '&select=id'
  );
  return Array.isArray(rows) ? rows.length : 0;
}

// ── Action handlers ──────────────────────────────────────────────────────

async function actionSetPageStatus(body, siteMap) {
  if (!isUuid(body.page_id)) return { error: 'page_id required', status: 400 };
  if (VALID_PAGE_STATUSES.indexOf(body.status) === -1) {
    return { error: 'Invalid status: ' + body.status, status: 400 };
  }

  var page = await sb.one(
    'site_map_pages?id=eq.' + body.page_id
    + '&site_map_id=eq.' + siteMap.id
    + '&select=id,category,status'
  );
  if (!page) return { error: 'Page not found', status: 404 };

  // No-op if status matches
  if (page.status === body.status) return { success: true, noop: true };

  // Cap is the "highlight target". A page enters the highlighted set when
  // moving to keep/update/draft/new from any other status. If this transition
  // would push the highlighted count past the cap, block it (the caller can
  // un-highlight another page first).
  var wasHighlighted = HIGHLIGHTED_STATUSES.indexOf(page.status) !== -1;
  var willBeHighlighted = HIGHLIGHTED_STATUSES.indexOf(body.status) !== -1;
  var cap = PLAN_LIMITS[siteMap.source_type] && PLAN_LIMITS[siteMap.source_type][page.category];
  if (cap && !wasHighlighted && willBeHighlighted) {
    var highlightedCount = await countHighlightedInCategory(siteMap.id, page.category);
    if (highlightedCount >= cap) {
      return {
        error: 'Already highlighting ' + cap + ' ' + page.category + ' page(s). Un-highlight one first or change the status to "Remove".',
        status: 409
      };
    }
  }

  await sb.mutate(
    'site_map_pages?id=eq.' + body.page_id,
    'PATCH',
    { status: body.status },
    'return=minimal'
  );
  return { success: true, page_id: body.page_id, new_status: body.status };
}

async function actionRenamePage(body, siteMap) {
  if (!isUuid(body.page_id)) return { error: 'page_id required', status: 400 };
  var title = sanitizeText(body.title, 300);
  if (!title) return { error: 'title required', status: 400 };

  var page = await sb.one(
    'site_map_pages?id=eq.' + body.page_id
    + '&site_map_id=eq.' + siteMap.id
    + '&select=id,category,url'
  );
  if (!page) return { error: 'Page not found', status: 404 };

  var patch = { title: title };
  if (body.notes !== undefined) patch.notes = sanitizeText(body.notes, 2000) || null;
  // Optional URL update — admin/client can propose a new URL for the page
  // (e.g. rewrite the slug to match the new SEO target). Empty string clears
  // it; omitted means "leave as-is".
  if (body.url !== undefined) {
    var newUrl = sanitizeText(body.url, 500);
    // If the value is just a slug (starts with /), or a full URL, accept it.
    // Empty or null => clear.
    patch.url = newUrl || null;
  }

  await sb.mutate(
    'site_map_pages?id=eq.' + body.page_id,
    'PATCH',
    patch,
    'return=minimal'
  );
  return { success: true, page_id: body.page_id };
}

async function actionReorderPages(body, siteMap) {
  if (!body.category || VALID_CATEGORIES.indexOf(body.category) === -1) {
    return { error: 'Invalid category', status: 400 };
  }
  if (!Array.isArray(body.page_ids) || body.page_ids.length === 0) {
    return { error: 'page_ids required (non-empty array)', status: 400 };
  }
  for (var i = 0; i < body.page_ids.length; i++) {
    if (!isUuid(body.page_ids[i])) return { error: 'page_ids must be UUIDs', status: 400 };
  }

  // Verify all ids belong to this site_map + category (prevents cross-tenant
  // reordering via forged ids).
  var pages = await sb.query(
    'site_map_pages?site_map_id=eq.' + siteMap.id
    + '&category=eq.' + encodeURIComponent(body.category)
    + '&select=id'
  );
  var validIds = {};
  (pages || []).forEach(function(p) { validIds[p.id] = true; });
  for (var j = 0; j < body.page_ids.length; j++) {
    if (!validIds[body.page_ids[j]]) {
      return { error: 'page_ids contain entries outside this site_map+category', status: 400 };
    }
  }

  // PATCH each one with its new display_order. PostgREST doesn't do bulk
  // PATCH-by-id, so we issue one call per page. Fine for small lists (cap=10
  // for bios, ~20 for blog posts at most — typical reorder touches 2-5 items).
  for (var k = 0; k < body.page_ids.length; k++) {
    await sb.mutate(
      'site_map_pages?id=eq.' + body.page_ids[k],
      'PATCH',
      { display_order: k },
      'return=minimal'
    );
  }
  return { success: true, category: body.category, count: body.page_ids.length };
}

async function actionAddPage(body, siteMap) {
  if (!body.category || VALID_CATEGORIES.indexOf(body.category) === -1) {
    return { error: 'Invalid category', status: 400 };
  }
  var title = sanitizeText(body.title, 300);
  if (!title) return { error: 'title required', status: 400 };
  var notes = sanitizeText(body.notes, 2000) || null;
  var url = sanitizeText(body.url, 500) || null;
  // Auto-generate URL path from title when caller didn't provide one. The
  // client also previews this so users see what the URL will look like.
  if (!url) url = slugifyTitle(title);

  // Plan cap enforcement — new pages enter as 'new' which IS in the
  // highlighted set, so they count immediately.
  var cap = PLAN_LIMITS[siteMap.source_type] && PLAN_LIMITS[siteMap.source_type][body.category];
  if (cap) {
    var highlightedCount = await countHighlightedInCategory(siteMap.id, body.category);
    if (highlightedCount >= cap) {
      return {
        error: 'Already highlighting ' + cap + ' ' + body.category + ' page(s). Remove one from your highlight set first.',
        status: 409
      };
    }
  }

  // Next display_order = current max + 1 in this category
  var existing = await sb.query(
    'site_map_pages?site_map_id=eq.' + siteMap.id
    + '&category=eq.' + encodeURIComponent(body.category)
    + '&select=display_order&order=display_order.desc&limit=1'
  );
  var nextOrder = (existing && existing[0] && typeof existing[0].display_order === 'number')
    ? existing[0].display_order + 1 : 0;

  // Bio page addition: also create a bio_materials placeholder and link it.
  // Idempotency: if caller passed url and a bio_materials row already exists
  // at that url for this contact, we link to the existing one.
  var bioMaterialId = null;
  if (body.category === 'bio') {
    // Double-check cap holds for bio specifically; existing bio_materials
    // may imply more bios than the configurator is aware of.
    var existingBioRows = await sb.query(
      'bio_materials?contact_id=eq.' + siteMap.contact_id
      + '&select=id,page_url,is_primary&order=sort_order'
    );
    existingBioRows = existingBioRows || [];

    var linked = null;
    if (url) {
      for (var b = 0; b < existingBioRows.length; b++) {
        if (existingBioRows[b].page_url === url) { linked = existingBioRows[b].id; break; }
      }
    }
    if (linked) {
      bioMaterialId = linked;
    } else {
      if (existingBioRows.length >= 10) {
        return { error: 'bio cap of 10 reached (bio_materials rows)', status: 409 };
      }
      var isPrimary = !existingBioRows.some(function(r) { return r.is_primary; });
      var bioResp = await sb.mutate('bio_materials', 'POST', {
        contact_id: siteMap.contact_id,
        is_primary: isPrimary,
        therapist_name: title, // seed name from the page title; intake overwrites
        page_url: url,
        sort_order: existingBioRows.length,
        status: 'pending'
      }, 'return=representation');
      var bioRow = Array.isArray(bioResp) ? bioResp[0] : bioResp;
      if (!bioRow || !bioRow.id) {
        return { error: 'failed to create bio_materials row', status: 500 };
      }
      bioMaterialId = bioRow.id;
    }
  }

  var pageResp = await sb.mutate('site_map_pages', 'POST', {
    site_map_id: siteMap.id,
    category: body.category,
    status: 'new',
    title: title,
    notes: notes,
    url: url,
    display_order: nextOrder,
    intake_status: (body.category === 'bio') ? 'intake_pending' : null,
    bio_material_id: bioMaterialId
  }, 'return=representation');
  var newPage = Array.isArray(pageResp) ? pageResp[0] : pageResp;

  return { success: true, page: newPage };
}

async function actionDeletePage(body, siteMap) {
  if (!isUuid(body.page_id)) return { error: 'page_id required', status: 400 };

  // Only allow deleting 'new' pages — existing (keep/update/remove) pages
  // should be marked existing_remove instead so the decision stays auditable.
  // Bios are special: deleting a bio page also deletes its bio_materials row
  // (which cascades nothing sensitive since bio_materials isn't FK'd anywhere
  // critical).
  var page = await sb.one(
    'site_map_pages?id=eq.' + body.page_id
    + '&site_map_id=eq.' + siteMap.id
    + '&select=id,category,status,bio_material_id'
  );
  if (!page) return { error: 'Page not found', status: 404 };
  if (page.status !== 'new') {
    return {
      error: 'Only pages with status=new can be deleted; mark existing pages as existing_remove instead',
      status: 409
    };
  }

  await sb.mutate(
    'site_map_pages?id=eq.' + body.page_id,
    'DELETE',
    null,
    'return=minimal'
  );
  // If this was a bio page and the bio_materials row was created for it
  // (pending status = never filled in), delete that too.
  if (page.category === 'bio' && page.bio_material_id) {
    try {
      var bioRow = await sb.one('bio_materials?id=eq.' + page.bio_material_id + '&select=status,therapist_name,professional_bio');
      if (bioRow && bioRow.status === 'pending' && !bioRow.therapist_name && !bioRow.professional_bio) {
        await sb.mutate('bio_materials?id=eq.' + page.bio_material_id, 'DELETE', null, 'return=minimal');
      }
    } catch (_) { /* swallow; leaving the bio_materials row isn't a bug */ }
  }

  return { success: true, page_id: body.page_id };
}

// ── Client onboarding review actions ────────────────────────────────────
//
// Client flow:
//   draft ──(client submit)──► client_submitted ──(admin approve)──► draft
// "Approve" flips the matching onboarding_steps row to complete.
// Admin may also reject by setting status back to draft with no step-flip
// (not a separate action — the admin configurator just edits normally).

async function actionSubmitForReview(body, siteMap) {
  // Gating: need at least 1 highlighted service + 1 highlighted location.
  // Checked server-side so a client can't flip this past the UI guard.
  var serviceCount = await countHighlightedInCategory(siteMap.id, 'service');
  var locationCount = await countHighlightedInCategory(siteMap.id, 'location');
  if (serviceCount < 1 || locationCount < 1) {
    return {
      error: 'Highlight at least 1 service and 1 location before submitting.',
      status: 409,
      blockers: { service: Math.max(0, 1 - serviceCount), location: Math.max(0, 1 - locationCount) }
    };
  }

  await sb.mutate(
    'site_maps?id=eq.' + siteMap.id,
    'PATCH',
    { status: 'client_submitted' },
    'return=minimal'
  );

  // Fire notify-team (non-blocking; don't fail submission if notify fails).
  try {
    var contact = await sb.one(
      'contacts?id=eq.' + siteMap.contact_id + '&select=slug&limit=1'
    );
    if (contact && contact.slug && process.env.CRON_SECRET) {
      // Fire-and-forget with short timeout. If notify-team is down the
      // submission still succeeds — admin can see client_submitted status
      // in the configurator regardless.
      fetchT('https://clients.moonraker.ai/api/notify-team', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.CRON_SECRET
        },
        body: JSON.stringify({ event: 'site_map_submitted', slug: contact.slug })
      }, 10000).catch(function(e) {
        console.error('[site-map-action] notify-team site_map_submitted failed:', e.message);
      });
    }
  } catch (e) {
    console.error('[site-map-action] submit_for_review notify lookup failed:', e.message);
  }

  return { success: true, status: 'client_submitted' };
}

async function actionApproveReview(body, siteMap) {
  // Admin-only. Flips site_map back to draft and marks the onboarding
  // site_map step complete so the wizard advances.
  if (siteMap.status !== 'client_submitted') {
    return {
      error: 'Cannot approve — site_map status is ' + siteMap.status + ' (expected client_submitted)',
      status: 409
    };
  }
  if (!siteMap.contact_id) {
    return { error: 'Cannot approve — site_map has no contact_id (standalone?)', status: 409 };
  }

  // Flip onboarding step before the site_map status change so, if the step
  // update fails, we don't silently leave the site_map in a confusing state.
  // The auto_promote_to_active trigger picks up the step->complete transition
  // automatically if this was the final step.
  await sb.mutate(
    'onboarding_steps?contact_id=eq.' + siteMap.contact_id + '&step_key=eq.site_map',
    'PATCH',
    { status: 'complete' },
    'return=minimal'
  );

  await sb.mutate(
    'site_maps?id=eq.' + siteMap.id,
    'PATCH',
    { status: 'draft' },
    'return=minimal'
  );

  return { success: true, status: 'draft', onboarding_step: 'complete' };
}

// ── Router ───────────────────────────────────────────────────────────────

var ACTIONS = {
  set_page_status: actionSetPageStatus,
  rename_page: actionRenamePage,
  reorder_pages: actionReorderPages,
  add_page: actionAddPage,
  delete_page: actionDeletePage,
  submit_for_review: actionSubmitForReview,
  approve_review: actionApproveReview
};

// Actions a page-token (client) caller may invoke. Admin callers can invoke
// any action. delete_page is already restricted at the handler level to
// status=new pages, which is the only safe client-editable surface.
var CLIENT_ALLOWED_ACTIONS = {
  set_page_status: true,
  rename_page: true,
  add_page: true,
  delete_page: true,
  submit_for_review: true
};

// Actions that remain available when the site_map is in client_submitted
// status (awaiting admin review). Everything else requires admin intervention
// — this is the "locked for review" window.
var ACTIONS_ALLOWED_WHILE_SUBMITTED = {
  approve_review: true
};

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth: admin JWT OR onboarding page-token ─────────────────────
  var isAdmin = false;
  var verifiedContactId = null;

  var clientTokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
  if (clientTokenStr) {
    var tokenData;
    try { tokenData = pageToken.verify(clientTokenStr, 'onboarding'); }
    catch (e) {
      console.error('[site-map-action] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
    verifiedContactId = tokenData.contact_id;
  } else {
    var user = await auth.requireAdmin(req, res);
    if (!user) return;
    isAdmin = true;
  }

  var body = req.body || {};
  if (!body.action || !ACTIONS[body.action]) {
    return res.status(400).json({ error: 'action required; valid: ' + Object.keys(ACTIONS).join(', ') });
  }
  if (!isAdmin && !CLIENT_ALLOWED_ACTIONS[body.action]) {
    return res.status(403).json({ error: 'Action not allowed for client caller' });
  }
  if (!isUuid(body.site_map_id)) {
    return res.status(400).json({ error: 'site_map_id required (uuid)' });
  }

  try {
    // Fetch site_map context once; locking guard applied here.
    var siteMap = await sb.one(
      'site_maps?id=eq.' + body.site_map_id
      + '&select=id,contact_id,anonymous_session_id,source_type,status'
    );
    if (!siteMap) return res.status(404).json({ error: 'site_map not found' });

    // Page-token callers must match the site_map's contact_id.
    if (!isAdmin && siteMap.contact_id !== verifiedContactId) {
      return res.status(403).json({ error: 'Not authorized for this site_map' });
    }

    // Client callers may NOT edit URLs — strip url from rename_page/add_page
    // so admin URL-rewrite remains an admin-only capability. Client can still
    // set a title; add_page auto-slugifies from title when url is absent.
    if (!isAdmin && body.url !== undefined) delete body.url;

    // Write-gate by site_map status:
    //  - draft: fully editable
    //  - client_submitted: only approve_review (admin)
    //  - mvp_locked / fully_locked / launched / abandoned: read-only
    if (siteMap.status === 'client_submitted') {
      if (!ACTIONS_ALLOWED_WHILE_SUBMITTED[body.action]) {
        return res.status(409).json({
          error: 'Site map is awaiting admin review. No edits until approved.',
          hint: 'Admin can approve via approve_review action'
        });
      }
      if (!isAdmin) {
        return res.status(403).json({ error: 'Client cannot modify a submitted site map' });
      }
    } else if (siteMap.status !== 'draft') {
      return res.status(409).json({
        error: 'site_map is ' + siteMap.status + ' and cannot be edited',
        hint: 'Only status=draft accepts edits'
      });
    }

    var result = await ACTIONS[body.action](body, siteMap);
    if (result && result.error) {
      return res.status(result.status || 400).json(result);
    }
    return res.json(result);

  } catch (err) {
    console.error('site-map-action error:', err);
    monitor.logError('site-map-action', err, {
      detail: { stage: 'action_dispatch', action: body.action, site_map_id: body.site_map_id }
    });
    return res.status(500).json({ error: 'Failed to execute action' });
  }
};
