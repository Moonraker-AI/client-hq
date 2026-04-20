#!/usr/bin/env node
// scripts/sweep-proposal-page-token.js
// -----------------------------------------------------------------------------
// Sweeps deployed per-client proposal pages that still carry a hardcoded
// `window.__PAGE_TOKEN__ = "proposal...."` line from the pre-C6 era.
//
// Replaces that single inert line with the current template's two-line pattern:
//
//     <script>window.__MR_PAGE_SCOPE__ = 'proposal';</script>
//     <script src="/shared/page-token.js" defer></script>
//
// The cookie-based page-token flow (mr_pt_proposal) is minted at page load by
// /shared/page-token.js; the hardcoded __PAGE_TOKEN__ global is ignored by
// every server endpoint (see C6 cutover) and only adds dead surface area.
//
// Usage:
//   node scripts/sweep-proposal-page-token.js --dry-run
//   node scripts/sweep-proposal-page-token.js --apply
// -----------------------------------------------------------------------------
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT   = path.resolve(__dirname, '..');
var DRY    = !process.argv.includes('--apply');
var SEARCH = /^<script>window\.__PAGE_TOKEN__ = "proposal\.[^"]+";<\/script>\s*$/m;
var REPLACE =
  "<script>window.__MR_PAGE_SCOPE__ = 'proposal';</script>\n" +
  '<script src="/shared/page-token.js" defer></script>';

function listProposalPages() {
  var out = [];
  var entries = fs.readdirSync(ROOT, { withFileTypes: true });
  entries.forEach(function(ent) {
    if (!ent.isDirectory()) return;
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) return;
    var p = path.join(ROOT, ent.name, 'proposal', 'index.html');
    if (fs.existsSync(p)) out.push(p);
  });
  return out;
}

function run() {
  var files = listProposalPages();
  var swept = [];
  var skipped = [];

  files.forEach(function(file) {
    var src = fs.readFileSync(file, 'utf8');
    if (!SEARCH.test(src)) {
      skipped.push({ file: file.replace(ROOT + '/', ''), reason: 'no inert token line' });
      return;
    }
    var next = src.replace(SEARCH, REPLACE);
    if (next === src) {
      skipped.push({ file: file.replace(ROOT + '/', ''), reason: 'replace was a no-op' });
      return;
    }
    if (!DRY) fs.writeFileSync(file, next, 'utf8');
    swept.push(file.replace(ROOT + '/', ''));
  });

  console.log(DRY ? '[dry-run] would sweep:' : '[applied] swept:');
  swept.forEach(function(f) { console.log('  - ' + f); });
  if (skipped.length) {
    console.log('\nSkipped:');
    skipped.forEach(function(s) { console.log('  - ' + s.file + ' (' + s.reason + ')'); });
  }
  console.log('\nTotal proposal pages inspected: ' + files.length);
  console.log('Swept: ' + swept.length + ' | Skipped: ' + skipped.length);
}

run();
