// api/_lib/github.js
// Shared GitHub API helpers for file operations.
// Used by routes that deploy client pages, delete files, or read templates.
//
// Usage:
//   var gh = require('./_lib/github');
//   var { content, sha } = await gh.readFile('anna-skomorovskaia/proposal/index.html');
//   var html = await gh.readTemplate('proposal.html');
//   await gh.pushFile('anna-skomorovskaia/report/index.html', html, 'Deploy report');
//   await gh.deleteFile('old-client/proposal/index.html', sha, 'Cleanup');

var REPO = 'Moonraker-AI/client-hq';
var BRANCH = 'main';
var API_BASE = 'https://api.github.com/repos/' + REPO + '/contents/';

function token() {
  var t = process.env.GITHUB_PAT;
  if (!t) throw new Error('GITHUB_PAT not configured');
  return t;
}

function headers() {
  return {
    'Authorization': 'Bearer ' + token(),
    'Accept': 'application/vnd.github+json'
  };
}

// Allowlist for repo write targets (M4, 2026-04-19).
//
// Only two top-level prefixes are legitimate for this wrapper:
//
//   1. `_templates/<filename>` — shared page templates read by every
//      deploy route (proposal.html, onboarding.html, endorsements.html,
//      entity-audit.html, diagnosis.html, etc.). Flat directory, one
//      level deep.
//
//   2. `<slug>/<anything>` — per-client deploy directory. `slug` is the
//      production slug format (lowercase alphanumeric + dashes, 1-60
//      chars — same shape enforced by `M27` in bootstrap-access). Inside
//      a slug directory ANY subpath is allowed because:
//        - the exact section set grows over time (current set includes
//          proposal/, checkout/, onboarding/, index.html router, content/
//          <pageSlug>/, endorsements/, entity-audit/, entity-audit-checkout/,
//          audits/<diagnosis|action-plan|progress>/, campaign-summary/)
//        - delete-client.js iterates every git-tree blob under `<slug>/`
//          and deletes each; a tight section-allowlist would reject legacy
//          files still present in the tree and leave orphans behind.
//
// The slug format check `[a-z0-9-]{1,60}` is one security boundary, but
// several slug-shaped names are reserved top-level repo directories that
// hold non-client content and must not be writable via this wrapper:
//   - `admin/`, `assets/`, `docs/` — dashboard, shared assets, audit docs
//   - `api/` — Vercel serverless function source (write here = RCE)
//   - `agreement/`, `checkout/`, `entity-audit/` — shared landing pages
// These are listed in RESERVED_TOP_LEVEL below. Repo-level non-slug-shaped
// paths (`.github/`, `vercel.json`, `package.json`, `README.md`, `CLAUDE.md`)
// are already rejected by the slug regex (uppercase / dot / leading-dot).
//
// One intentional exemption (M40, 2026-04-19): `api/run-migration.js`
// issues a read-only raw `fetch` against `migrations/<filename>.sql` and
// stays outside this wrapper. It is CRON_SECRET-gated, read-only, and
// the filename is already regex-validated at the caller as
// `/^[a-zA-Z0-9_.-]+\.sql$/`. Expanding the write-path allowlist to
// cover `migrations/` would weaken the "wrapper only writes where writes
// happen" invariant for no security gain.
var TEMPLATE_PREFIX = '_templates/';
var SLUG_PREFIX_RE = /^([a-z0-9-]{1,60})\/.+/;
var RESERVED_TOP_LEVEL = {
  'admin': 1, 'api': 1, 'assets': 1, 'docs': 1,
  'agreement': 1, 'checkout': 1, 'entity-audit': 1,
  'node_modules': 1, 'public': 1, 'scripts': 1, 'dist': 1, 'build': 1
};

function validatePath(p) {
  if (!p) throw new Error('Invalid path: empty');
  // Reject obvious traversal (`..`) and absolute paths
  if (p.indexOf('..') !== -1 || p.startsWith('/')) throw new Error('Invalid path: ' + p);
  // Reject backslash — Windows-style separator, treated as literal by the
  // GitHub API so a `a\..\b` path could smuggle past `..` checks on POSIX
  if (p.indexOf('\\') !== -1) throw new Error('Invalid path: ' + p);
  // Reject null byte — some fs APIs terminate at \0 and treat the suffix as
  // unchecked; the GitHub API does not but keep the invariant firm here
  if (p.indexOf('\0') !== -1) throw new Error('Invalid path: null byte');
  // Reject any URL-encoding. Legitimate repo paths are ASCII letters, digits,
  // dashes, underscores, dots, and forward slashes — none of which require
  // percent-encoding. A `%` in the input is almost certainly an attempt to
  // smuggle an encoded `..` / `/` / `\` past the raw-string checks above.
  if (p.indexOf('%') !== -1) throw new Error('Invalid path: encoded characters');

  // Allowlist: `_templates/<filename>` or `<slug>/<anything>` where <slug>
  // matches the production slug regex and is not a reserved top-level dir.
  if (p.indexOf(TEMPLATE_PREFIX) === 0 && p.length > TEMPLATE_PREFIX.length) return;
  var m = SLUG_PREFIX_RE.exec(p);
  if (m && !RESERVED_TOP_LEVEL[m[1]]) return;
  throw new Error('Invalid path: not in allowlist');
}

// Read a file from the repo. Returns { content: string, sha: string }.
async function readFile(path) {
  validatePath(path);
  var resp = await fetch(API_BASE + path + '?ref=' + BRANCH, { headers: headers() });
  if (!resp.ok) {
    var err = new Error('GitHub readFile failed (' + resp.status + '): ' + path);
    err.status = resp.status;
    throw err;
  }
  var data = await resp.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha
  };
}

// Read a template from _templates/. Returns HTML string.
async function readTemplate(name) {
  var result = await readFile('_templates/' + name);
  return result.content;
}

// Get the SHA of a file, or null if it doesn't exist.
async function fileSha(path) {
  validatePath(path);
  var resp = await fetch(API_BASE + path + '?ref=' + BRANCH, { headers: headers() });
  if (!resp.ok) return null;
  var data = await resp.json();
  return data.sha;
}

// Create or update a file. If sha is provided, it's an update; otherwise creates new.
// If sha is not provided, checks if the file exists first (safe upsert).
async function pushFile(path, content, message, sha) {
  validatePath(path);
  // If no sha provided, check if file already exists
  if (!sha) {
    sha = await fileSha(path);
  }

  var body = {
    message: message || ('Update ' + path),
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  var resp = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: Object.assign({}, headers(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    var errText = await resp.text();
    var err = new Error('GitHub pushFile failed (' + resp.status + '): ' + errText.substring(0, 500));
    err.status = resp.status;
    throw err;
  }

  var data = await resp.json();
  return { sha: data.content.sha, commit: data.commit.sha };
}

// Delete a file. Requires sha.
async function deleteFile(path, sha, message) {
  validatePath(path);
  if (!sha) {
    sha = await fileSha(path);
    if (!sha) return null; // File doesn't exist, nothing to delete
  }

  var resp = await fetch(API_BASE + path, {
    method: 'DELETE',
    headers: Object.assign({}, headers(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: message || ('Delete ' + path),
      sha: sha,
      branch: BRANCH
    })
  });

  if (!resp.ok) {
    var errText = await resp.text();
    var err = new Error('GitHub deleteFile failed (' + resp.status + '): ' + errText.substring(0, 500));
    err.status = resp.status;
    throw err;
  }

  return true;
}

// Check if GITHUB_PAT is set.
function isConfigured() {
  return !!process.env.GITHUB_PAT;
}

module.exports = { readFile, readTemplate, fileSha, pushFile, deleteFile, isConfigured };
