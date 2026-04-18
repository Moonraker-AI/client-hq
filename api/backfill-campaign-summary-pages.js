// api/backfill-campaign-summary-pages.js
//
// One-shot admin endpoint to deploy /{slug}/campaign-summary/index.html for
// every active/onboarding/prospect client that doesn't already have one.
//
// This is needed once (2026-04-17) to retroactively deploy the campaign-summary
// page for clients that onboarded before the Track 3 addition to
// generate-proposal.js. Future clients get the page deployed automatically
// via the Lead-to-Prospect conversion flow.
//
// Auth: Bearer CRON_SECRET.
//
// POST /api/backfill-campaign-summary-pages
// Optional body: { "dry_run": true, "limit": 5 }
//
// Returns:
//   {
//     scanned: number,          // candidate clients considered
//     already_deployed: number, // skipped because file exists
//     deployed: number,         // successfully deployed
//     failed: number,           // attempted but errored
//     results: [{ slug, status, ... }]
//   }
//
// Security:
//   - Fails closed if CRON_SECRET missing
//   - Constant-time token comparison
//   - Hard limit of 200 deploys per call to avoid runaway
//   - Paces pushes with a small delay to avoid GitHub secondary rate limits

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var gh = require('./_lib/github');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var user = await auth.requireCronSecret(req, res);
  if (!user) return;

  var body = req.body || {};
  var dryRun = !!body.dry_run;
  var force = !!body.force;
  var limit = Math.min(Number(body.limit || 200), 200);

  var t0 = Date.now();

  try {
    // 1. Pull template once
    var template = await gh.readTemplate('campaign-summary.html');

    // 2. List active/onboarding/prospect clients with a slug + id.
    //    id is needed to sign a scope='campaign_summary' page token per client.
    var contacts = await sb.query(
      'contacts?status=in.(active,onboarding,prospect)'
      + '&select=id,slug'
      + '&slug=not.is.null'
      + '&order=slug.asc'
    );

    var scanned = 0;
    var alreadyDeployed = 0;
    var deployed = 0;
    var failed = 0;
    var results = [];

    for (var c of contacts) {
      if (deployed >= limit) {
        results.push({ slug: c.slug, status: 'skipped_limit_reached' });
        continue;
      }
      scanned++;
      var destPath = c.slug + '/campaign-summary/index.html';

      try {
        var existingSha = await gh.fileSha(destPath);
        if (existingSha && !force) {
          alreadyDeployed++;
          results.push({ slug: c.slug, status: 'already_deployed' });
          continue;
        }

        if (dryRun) {
          results.push({ slug: c.slug, status: existingSha ? 'would_update' : 'would_deploy' });
          deployed++;
          continue;
        }

        // Sign a scope='campaign_summary' page token bound to this contact.
        // Baked into the HTML as window.__PAGE_TOKEN__ and sent with every
        // call to /api/campaign-summary and /api/campaign-summary-chat,
        // both of which verify + bind to the contact_id from the token.
        // 365-day TTL (see page-token DEFAULT_TTL).
        var signedToken;
        try {
          signedToken = pageToken.sign({ scope: 'campaign_summary', contact_id: c.id });
        } catch (e) {
          // Config error (PAGE_TOKEN_SECRET missing) or validation — skip this
          // client, log, and continue. Don't deploy a broken page.
          failed++;
          monitor.logError('backfill-campaign-summary-pages', e, {
            client_slug: c.slug,
            detail: { stage: 'sign_token' }
          });
          results.push({ slug: c.slug, status: 'failed', error: 'Token sign failed' });
          continue;
        }
        var html = template.split('{{PAGE_TOKEN}}').join(signedToken);

        await gh.pushFile(
          destPath,
          html,
          (existingSha ? 'Update' : 'Backfill') + ' campaign-summary for ' + c.slug,
          existingSha
        );
        deployed++;
        results.push({ slug: c.slug, status: existingSha ? 'updated' : 'deployed' });

        // Pace to avoid GitHub secondary rate limits
        await sleep(700);
      } catch (e) {
        failed++;
        monitor.logError('backfill-campaign-summary-pages', e, {
          client_slug: c.slug,
          detail: { stage: 'backfill_per_client' }
        });
        results.push({ slug: c.slug, status: 'failed', error: 'Backfill failed' });
      }
    }

    res.status(200).json({
      scanned: scanned,
      already_deployed: alreadyDeployed,
      deployed: deployed,
      failed: failed,
      total_candidates: contacts.length,
      duration_ms: Date.now() - t0,
      results: results
    });
  } catch (e) {
    monitor.logError('backfill-campaign-summary-pages', e, {
      detail: { stage: 'backfill_handler' }
    });
    res.status(500).json({
      error: 'Backfill failed',
      duration_ms: Date.now() - t0
    });
  }
};
