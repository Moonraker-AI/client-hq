#!/usr/bin/env node
// scripts/regenerate-client-pages.js
//
// Re-stamp existing per-client page copies from _templates/ so a template
// change reaches every deployed client directory without individual hand-edits.
//
// BACKGROUND:
//   Per-client directories (<slug>/proposal/, <slug>/onboarding/, etc.) are
//   byte-copies committed to git. generate-proposal.js writes them once at
//   deploy time; there was no "re-stamp all" mechanism until this script.
//   That meant a security/XSS fix to a template silently skipped every
//   pre-existing client — the fix only reached *new* deploys.
//
// SCOPE:
//   Handles pages whose template is either:
//     (a) zero-variable (router, diagnosis, action-plan, checkout, report,
//         entity-audit, entity-audit-checkout) — byte copy only.
//     (b) single-variable {{PAGE_TOKEN}} (onboarding, progress,
//         campaign-summary, endorsements) — re-sign per-client page-token.
//   Proposal and content-preview are intentionally SKIPPED: proposal has
//   ~37 AI-generated content substitutions; content-preview is per
//   content-page (not per client). Use generate-proposal / deploy-content-preview
//   for those.
//
// USAGE:
//   PAGE_TOKEN_SECRET=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/regenerate-client-pages.js [--dry-run] [--slug=<slug>] [--pages=<p1,p2>]
//
//   --dry-run         Print intended changes, write nothing.
//   --slug=<slug>     Restrict to a single slug (default: all).
//   --pages=<list>    Comma-separated page keys to regenerate (default: all supported).
//                     Keys: router, diagnosis, action-plan, progress, report,
//                           checkout, entity-audit, entity-audit-checkout,
//                           onboarding, campaign-summary, endorsements.
//   --verbose         Print per-file skip reasons (otherwise only changes).
//
// After a run, review with `git diff` and commit like any other template change.

var fs = require('fs');
var path = require('path');

var REPO_ROOT = path.resolve(__dirname, '..');
var TEMPLATES_DIR = path.join(REPO_ROOT, '_templates');

// Per-page config. key = template basename, target = relative path under slug dir.
// Post-C6: no per-page PAGE_TOKEN substitution — tokens live in HttpOnly cookies
// minted by /api/page-token/request at page load. Templates are byte-copied.
var PAGE_MAP = {
  'router':                   { template: 'router.html',                 target: 'index.html'                             },
  'checkout-success':         { template: 'checkout-success.html',       target: 'checkout/success/index.html'            },
  'diagnosis':                { template: 'diagnosis.html',              target: 'audits/diagnosis/index.html'            },
  'action-plan':              { template: 'action-plan.html',            target: 'audits/action-plan/index.html'          },
  'progress':                 { template: 'progress.html',               target: 'audits/progress/index.html'             },
  'report':                   { template: 'report.html',                 target: 'reports/index.html'                     },
  'checkout':                 { template: 'checkout.html',               target: 'checkout/index.html'                    },
  'entity-audit':             { template: 'entity-audit.html',           target: 'entity-audit/index.html'                },
  'entity-audit-checkout':    { template: 'entity-audit-checkout.html',  target: 'entity-audit-checkout/index.html'       },
  'onboarding':               { template: 'onboarding.html',              target: 'onboarding/index.html'                 },
  'campaign-summary':         { template: 'campaign-summary.html',       target: 'campaign-summary/index.html'            },
  'endorsements':             { template: 'endorsements.html',           target: 'endorsements/index.html'                }
};

// ---- CLI parsing ------------------------------------------------------------

function parseArgs(argv) {
  var out = { dryRun: false, slug: null, pages: null, verbose: false };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.indexOf('--slug=') === 0) out.slug = a.slice(7);
    else if (a.indexOf('--pages=') === 0) out.pages = a.slice(8).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown arg: ' + a); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log([
    'regenerate-client-pages.js',
    '',
    'Usage: node scripts/regenerate-client-pages.js [options]',
    '',
    '  --dry-run        Report changes without writing',
    '  --slug=<slug>    Restrict to a single client slug',
    '  --pages=<list>   Comma list of page keys (see script header)',
    '  --verbose        Print skip reasons'
  ].join('\n'));
}

// ---- Supabase fetch (no dependencies; service role, read-only here) ---------

function fetchContactsBySlug(sbUrl, serviceKey, slug) {
  var filter = slug ? '&slug=eq.' + encodeURIComponent(slug) : '';
  var url = sbUrl + '/rest/v1/contacts?select=id,slug' + filter + '&limit=5000';
  return fetch(url, {
    headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey }
  }).then(function(r) {
    if (!r.ok) throw new Error('Supabase fetch failed: ' + r.status);
    return r.json();
  });
}

// ---- Regen core -------------------------------------------------------------

function readTemplate(name) {
  var p = path.join(TEMPLATES_DIR, name);
  return fs.readFileSync(p, 'utf8');
}

function slugDirExists(slug) {
  try {
    var st = fs.statSync(path.join(REPO_ROOT, slug));
    return st.isDirectory();
  } catch (_) { return false; }
}

function targetExists(slug, rel) {
  try { return fs.statSync(path.join(REPO_ROOT, slug, rel)).isFile(); } catch (_) { return false; }
}

function regenerateOnePage(contact, pageKey, config, opts) {
  var slug = contact.slug;
  var rel = config.target;
  var fullPath = path.join(REPO_ROOT, slug, rel);

  if (!targetExists(slug, rel)) {
    if (opts.verbose) console.log('  [skip] ' + pageKey + ': no existing ' + rel);
    return { status: 'skip-no-existing' };
  }

  var templateHtml;
  try { templateHtml = readTemplate(config.template); }
  catch (e) { return { status: 'error', error: 'missing template: ' + config.template }; }

  var html = templateHtml;

  // Safety check: post-C6 no single-page template carries any {{VAR}} placeholder
  // (all auth lives in cookies now). Any surviving placeholder indicates a
  // template that is NOT safe to re-stamp via this script — bail with an error
  // so the caller can use the dedicated generator (generate-proposal etc) instead.
  var stray = html.match(/\{\{[A-Z_]+\}\}/g);
  if (stray && stray.length) {
    return { status: 'error', error: 'template carries placeholders — use dedicated generator: ' + Array.from(new Set(stray)).join(', ') };
  }

  var current = fs.readFileSync(fullPath, 'utf8');
  if (current === html) return { status: 'noop' };

  if (!opts.dryRun) {
    fs.writeFileSync(fullPath, html);
  }
  return { status: 'written', bytes: html.length, delta: html.length - current.length };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  var opts = parseArgs(process.argv);

  var SB_URL = process.env.SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE) {
    console.error('[regen] SUPABASE_SERVICE_ROLE_KEY is required');
    process.exit(1);
  }

  var pageKeys = opts.pages && opts.pages.length ? opts.pages : Object.keys(PAGE_MAP);
  for (var k = 0; k < pageKeys.length; k++) {
    if (!PAGE_MAP[pageKeys[k]]) {
      console.error('[regen] Unknown page key: ' + pageKeys[k]);
      console.error('        Valid: ' + Object.keys(PAGE_MAP).join(', '));
      process.exit(2);
    }
  }

  console.log('[regen] ' + (opts.dryRun ? 'DRY RUN — no files will be written' : 'LIVE — files will be written'));
  console.log('[regen] slug filter: ' + (opts.slug || '(all)'));
  console.log('[regen] pages:       ' + pageKeys.join(', '));

  var contacts = await fetchContactsBySlug(SB_URL, SERVICE, opts.slug);
  console.log('[regen] fetched ' + contacts.length + ' contact(s) from Supabase');

  var counts = { written: 0, noop: 0, skipNoExisting: 0, skipNoDir: 0, errors: 0 };
  var errors = [];

  for (var ci = 0; ci < contacts.length; ci++) {
    var contact = contacts[ci];
    if (!contact.slug || !contact.id) continue;
    if (!slugDirExists(contact.slug)) {
      counts.skipNoDir++;
      if (opts.verbose) console.log('[skip-dir] ' + contact.slug + ' (no local dir)');
      continue;
    }

    var perSlugChanges = [];
    for (var pj = 0; pj < pageKeys.length; pj++) {
      var key = pageKeys[pj];
      var cfg = PAGE_MAP[key];
      var r = regenerateOnePage(contact, key, cfg, opts);
      if (r.status === 'written') { counts.written++; perSlugChanges.push(key + ' (' + (r.delta >= 0 ? '+' : '') + r.delta + ' bytes)'); }
      else if (r.status === 'noop') counts.noop++;
      else if (r.status === 'skip-no-existing') counts.skipNoExisting++;
      else if (r.status === 'error') { counts.errors++; errors.push(contact.slug + '/' + key + ': ' + r.error); }
    }
    if (perSlugChanges.length) {
      console.log((opts.dryRun ? '[would-write] ' : '[wrote] ') + contact.slug + ': ' + perSlugChanges.join(', '));
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log('  Written (or would-write): ' + counts.written);
  console.log('  Unchanged (noop):         ' + counts.noop);
  console.log('  Skipped (page not deployed for slug): ' + counts.skipNoExisting);
  console.log('  Skipped (no local slug dir):          ' + counts.skipNoDir);
  console.log('  Errors:                   ' + counts.errors);
  if (errors.length) {
    console.log('');
    console.log('Errors:');
    errors.slice(0, 20).forEach(function(e) { console.log('  - ' + e); });
    if (errors.length > 20) console.log('  ... and ' + (errors.length - 20) + ' more');
  }

  if (opts.dryRun) {
    console.log('');
    console.log('Dry run complete. Re-run without --dry-run to apply.');
  } else if (counts.written > 0) {
    console.log('');
    console.log('Done. Review with: git status && git diff  — then commit and push.');
  }

  process.exit(counts.errors > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('[regen] FATAL:', e && e.stack || e);
  process.exit(1);
});
