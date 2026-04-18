// api/run-migration.js
// Run a SQL migration file from migrations/ in the repo against the
// connected Postgres database.
//
// Reusable for any future migration. CRON_SECRET-gated (strict — admin
// JWTs cannot invoke this).
//
// Usage:
//   POST /api/run-migration
//   Authorization: Bearer <CRON_SECRET>
//   Body: { "migration": "2026-04-17-attribution-tables.sql", "dry_run": false }
//
// Returns:
//   {
//     migration: string,
//     statements_run: number,
//     duration_ms: number,
//     verification: [{table, count} ...]   // sample queries to confirm
//   }
//
// ──────────────────────────────────────────────────────────────────
// SECURITY MODEL
// ──────────────────────────────────────────────────────────────────
// This endpoint executes arbitrary SQL fetched from migrations/ in the
// repo as service_role (non-pooled connection). The trust model is:
//
//   - Only CRON_SECRET holders can invoke. Admin JWTs CANNOT invoke
//     (see requireCronSecret in _lib/auth.js — this is deliberately
//     distinct from requireAdminOrInternal). A compromised admin
//     browser session must not be able to run arbitrary SQL.
//   - Only SQL committed to main/migrations/ can be executed.
//     Filename is regex-validated at /^[a-zA-Z0-9_.-]+\.sql$/ —
//     no path traversal, no SQL in the request body.
//   - Anyone who can push to main AND knows CRON_SECRET can deploy
//     arbitrary SQL to production. That tier (repo write + Vercel
//     env access) is already service_role-equivalent in our threat
//     model.
//
// Do NOT loosen auth to accept admin JWTs. Do NOT accept SQL in the
// request body. Do NOT remove the filename regex.
// ──────────────────────────────────────────────────────────────────

var pg = require('pg');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

// Intentionally uses raw `fetch` against the GitHub REST API instead of
// routing through `api/_lib/github.js` (M40, 2026-04-19). Three reasons:
//   1. CRON_SECRET-gated handler with no user-input reachability
//   2. Read-only — no writes, no upsert SHA dance, no write-path surface
//   3. Filename already regex-validated at the caller as
//      /^[a-zA-Z0-9_.-]+\.sql$/ — stricter than `validatePath`'s
//      allowlist would be, and `migrations/` is not a wrapper-managed
//      prefix (no other code writes there). Expanding the wrapper's
//      write surface to cover this single read would weaken the
//      "wrapper only writes where writes happen" invariant.
async function fetchMigrationFromGitHub(filename) {
  var token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT env var missing');
  var url = 'https://api.github.com/repos/Moonraker-AI/client-hq/contents/migrations/' + encodeURIComponent(filename);
  var resp = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'moonraker-migration-runner'
    }
  });
  if (!resp.ok) {
    throw new Error('GitHub fetch failed: ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  }
  var data = await resp.json();
  return Buffer.from(data.content, 'base64').toString('utf8');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Strict CRON_SECRET auth — admin JWTs explicitly cannot invoke this
  var user = await auth.requireCronSecret(req, res);
  if (!user) return;

  var body = req.body || {};
  var migration = String(body.migration || '');
  var dryRun = !!body.dry_run;

  // Path-traversal guard: only allow [a-zA-Z0-9_.-] and require .sql extension
  if (!migration.match(/^[a-zA-Z0-9_.-]+\.sql$/)) {
    res.status(400).json({ error: 'Invalid migration filename' });
    return;
  }

  var dbUrl = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!dbUrl) {
    res.status(500).json({ error: 'POSTGRES_URL_NON_POOLING not configured' });
    return;
  }

  var t0 = Date.now();
  try {
    var sql = await fetchMigrationFromGitHub(migration);

    if (dryRun) {
      res.status(200).json({
        migration: migration,
        dry_run: true,
        sql_length: sql.length,
        sql_preview: sql.slice(0, 500)
      });
      return;
    }

    var client = new pg.Client({
      connectionString: dbUrl.replace(/[?&]sslmode=[^&]*/g, ''),
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();

    var verification = [];
    try {
      // ── Run the migration in a transaction ───────────────────
      // The migration file may contain its own BEGIN/COMMIT inside DO
      // blocks; pg handles nested savepoints. The top-level transaction
      // ensures any failure rolls back the whole file.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(function() {});
        throw e;
      }

      // ── Verification (read-only, outside migration txn) ──────
      for (var table of ['client_attribution_periods', 'client_attribution_sources']) {
        try {
          var r = await client.query('SELECT COUNT(*)::int AS c FROM ' + table);
          verification.push({ table: table, count: r.rows[0].c });
        } catch (e) {
          monitor.logError('run-migration', e, {
            detail: { stage: 'verify_table', table: table, migration: migration }
          });
          verification.push({ table: table, error: 'Verification failed' });
        }
      }
    } finally {
      // Always release the connection, even if BEGIN itself threw
      await client.end().catch(function() {});
    }

    // Audit trail: record the successful migration run for ops visibility.
    // Uses severity 'warning' (closest match in the existing error_log
    // CHECK constraint — 'info' is not yet an accepted value). Non-blocking.
    monitor.warn('run-migration', 'Migration applied: ' + migration, {
      detail: {
        stage: 'migration_applied',
        migration: migration,
        duration_ms: Date.now() - t0,
        verification: verification
      }
    });

    res.status(200).json({
      migration: migration,
      ok: true,
      duration_ms: Date.now() - t0,
      verification: verification
    });
  } catch (e) {
    monitor.logError('run-migration', e, {
      detail: { stage: 'run_handler', migration: (typeof migration !== 'undefined' ? migration : null) }
    });
    res.status(500).json({
      error: 'Migration failed',
      duration_ms: Date.now() - t0
    });
  }
};
