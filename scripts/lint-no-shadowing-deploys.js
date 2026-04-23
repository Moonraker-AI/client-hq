#!/usr/bin/env node
/*
 * lint-no-shadowing-deploys.js
 *
 * Guards the class of regressions closed 2026-04-23 by the "drop the 8
 * shadowing static-copy patterns" pass: per-client copies of client-facing
 * templates being pushed to /<slug>/<page>/index.html, which beat the Vercel
 * /:slug/<page> -> /_templates/<page> rewrite and silently mask future
 * template edits.
 *
 * Ground truth: every client-facing page in _templates/* is served by a
 * rewrite in vercel.json. Code MUST NOT push per-client copies of these
 * pages to the repo — templates hydrate per-client data at request time
 * via /api/public-* endpoints and the cookie-based page-token flow.
 *
 * Scope:
 *   - api/**\/*.js
 *
 * Rules:
 *
 *   R1  No active-code call to gh.pushFile() (or variants) whose destination
 *       ends in one of the shadowed page paths:
 *         /onboarding/index.html
 *         /endorsements/index.html
 *         /campaign-summary/index.html
 *         /entity-audit/index.html
 *         /entity-audit-checkout/index.html
 *         /audits/diagnosis/index.html
 *         /audits/action-plan/index.html
 *         /audits/progress/index.html
 *
 *       content-preview (per-page preview URLs under /<slug>/content/<page>/)
 *       is explicitly allowed — those URLs are not /:slug/<page> shaped and
 *       can't be served by a single rewrite.
 *
 *       agreement is allowed (it's a global top-level page, not per-client).
 *
 *       Comments are ignored.
 *
 * Exit code: 0 = clean, 1 = violations found (prints each with file:line).
 *
 * Runs on plain Node >=14 with zero dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();

const SHADOWED_PAGE_PATHS = [
  '/onboarding/index.html',
  '/endorsements/index.html',
  '/campaign-summary/index.html',
  '/entity-audit/index.html',
  '/entity-audit-checkout/index.html',
  '/audits/diagnosis/index.html',
  '/audits/action-plan/index.html',
  '/audits/progress/index.html'
];

function collectTargets() {
  const targets = [];
  const apiDir = path.join(ROOT, 'api');
  if (!fs.existsSync(apiDir)) return targets;

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (name.endsWith('.js')) {
        targets.push(full);
      }
    }
  }
  walk(apiDir);
  return targets;
}

// Strip // line comments and /* block */ comments. Preserve newlines so
// reported line numbers stay accurate.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr = null; // ' " or `
  while (i < n) {
    const a = src[i];
    const b = i + 1 < n ? src[i + 1] : '';

    if (inStr) {
      out += a;
      if (a === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (a === inStr) inStr = null;
      i++;
      continue;
    }

    if (a === "'" || a === '"' || a === '`') {
      inStr = a;
      out += a;
      i++;
      continue;
    }

    if (a === '/' && b === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (a === '/' && b === '*') {
      i += 2;
      while (i < n) {
        if (src[i] === '*' && i + 1 < n && src[i + 1] === '/') {
          i += 2;
          break;
        }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    out += a;
    i++;
  }
  return out;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === '\n') line++;
  return line;
}

function lint(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const code = stripComments(raw);
  const violations = [];

  // Find gh.pushFile( ... ) calls. The first argument is the destination
  // path; the argument may be a string literal, a template literal, or a
  // string expression like `slug + '/entity-audit/index.html'`. We match
  // the simpler case: any gh.pushFile(...) call whose source text (up to
  // the matching close paren) contains one of the shadowed page-path
  // suffixes. False-positive risk is near zero — these suffixes are
  // distinctive and wouldn't appear in a legitimate non-deploy call.
  const re = /gh\s*\.\s*pushFile\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = m.index;
    // walk to matching close paren
    let depth = 0;
    let i = m.index + m[0].length - 1; // points at the opening (
    let end = -1;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const call = code.slice(start, end + 1);
    for (const p of SHADOWED_PAGE_PATHS) {
      if (call.includes(p)) {
        violations.push({
          line: lineOf(code, start),
          path: p,
          snippet: call.slice(0, 160).replace(/\s+/g, ' ')
        });
        break;
      }
    }
  }

  return violations;
}

function main() {
  const targets = collectTargets();
  let total = 0;

  for (const f of targets) {
    const rel = path.relative(ROOT, f);
    const vs = lint(f);
    for (const v of vs) {
      console.error(
        `${rel}:${v.line}  gh.pushFile to shadowed path "${v.path}"`
      );
      console.error(`  ${v.snippet}`);
      total++;
    }
  }

  if (total > 0) {
    console.error('');
    console.error(`lint-no-shadowing-deploys: ${total} violation(s).`);
    console.error('');
    console.error('Per-client copies of client-facing templates are banned.');
    console.error('These pages are served by /:slug/<page> -> /_templates/<page>');
    console.error('rewrites in vercel.json. Templates hydrate per-client data');
    console.error('at request time via /api/public-* endpoints.');
    console.error('');
    console.error('If you need runtime substitution that the rewrite can\'t');
    console.error('provide, raise it as a design discussion before adding a');
    console.error('per-client push.');
    process.exit(1);
  }

  console.log(`lint-no-shadowing-deploys: clean (${targets.length} files scanned).`);
}

main();
