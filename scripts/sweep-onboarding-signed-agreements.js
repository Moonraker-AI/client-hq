#!/usr/bin/env node
// scripts/sweep-onboarding-signed-agreements.js
// -----------------------------------------------------------------------------
// Sweeps deployed per-client onboarding pages that still carry the legacy
// `sbPost('signed_agreements', record)` direct-anon PostgREST write.
//
// Replaces the 14-line record-builder + sbPost call with the token-gated
// apiAction('create_record', 'signed_agreements', null, record) pattern
// that matches _templates/onboarding.html after the 2026-04-20 remediation.
//
// The record object is stripped of contact_id, ip_address, and user_agent
// (all populated server-side from the verified page-token + request headers).
//
// Usage:
//   node scripts/sweep-onboarding-signed-agreements.js --dry-run
//   node scripts/sweep-onboarding-signed-agreements.js --apply
// -----------------------------------------------------------------------------
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT  = path.resolve(__dirname, '..');
var DRY   = !process.argv.includes('--apply');

// Match the 14-line block from the legacy template, with flexible whitespace.
// Anchored on the `contact_id: contact.id,` line + the trailing
// `sbPost('signed_agreements', record).then(` call within 20 lines.
var SEARCH = /(\s*)var record = \{\s*\n\s*contact_id: contact\.id,\s*\n\s*agreement_type: 'csa',\s*\n\s*agreement_version: '2026-04',\s*\n\s*document_html: docHTML \+ sigBlock,\s*\n\s*signer_name: signerName,\s*\n\s*signer_email: signerEmail,\s*\n\s*signer_title: signerTitle,\s*\n\s*signed_at: signedAt,\s*\n\s*ip_address: null,\s*\n\s*user_agent: navigator\.userAgent \|\| null,\s*\n\s*signature_image: sigImage,\s*\n\s*plan_details: \{ plan_type: planType, amount_cents: planAmount, campaign_start: contact\.campaign_start, campaign_end: contact\.campaign_end \}\s*\n\s*\};\s*\n\s*\n\s*sbPost\('signed_agreements', record\)\.then\(function\(\) \{/;

var REPLACE = function(match, leading) {
  var indent = leading.replace(/^\n+/, '').replace(/[^ \t]/g, '');
  // Fall back to 4-space indent if we can't derive it.
  if (!indent) indent = '    ';
  return '\n' + indent + '// Token-gated write via /api/onboarding-action. contact_id, ip_address,\n' +
    indent + '// and user_agent are forced/populated server-side from the verified\n' +
    indent + '// page-token and request headers; we must not send them in the body.\n' +
    indent + 'var record = {\n' +
    indent + '  agreement_type: \'csa\',\n' +
    indent + '  agreement_version: \'2026-04\',\n' +
    indent + '  document_html: docHTML + sigBlock,\n' +
    indent + '  signer_name: signerName,\n' +
    indent + '  signer_email: signerEmail,\n' +
    indent + '  signer_title: signerTitle,\n' +
    indent + '  signed_at: signedAt,\n' +
    indent + '  signature_image: sigImage,\n' +
    indent + '  plan_details: { plan_type: planType, amount_cents: planAmount, campaign_start: contact.campaign_start, campaign_end: contact.campaign_end }\n' +
    indent + '};\n\n' +
    indent + 'apiAction(\'create_record\', \'signed_agreements\', null, record).then(function() {';
};

function listOnboardingPages() {
  var out = [];
  var entries = fs.readdirSync(ROOT, { withFileTypes: true });
  entries.forEach(function(ent) {
    if (!ent.isDirectory()) return;
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) return;
    if (ent.name === 'admin' || ent.name === 'api' || ent.name === 'assets' ||
        ent.name === 'shared' || ent.name === 'scripts' || ent.name === 'docs' ||
        ent.name === 'migrations' || ent.name === 'node_modules') return;
    var p = path.join(ROOT, ent.name, 'onboarding', 'index.html');
    if (fs.existsSync(p)) out.push(p);
  });
  return out;
}

function run() {
  var files = listOnboardingPages();
  var swept = [];
  var skipped = [];
  var failed = [];

  files.forEach(function(file) {
    var src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch (e) { failed.push({ file: file, error: e.message }); return; }

    if (!SEARCH.test(src)) {
      skipped.push({ file: file.replace(ROOT + '/', ''), reason: 'no legacy sbPost block' });
      return;
    }
    var next = src.replace(SEARCH, REPLACE);
    if (next === src) {
      skipped.push({ file: file.replace(ROOT + '/', ''), reason: 'replace was a no-op' });
      return;
    }
    if (!DRY) {
      try { fs.writeFileSync(file, next, 'utf8'); }
      catch (e) { failed.push({ file: file, error: e.message }); return; }
    }
    swept.push(file.replace(ROOT + '/', ''));
  });

  console.log(DRY ? '[dry-run] would sweep:' : '[applied] swept:');
  swept.forEach(function(f) { console.log('  - ' + f); });
  if (skipped.length) {
    console.log('\nSkipped:');
    skipped.forEach(function(s) { console.log('  - ' + s.file + ' (' + s.reason + ')'); });
  }
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach(function(f) { console.log('  - ' + f.file + ' (' + f.error + ')'); });
  }
  console.log('\nTotal onboarding pages inspected: ' + files.length);
  console.log('Swept: ' + swept.length + ' | Skipped: ' + skipped.length + ' | Failed: ' + failed.length);
}

run();
