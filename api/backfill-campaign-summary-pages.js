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

var nodeCrypto = require('crypto');
var sb = require('./_lib/supabase');
var gh = require('./_lib/github');

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  var bufA = Buffer.from(String(a));
  var bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return nodeCrypto.timingSafeEqual(bufA, bufB);
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET not configured' });
    return;
  }
  var authHeader = req.headers['authorization'] || '';
  var match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match || !constantTimeEqual(match[1], expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  var body = req.body || {};
  var dryRun = !!body.dry_run;
  var limit = Math.min(Number(body.limit || 200), 200);

  var t0 = Date.now();

  try {
    // 1. Pull template once
    var template = await gh.readTemplate('campaign-summary.html');

    // 2. List active/onboarding/prospect clients with a slug
    var contacts = await sb.query(
      'contacts?status=in.(active,onboarding,prospect)'
      + '&select=slug'
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
        if (existingSha) {
          alreadyDeployed++;
          results.push({ slug: c.slug, status: 'already_deployed' });
          continue;
        }

        if (dryRun) {
          results.push({ slug: c.slug, status: 'would_deploy' });
          deployed++;
          continue;
        }

        await gh.pushFile(
          destPath,
          template,
          'Backfill campaign-summary for ' + c.slug,
          null
        );
        deployed++;
        results.push({ slug: c.slug, status: 'deployed' });

        // Pace to avoid GitHub secondary rate limits
        await sleep(700);
      } catch (e) {
        failed++;
        results.push({ slug: c.slug, status: 'failed', error: e.message || String(e) });
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
    console.error('[backfill-campaign-summary-pages]', e);
    res.status(500).json({
      error: e.message || String(e),
      duration_ms: Date.now() - t0
    });
  }
};
