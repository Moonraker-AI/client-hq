// /api/lock-guarantee.js
// Admin action: lock in a Performance Guarantee after the intro-call numbers
// are finalized. Flips performance_guarantees.status from 'draft' to 'locked'.
//
// Scope boundary (3.4 build):
//   This endpoint performs the status flip + deploys the client-facing
//   /<slug>/guarantee/index.html signing page. The "ready to sign" client
//   email is deferred to 3.5 — we don't want to email a link to a page
//   whose submit button 404s. Email-send stub is marked // TODO (3.5) below.
//
// Security:
//   - Admin JWT only (auth.requireAdmin — no internal/agent access).
//   - Verified slug lookup; status flip bound to the contact matched by that
//     slug, not by any ID in the body.
//
// Idempotency:
//   - Already-locked guarantees return 200 with { already_locked: true }. No
//     second state change, no follow-on side effects.
//
// Guardrails:
//   - Contact must be annual tier (plan_tier='annual' or legacy
//     plan_type='annual'). 400 on anything else.
//   - Draft must have all benchmark fields populated. 400 with a list of
//     missing fields otherwise.
//   - lost=true contacts are rejected.

var auth    = require('./_lib/auth');
var sb      = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var gh      = require('./_lib/github');

var REQUIRED_FIELDS = [
  'avg_client_ltv_cents',
  'conversion_rate',
  'attendance_rate',
  'investment_cents',
  'value_per_call_cents',
  'guarantee_calls',
  'total_benchmark'
];

// Deploy the signing page to {slug}/guarantee/index.html. Idempotent —
// callers may invoke this on first-lock-in OR on a retry-lock (already-
// locked branch) so a prior failed deploy can be recovered without any DB
// state change.
async function deployGuaranteePage(slug) {
  if (!gh.isConfigured()) {
    return { deployed: false, commit: null, error: 'github_not_configured' };
  }
  try {
    var html = await gh.readTemplate('guarantee.html');
    var result = await gh.pushFile(
      slug + '/guarantee/index.html',
      html,
      'Deploy Performance Guarantee signing page for ' + slug
    );
    return { deployed: true, commit: result && result.commit ? String(result.commit).substring(0, 8) : null, error: null };
  } catch (err) {
    return { deployed: false, commit: null, error: (err && err.message) || 'unknown' };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured())      return res.status(500).json({ error: 'Service not configured' });

  // ── Admin gate ───────────────────────────────────────────────
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var slug = String(body.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Valid slug required' });
  }

  try {
    // 1. Load contact
    var contact = await sb.one(
      'contacts?select=id,slug,email,first_name,last_name,plan_tier,plan_type,status,lost' +
      '&slug=eq.' + encodeURIComponent(slug) + '&limit=1'
    );
    if (!contact)                                 return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost)                             return res.status(403).json({ error: 'Contact is no longer active' });

    // 2. Annual-only
    var isAnnual = (contact.plan_tier === 'annual') || (contact.plan_type === 'annual');
    if (!isAnnual) {
      return res.status(400).json({
        error: 'Lock-in is only available for annual plans',
        detail: 'Current plan: ' + (contact.plan_tier || contact.plan_type || 'none')
      });
    }

    // 3. Load the draft
    var pg = await sb.one(
      'performance_guarantees?select=*&contact_id=eq.' +
      encodeURIComponent(contact.id) + '&limit=1'
    );
    if (!pg) {
      return res.status(400).json({
        error: 'No Performance Guarantee draft exists for this client yet.'
      });
    }

    // 4. Idempotent: already locked. We still re-deploy the signing page so a
    //    retry after a failed first deploy lands a working page.
    if (pg.status === 'locked') {
      var reDeploy = await deployGuaranteePage(slug);
      if (!reDeploy.deployed) {
        await monitor.logError('lock-guarantee', new Error('deploy (already-locked) failed: ' + reDeploy.error), {
          client_slug: slug,
          detail: { actor: user && user.email, stage: 'deploy_already_locked' }
        });
      }
      return res.status(200).json({
        success: true,
        already_locked: true,
        locked_at: pg.locked_at,
        guarantee_calls: pg.guarantee_calls,
        total_benchmark: pg.total_benchmark,
        slug: slug,
        signing_page_deployed: reDeploy.deployed,
        signing_page_commit: reDeploy.commit,
        client_emailed: false   // TODO (3.5): send on signing-endpoint ship
      });
    }

    // 5. Draft completeness
    var missing = REQUIRED_FIELDS.filter(function(k) { return pg[k] == null; });
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Draft is incomplete — client needs to fill in all fields first',
        missing: missing
      });
    }

    // 6. Flip draft → locked
    var patched = await sb.mutate(
      'performance_guarantees?id=eq.' + encodeURIComponent(pg.id),
      'PATCH',
      { status: 'locked', locked_at: new Date().toISOString() }
    );
    var locked = Array.isArray(patched) ? patched[0] : patched;
    if (!locked || locked.status !== 'locked') {
      throw new Error('Lock transition did not apply (PATCH returned no row with status=locked)');
    }

    // 7. Deploy the signing page. Failure here is non-fatal — status is
    //    already locked, and deployGuaranteePage() will re-run on a retry
    //    through the already-locked branch.
    var deploy = await deployGuaranteePage(slug);
    if (!deploy.deployed) {
      await monitor.logError('lock-guarantee', new Error('deploy after lock failed: ' + deploy.error), {
        client_slug: slug,
        detail: { actor: user && user.email, stage: 'deploy_post_lock' }
      });
    }

    // TODO (3.5): send Resend email (notifications@clients.moonraker.ai) to contact.email
    //             with CTA linking to https://clients.moonraker.ai/{slug}/guarantee
    //             Gate on deploy.deployed and signing endpoint being live.

    return res.status(200).json({
      success: true,
      already_locked: false,
      locked_at: locked.locked_at,
      guarantee_calls: locked.guarantee_calls,
      total_benchmark: locked.total_benchmark,
      slug: slug,
      signing_page_deployed: deploy.deployed,
      signing_page_commit: deploy.commit,
      client_emailed: false   // TODO (3.5)
    });

  } catch (err) {
    await monitor.logError('lock-guarantee', err, {
      client_slug: slug,
      detail: { actor: user && user.email }
    });
    return res.status(500).json({ error: 'Lock-in failed' });
  }
};
