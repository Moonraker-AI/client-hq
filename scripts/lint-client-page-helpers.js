#!/usr/bin/env node
/*
 * lint-client-page-helpers.js
 *
 * Guards the class of bugs diagnosed 2026-04-22 on Angela Gwak's onboarding
 * page: inline scripts that touch a global exported by a deferred/async
 * external script, without waiting for the external to have loaded.
 *
 * Ground truth: docs/client-page-helper-protocol.md
 *
 * Scope:
 *   - _templates/*.html  (every client-facing template)
 *   - agreement/*.html, checkout/*.html, entity-audit/*.html (client-facing roots)
 *
 * Rules (each keyed on the shape of the real bug, not vague hygiene):
 *
 *   R1  No active-code `window.mrPageToken.fetch(` or `mrPageToken.fetch(`.
 *       The wrapper exists for a narrow cookie-refresh use case we currently
 *       don't need, and calling it after the .ready() guard in a .then
 *       re-creates the defer-race crash. Comments (//, /* *\/) are ignored.
 *
 *   R2  If a file touches `mrPageToken` in active code, it must include at
 *       least one copy of the canonical ready()-guard expression.
 *
 *   R3  If a file loads `/shared/page-token.js` with `defer` OR if any file
 *       uses `mrPageToken` in active code, it must declare `window.__MR_PAGE_SCOPE__`
 *       before the helper loads. Without that, the helper's auto-mint no-ops
 *       and ready() silently never resolves.
 *
 * Exit code: 0 = clean, 1 = violations found (prints each with file:line).
 *
 * Runs on plain Node >=14 with zero dependencies. The repo is deliberately
 * build-step-free, so this stays that way.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();

// Which files to scan. We deliberately enumerate rather than glob because
// the repo conventions are explicit about where client-facing HTML lives
// and we want the lint to break loudly if that ever moves.
function collectTargets() {
  const targets = [];

  const tplDir = path.join(ROOT, '_templates');
  if (fs.existsSync(tplDir)) {
    for (const name of fs.readdirSync(tplDir)) {
      if (name.endsWith('.html')) targets.push(path.join(tplDir, name));
    }
  }

  for (const sub of ['agreement', 'checkout', 'entity-audit']) {
    const p = path.join(ROOT, sub);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) continue;
    for (const name of fs.readdirSync(p)) {
      if (name.endsWith('.html')) targets.push(path.join(p, name));
    }
  }

  return targets;
}

// Strip // line comments and /* block */ comments from a source string.
// Preserve newlines so reported line numbers stay accurate.
// Naive but fine for our HTML-embedded JS: we don't have strings containing
// "//" sequences in practice; if we ever do the worst case is a false-positive
// reported line, never a missed violation.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const a = src[i];
    const b = i + 1 < n ? src[i + 1] : '';
    if (a === '/' && b === '/') {
      // line comment — consume to end of line, keep the newline
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (a === '/' && b === '*') {
      // block comment — consume to */, replace internals with spaces + preserved newlines
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2; // skip */
      continue;
    }
    out += a;
    i++;
  }
  return out;
}

// Canonical guard expression — the exact shape used by endorsements /
// progress / campaign-summary / onboarding after the 2026-04-22 fix.
// Accept either the window-prefixed or bare form, and allow any whitespace.
const CANONICAL_GUARD_RE =
  /\(\s*window\.mrPageToken\s*&&\s*window\.mrPageToken\.ready\s*\?\s*window\.mrPageToken\.ready\s*\(\s*\)\s*:\s*Promise\.resolve\s*\(\s*\)\s*\)/;

// Forbidden pattern: active-code call to mrPageToken.fetch(.
const FORBIDDEN_FETCH_RE = /(?:window\.)?mrPageToken\.fetch\s*\(/;

// Any active-code use of mrPageToken at all (broader than just .fetch).
const ANY_MRPT_RE = /(?:window\.)?mrPageToken\b/;

// page-token.js loaded with defer.
// Conservative match: <script ... src="..page-token.js" ... defer ... >
const PAGE_TOKEN_DEFER_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/shared\/page-token\.js["'][^>]*\bdefer\b[^>]*>/;
const PAGE_TOKEN_ANY_TAG_RE =
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/shared\/page-token\.js["'][^>]*>/;

// Scope declaration. Helper is inert without it.
const SCOPE_DECL_RE = /window\.__MR_PAGE_SCOPE__\s*=/;

function lintFile(filepath) {
  const violations = [];
  const raw = fs.readFileSync(filepath, 'utf8');
  const stripped = stripComments(raw);
  const rel = path.relative(ROOT, filepath);

  // R1: forbidden mrPageToken.fetch( in active code
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (FORBIDDEN_FETCH_RE.test(lines[i])) {
      violations.push({
        file: rel,
        line: i + 1,
        rule: 'R1',
        msg: 'mrPageToken.fetch() is forbidden; use native fetch(url, { credentials: "same-origin" }) after the ready() guard',
        snippet: lines[i].trim().slice(0, 140)
      });
    }
  }

  // R2: if anything mentions mrPageToken in active code, the canonical guard
  //     must appear at least once.
  const mentionsMrpt = ANY_MRPT_RE.test(stripped);
  if (mentionsMrpt && !CANONICAL_GUARD_RE.test(stripped)) {
    violations.push({
      file: rel,
      line: 1,
      rule: 'R2',
      msg: 'mrPageToken is used but the canonical ready() guard is missing. See docs/client-page-helper-protocol.md',
      snippet: ''
    });
  }

  // R3: if page-token.js is loaded (or mrPageToken is used), scope must be set.
  const loadsPageToken = PAGE_TOKEN_ANY_TAG_RE.test(raw);
  if ((loadsPageToken || mentionsMrpt) && !SCOPE_DECL_RE.test(raw)) {
    violations.push({
      file: rel,
      line: 1,
      rule: 'R3',
      msg: 'window.__MR_PAGE_SCOPE__ must be set before page-token.js loads; helper auto-mint is a no-op without it',
      snippet: ''
    });
  }

  // Informational: files that load page-token.js with defer AND touch
  // mrPageToken elsewhere have to be careful about access order. Our R1/R2
  // already cover the specific crash; this is just a sanity hint that fires
  // if a future template loads page-token.js *without* defer (which would
  // break the cookie-not-yet-ready-on-first-write assumption the server
  // makes on shared infra). Emit only when out-of-pattern.
  if (loadsPageToken && !PAGE_TOKEN_DEFER_RE.test(raw)) {
    violations.push({
      file: rel,
      line: 1,
      rule: 'R4',
      msg: 'page-token.js should be loaded with defer (canonical pattern). Non-defer load changes timing semantics',
      snippet: ''
    });
  }

  return violations;
}

function main() {
  const targets = collectTargets();
  if (targets.length === 0) {
    console.error('lint-client-page-helpers: no target HTML files found under', ROOT);
    process.exit(2);
  }

  const allViolations = [];
  for (const f of targets) {
    for (const v of lintFile(f)) allViolations.push(v);
  }

  if (allViolations.length === 0) {
    console.log('lint-client-page-helpers: OK (' + targets.length + ' files scanned, 0 violations)');
    process.exit(0);
  }

  console.error('lint-client-page-helpers: ' + allViolations.length + ' violation(s) found:\n');
  for (const v of allViolations) {
    console.error('  ' + v.file + ':' + v.line + '  [' + v.rule + '] ' + v.msg);
    if (v.snippet) console.error('      ' + v.snippet);
  }
  console.error('\nBackground: docs/client-page-helper-protocol.md');
  process.exit(1);
}

main();
