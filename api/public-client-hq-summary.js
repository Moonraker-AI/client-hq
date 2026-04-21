// /api/public-client-hq-summary.js
// Consolidated read endpoint for the client router page (/<slug>/). Returns
// the contact plus the four related tables the router hydrates: onboarding
// steps, deliverables, entity audits (latest only), checklist items (status
// only). Service-role reads with per-table column allowlists, replacing the
// direct anon Supabase REST reads the router previously made.
//
// Precedent: /api/public-contact. Like that endpoint this is ungated — the
// slug is a public URL, and the response is strictly narrower than what
// /api/public-contact already returns. If public-contact gets gated later,
// gate this the same way at the same time.
//
// Request:   GET /api/public-client-hq-summary?slug=<slug>
// Response:  200 {
//              contact:          { ... safe columns ... },
//              onboarding_steps: [ { status, notes, step_key, label, sort_order } ],
//              deliverables:     [ { deliverable_type, page_url, title, delivered_at, status } ],
//              entity_audits:    [ { score_credibility, score_optimization, score_reputation, score_engagement, audit_date } ],
//              checklist_items:  [ { status } ]
//            }
//            404 { error: "contact not found" }
//            500 { error: "lookup failed" }

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var publicContact = require('./public-contact');

// Contact columns: reuse the canonical allowlist and add campaign_end, which
// the router template renders (campaign timeline "Month X of Y" block) but
// public-contact.js previously omitted — silent bug fixed in the same commit.
var CONTACT_COLUMNS = publicContact.SAFE_COLUMNS;

// Per-table column allowlists. Minimally what the router render functions
// touch — anything wider is surface area we don't need. If the template grows
// new fields, widen here deliberately.
var ONBOARDING_COLUMNS  = 'status,notes,step_key,label,sort_order';
var DELIVERABLE_COLUMNS = 'deliverable_type,page_url,title,delivered_at,status';
var AUDIT_COLUMNS       = 'score_credibility,score_optimization,score_reputation,score_engagement,audit_date';
var CHECKLIST_COLUMNS   = 'status';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

  var slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'valid slug required' });
  }

  // Step 1: resolve slug → contact row (service role, column-allowlisted).
  var contact;
  try {
    contact = await sb.one(
      'contacts?slug=eq.' + encodeURIComponent(slug) +
      '&select=' + CONTACT_COLUMNS +
      '&limit=1'
    );
  } catch (err) {
    await monitor.logError('public-client-hq-summary', err, {
      client_slug: slug,
      detail: { stage: 'contact_lookup' }
    });
    return res.status(500).json({ error: 'lookup failed' });
  }
  if (!contact) return res.status(404).json({ error: 'contact not found' });

  var contactId = contact.id;
  var encodedContactId = encodeURIComponent(contactId);
  var encodedSlug = encodeURIComponent(slug);

  // Step 2: fetch related tables in parallel. Promise.all is all-or-nothing —
  // if any query throws we 500 the whole response rather than serve a
  // partially-populated dashboard. A missing deliverables list with a full
  // onboarding list (or vice versa) would render a confusing, silently-broken
  // page; an honest 500 is the better failure mode.
  var onboardingSteps, deliverables, entityAudits, checklistItems;
  try {
    var results = await Promise.all([
      sb.query(
        'onboarding_steps?contact_id=eq.' + encodedContactId +
        '&select=' + ONBOARDING_COLUMNS +
        '&order=sort_order'
      ),
      sb.query(
        'deliverables?contact_id=eq.' + encodedContactId +
        '&select=' + DELIVERABLE_COLUMNS +
        '&order=delivered_at.desc'
      ),
      sb.query(
        'entity_audits?client_slug=eq.' + encodedSlug +
        '&select=' + AUDIT_COLUMNS +
        '&order=audit_date.desc&limit=1'
      ),
      sb.query(
        'checklist_items?client_slug=eq.' + encodedSlug +
        '&select=' + CHECKLIST_COLUMNS
      )
    ]);
    onboardingSteps = results[0] || [];
    deliverables    = results[1] || [];
    entityAudits    = results[2] || [];
    checklistItems  = results[3] || [];
  } catch (err) {
    await monitor.logError('public-client-hq-summary', err, {
      client_slug: slug,
      detail: { stage: 'related_tables', contact_id: contactId }
    });
    return res.status(500).json({ error: 'lookup failed' });
  }

  // Match /api/public-contact cache posture: short, URL-keyed so per-slug
  // responses are safe to share at the CDN edge. Trades 30s staleness for a
  // real speedup over the prior five-round-trip anon-REST path.
  res.setHeader('Cache-Control', 'public, max-age=30');
  return res.status(200).json({
    contact:          contact,
    onboarding_steps: onboardingSteps,
    deliverables:     deliverables,
    entity_audits:    entityAudits,
    checklist_items:  checklistItems
  });
};
