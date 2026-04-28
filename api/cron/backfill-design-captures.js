// api/cron/backfill-design-captures.js
// Periodic cron — picks N active/onboarding clients with no design_specs row
// and triggers a capture for each. The agent serializes Playwright work
// internally, so the cron just dispatches and returns. Each dispatch creates
// a design_specs row with capture_status='capturing'; the agent's callback
// fills in screenshots + tokens via /api/ingest-design-assets, which also
// chains analyze-design-spec inline.
//
// Vercel cron config (in vercel.json):
//   "path":     "/api/cron/backfill-design-captures"
//   "schedule": "*/30 * * * *"   # every 30 min
//
// At BATCH=3/run × 48 runs/day = 144 captures/day, the ~85-client backlog
// completes inside ~24h. BATCH is overridable via BACKFILL_DESIGN_BATCH_SIZE.
//
// Once the backlog drains, the cron is a no-op for new captures (no contact
// without a design_specs row) but still cheap to run — leave it scheduled
// so newly-onboarded clients get auto-captured without operator action.
//
// Auth: Vercel sends Authorization: Bearer <CRON_SECRET>.
// requireAdminOrInternal accepts CRON_SECRET as an internal caller.

var auth = require('../_lib/auth');
var monitor = require('../_lib/monitor');
var cronRuns = require('../_lib/cron-runs');
var sb = require('../_lib/supabase');
var triggerDesignCapture = require('../trigger-design-capture');

var DEFAULT_BATCH = 3;

function parseBatch() {
  var raw = process.env.BACKFILL_DESIGN_BATCH_SIZE;
  if (!raw) return DEFAULT_BATCH;
  var n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH;
  return Math.min(n, 10);
}

// Cutoff for "partial pre-fix re-pick": rows captured before this timestamp
// that didn't get a full 3-page capture are eligible to re-run on the
// updated agent code (page.url-based discovery for redirected hosts).
// Set to the moment the discover_pages fix shipped to /opt/moonraker-agent.
// Once a row's updated_at advances past this (i.e. it re-ran with the new
// code), it's no longer eligible — single-page sites don't loop forever.
var DISCOVERY_FIX_CUTOFF = process.env.DESIGN_BACKFILL_FIX_CUTOFF
  || '2026-04-28T07:50:00Z';

async function pickContacts(limit) {
  // Treat a design_specs row as "good" (skip re-pick) when:
  //   - it captured >= 3 pages (or pages_succeeded is null = legacy pre-honest-status row), AND
  //   - it isn't in a failed/partial state
  // OR
  //   - it was captured/updated AFTER the discovery fix (regardless of result).
  //
  // Anything else (pre-fix partial, pre-fix failed, pre-fix complete-but-1-page)
  // is eligible to be picked again. Contacts with no row at all are also picked.
  var specs = await sb.query(
    'design_specs?select=contact_id,pages_succeeded,capture_status,updated_at&limit=10000'
  );
  var taken = (specs || []).filter(function(s) {
    if (!s.contact_id) return false;
    var postFix = s.updated_at && s.updated_at >= DISCOVERY_FIX_CUTOFF;
    if (postFix) return true;  // already retried under new code; don't loop
    var failedish = s.capture_status === 'failed'
      || s.capture_status === 'error'
      || s.capture_status === 'partial';
    if (failedish) return false;  // pre-fix partial/failed -> retry
    // pages_succeeded is text[]; legacy rows are NULL — treat NULL as
    // "we don't know, leave it alone" so we don't churn old completes.
    var succ = s.pages_succeeded;
    var succLen = Array.isArray(succ) ? succ.length : null;
    if (succLen === null) return true;  // legacy row, no length info -> skip
    return succLen >= 3;  // < 3 means SQ-redirect-style discovery miss
  }).map(function(s) { return s.contact_id; });

  var path = 'contacts?select=id,slug,website_url'
    + '&status=in.(active,onboarding)'
    + '&lost=is.false'
    + '&website_url=not.is.null'
    + '&order=created_at.asc'
    + '&limit=' + limit;
  if (taken.length > 0) {
    // PostgREST `not.in` expects parens around the comma-list.
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

  await triggerDesignCapture(syntheticReq, syntheticRes);

  if (captured.status === 200 && captured.body && captured.body.success) {
    return { ok: true, slug: contact.slug, task_id: captured.body.task_id };
  }
  return {
    ok: false,
    slug: contact.slug,
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
    monitor.logError('backfill-design-captures', err, { detail: { stage: 'pick' } });
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
      monitor.logError('backfill-design-captures', err, {
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

module.exports = cronRuns.withTracking('backfill-design-captures', handler);
