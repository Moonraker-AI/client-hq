#!/usr/bin/env node
/*
 * lint-api-cache-vs-auth.js
 *
 * Catches the bug class diagnosed 2026-04-23: an API route that requires
 * authentication (page-token, admin JWT, agent key, cron secret) but sets a
 * `Cache-Control: public, s-maxage=...` header on its success response.
 *
 * Vercel's edge cache keys on URL + query string. There is no implicit Vary
 * on Cookie / Authorization. So a public s-maxage header on an auth-gated
 * route lets the CDN serve one user's data to any subsequent request for the
 * same URL, regardless of whether they have a valid cookie.
 *
 * The campaign-summary route shipped this for several weeks. Confirmed in
 * production: x-vercel-cache: HIT on a no-cookie request returned a full
 * client payload. Fix: use `private`, `no-store`, `no-cache`, or `s-maxage=0`.
 *
 * Auth signals scanned for (in api/**.js, comments stripped):
 *   - pageToken.verify(             page-token-gated public endpoints
 *   - getTokenFromRequest(          page-token cookie read
 *   - requireAdmin(                 admin JWT or bearer
 *   - requireAdminOrInternal(       admin OR cron/agent
 *   - CRON_SECRET                   cron-only routes
 *   - AGENT_API_KEY                 agent callbacks
 *
 * Forbidden Cache-Control values when ANY auth signal is present:
 *   - any `public` directive WITH a positive s-maxage / max-age
 *
 * Allowed (and ignored):
 *   - private, no-store, no-cache, must-revalidate
 *   - public with s-maxage=0 / max-age=0  (effectively no caching)
 *   - no Cache-Control header at all (Vercel default = not cached)
 *
 * Exit 0 = clean, 1 = violations.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const API_DIR = path.join(ROOT, 'api');

const AUTH_SIGNALS = [
  'pageToken.verify(',
  'getTokenFromRequest(',
  'requireAdmin(',
  'requireAdminOrInternal(',
  'CRON_SECRET',
  'AGENT_API_KEY',
];

// Match a setHeader('Cache-Control', '...') call and capture the value.
const CC_HEADER_RE = /setHeader\(\s*['"]Cache-Control['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const a = src[i], b = i + 1 < n ? src[i + 1] : '';
    if (a === '/' && b === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (a === '/' && b === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2; continue;
    }
    out += a; i++;
  }
  return out;
}

function isCacheableHeader(value) {
  // Returns true if this header would actually allow CDN caching.
  const v = value.toLowerCase();
  if (/\bno-store\b|\bprivate\b/.test(v)) return false;
  if (/\bno-cache\b/.test(v) && !/s-maxage=[1-9]/.test(v)) return false;
  // Look for positive s-maxage or max-age
  const sMax = v.match(/s-maxage=(\d+)/);
  const mMax = v.match(/max-age=(\d+)/);
  const hasPositive =
    (sMax && parseInt(sMax[1], 10) > 0) ||
    (mMax && parseInt(mMax[1], 10) > 0);
  if (!hasPositive) return false;
  // Public with positive max is the dangerous combo.
  if (/\bpublic\b/.test(v)) return true;
  // Even without `public`, positive s-maxage means CDN cache (default scope).
  if (sMax && parseInt(sMax[1], 10) > 0) return true;
  return false;
}

function findApiFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      out.push(...findApiFiles(p));
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

function lintFile(filepath) {
  const violations = [];
  const raw = fs.readFileSync(filepath, 'utf8');
  const stripped = stripComments(raw);
  const rel = path.relative(ROOT, filepath);

  const hasAuth = AUTH_SIGNALS.some(sig => stripped.includes(sig));
  if (!hasAuth) return violations;

  const matches = [];
  let m;
  CC_HEADER_RE.lastIndex = 0;
  while ((m = CC_HEADER_RE.exec(stripped)) !== null) {
    matches.push({ value: m[1], line: lineOf(stripped, m.index) });
  }

  for (const { value, line } of matches) {
    if (isCacheableHeader(value)) {
      violations.push({
        file: rel,
        line,
        rule: 'C1',
        msg: `auth-gated route sets cacheable Cache-Control: "${value}". Vercel edge does not Vary on Cookie. Use 'private, no-store' or 'no-cache, no-transform'.`,
      });
    }
  }

  return violations;
}

function main() {
  const files = findApiFiles(API_DIR);
  if (files.length === 0) {
    console.error('lint-api-cache-vs-auth: no api/*.js files found under', ROOT);
    process.exit(2);
  }
  const all = [];
  for (const f of files) for (const v of lintFile(f)) all.push(v);

  if (all.length === 0) {
    console.log('lint-api-cache-vs-auth: OK (' + files.length + ' files scanned, 0 violations)');
    process.exit(0);
  }

  console.error('lint-api-cache-vs-auth: ' + all.length + ' violation(s) found:\n');
  for (const v of all) {
    console.error('  ' + v.file + ':' + v.line + '  [' + v.rule + '] ' + v.msg);
  }
  process.exit(1);
}

main();
