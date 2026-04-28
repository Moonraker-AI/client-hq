// api/cron/backfill-cms-scouts.js
// Periodic cron — picks N active/onboarding WP/SQ/Wix clients with no
// cms_scouts row and triggers a platform-appropriate scout for each.
// Mirrors backfill-design-captures but for the operational metadata layer
// (theme, plugins, page builder, pages list, navigation, SEO state).
//
// Vercel cron config (in vercel.json):
//   "path":     "/api/cron/backfill-cms-scouts"
//   "schedule": "*/30 * * * *"   # every 30 min
//
// Eligibility: status in (active, onboarding), lost=false, website_url set,
// website_platform in (wordpress, squarespace, wix). Other platforms
// (simplepractice, webflow, etc.) are skipped — trigger-cms-scout 400s on
// them, no point dispatching.
//
// At BATCH=3/run × 48 runs/day = 144 scouts/day, the backlog drains in
// roughly a day. After drain, no-op until a new WP/SQ/Wix client is
// onboarded; then auto-scouts within 30min.
//
// Auth: Vercel sends Authorization: Bearer <CRON_SECRET>; the upstream
// trigger-cms-scout was loosened to requireAdminOrInternal in the same
// commit so the synthetic in-process invoke clears auth.

var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');
var sb = require('../_lib/supabase');
var triggerCmsScout = require('../trigger-cms-scout');

var DEFAULT_BATCH = 3;
var SUPPORTED_PLATFORMS = ['wordpress', 'squarespace', 'wix'];

function parseBatch() {
  var raw = process.env.BACKFILL_CMS_SCOUT_BATCH_SIZE;
  if (!raw) return DEFAULT_BATCH;
  var n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH;
  return Math.min(n, 10);
}

async function pickContacts(limit) {
  // Two queries: list contact_ids that already have any cms_scouts row,
  // then ask for active/onboarding WP/SQ/Wix contacts NOT in that list.
  var scouts = await sb.query('cms_scouts?select=contact_id&limit=10000');
  var taken = (scouts || []).map(function(r) { return r.contact_id; }).filter(Boolean);

  var path = 'contacts?select=id,slug,website_platform,website_url'
    + '&status=in.(active,onboarding)'
    + '&lost=is.false'
    + '&website_url=not.is.null'
    + '&website_platform=in.(' + SUPPORTED_PLATFORMS.join(',') + ')'
    + '&order=created_at.asc'
    + '&limit=' + limit;
  if (taken.length > 0) {
    path += '&id=not.in.(' + taken.map(encodeURIComponent).join(',') + ')';
  }
  return await sb.query(path);
}

async function dispatchOne(contact) {
  var captured = { status: 200, body: null };
  var syntheticReq = {
    method: 'POST',
    headers: { authorization: 'Bearer ' + (process.env.CRON_SECRET || '') },
    body: { contact_id: contact.id },
    query: {},
    cookies: {}
  };
  var syntheticRes = {
    status: function(c) { captured.status = c; return syntheticRes; },
    setHeader: function() { return syntheticRes; },
    json: function(b) { captured.body = b; return syntheticRes; },
    send: function(b) { captured.body = b; return syntheticRes; },
    end: function(b) { if (b != null) captured.body = b; return syntheticRes; }
  };

  await triggerCmsScout(syntheticReq, syntheticRes);

  if (captured.status === 200 && captured.body && captured.body.success) {
    return {
      ok: true,
      slug: contact.slug,
      platform: captured.body.platform,
      task_id: captured.body.task_id
    };
  }
  return {
    ok: false,
    slug: contact.slug,
    platform: contact.website_platform,
    status: captured.status,
    error: (captured.body && (captured.body.error || captured.body.detail)) || ('http ' + captured.status)
  };
}

async function handler(req, res) {
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }
  if (!process.env.AGENT_SERVICE_URL || !process.env.AGENT_API_KEY) {
    return res.status(500).json({ error: 'Agent service not configured' });
  }

  var batch = parseBatch();
  var contacts;
  try {
    contacts = await pickContacts(batch);
  } catch (err) {
    monitor.logError('backfill-cms-scouts', err, { detail: { stage: 'pick' } });
    return res.status(500).json({ error: 'Failed to pick contacts' });
  }

  if (!contacts || contacts.length === 0) {
    return res.status(200).json({
      success: true,
      message: 'No contacts to backfill',
      processed: 0,
      batch_size: batch
    });
  }

  var results = [];
  for (var i = 0; i < contacts.length; i++) {
    try {
      results.push(await dispatchOne(contacts[i]));
    } catch (err) {
      monitor.logError('backfill-cms-scouts', err, {
        detail: { stage: 'dispatch', slug: contacts[i].slug, contact_id: contacts[i].id }
      });
      results.push({ ok: false, slug: contacts[i].slug, error: (err && err.message) || 'dispatch threw' });
    }
  }

  var dispatched = results.filter(function(r) { return r.ok; }).length;
  var failed = results.length - dispatched;

  return res.status(200).json({
    success: true,
    processed: results.length,
    dispatched: dispatched,
    failed: failed,
    batch_size: batch,
    results: results
  });
}

module.exports = cronRuns.withTracking('backfill-cms-scouts', handler);
