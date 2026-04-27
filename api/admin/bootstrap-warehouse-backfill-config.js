// api/admin/bootstrap-warehouse-backfill-config.js
// One-shot setup: writes settings.warehouse_backfill_config from server-side
// env (AGENT_API_KEY or CRON_SECRET, in that order) so the
// trg_auto_backfill_warehouses trigger can call /api/backfill-{gbp,gsc}-warehouse
// via pg_net. Idempotent — re-runs overwrite the row.
//
// Auth: admin JWT or CRON_SECRET via requireAdminOrInternal. The body lets
// the caller specify which env var to use ('agent' default, or 'cron'),
// and which base_url to record (defaults to https://clients.moonraker.ai).
//
// POST /api/admin/bootstrap-warehouse-backfill-config
//   { "secret_source": "agent" | "cron", "base_url"?: string }

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};
  var secretSource = body.secret_source === 'cron' ? 'cron' : 'agent';
  var baseUrl = body.base_url || 'https://clients.moonraker.ai';

  var secret;
  if (secretSource === 'agent') {
    secret = process.env.AGENT_API_KEY;
  } else {
    secret = process.env.CRON_SECRET;
  }

  if (!secret) {
    return res.status(500).json({
      error: 'Selected secret env var is not set',
      detail: { secret_source: secretSource }
    });
  }

  try {
    // Upsert (key is unique). Send the bearer prefix as part of the auth
    // header in the trigger, not stored here — store the raw secret only.
    var payload = [{
      key: 'warehouse_backfill_config',
      value: {
        base_url: baseUrl,
        cron_secret: secret,
        secret_source: secretSource,
        updated_at: new Date().toISOString()
      }
    }];

    await sb.mutate(
      'settings?on_conflict=key',
      'POST',
      payload,
      'resolution=merge-duplicates,return=representation'
    );

    return res.status(200).json({
      success: true,
      base_url: baseUrl,
      secret_source: secretSource,
      secret_length: secret.length
    });
  } catch (e) {
    monitor.logError('bootstrap-warehouse-backfill-config', e);
    return res.status(500).json({ error: 'Failed to write settings row', detail: e.message });
  }
};
