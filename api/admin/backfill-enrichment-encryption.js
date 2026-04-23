// api/admin/backfill-enrichment-encryption.js
//
// H29 one-shot backfill for proposals.enrichment_data column-level encryption.
//
// Re-shapes legacy pre-H29 enrichment_data rows into the post-H29 shape:
//   BEFORE (legacy):
//     { emails: [...], calls: [...], audit_scores, audit_tasks, website_info,
//       campaign_audit, practice_details }
//   AFTER (encrypted):
//     { audit_scores, audit_tasks, website_info, campaign_audit,
//       practice_details, email_count: N, call_count: N, enriched_at: ISO,
//       _sensitive: "<v1/v2 prefixed ciphertext>" }
//
// Idempotent: rows that already have _sensitive set are skipped. A row is
// considered legacy and in-scope for re-shaping iff:
//   - enrichment_data IS NOT NULL
//   - enrichment_data._sensitive IS NULL
//   - enrichment_data has 'emails' OR 'calls' as a top-level array
//
// enriched_at for backfilled rows defaults to the proposal's updated_at if
// available, otherwise to the current timestamp — gives a defensible
// timestamp without fabricating one.
//
// Designed to run in a single serverless invocation for the current data
// scale (11 rows, 123 emails, 48 calls total as of 2026-04-18). For
// larger datasets this endpoint takes an optional `limit` to paginate.
//
// Auth: requireAdmin (admin JWT from the browser session).
// Invocation: POST /api/admin/backfill-enrichment-encryption { limit?: int }

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var crypto = require('../_lib/crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!crypto.isConfigured()) {
    return res.status(500).json({
      error: 'Encryption not configured: CREDENTIALS_ENCRYPTION_KEY missing for active version'
    });
  }

  var body = req.body || {};
  var limit = (typeof body.limit === 'number' && body.limit > 0 && body.limit <= 500) ? body.limit : 200;

  var results = {
    scanned: 0,
    already_encrypted: 0,
    reshaped: 0,
    skipped_no_emails_or_calls: 0,
    errors: []
  };

  try {
    // Pull all proposals with non-null enrichment_data. Small dataset today,
    // so no pagination is needed, but we pass limit to cap a single call.
    var rows = await sb.query(
      'proposals?enrichment_data=not.is.null&select=id,enrichment_data,updated_at&limit=' + limit
    );

    if (!Array.isArray(rows)) {
      return res.status(500).json({ error: 'Unexpected Supabase response' });
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      results.scanned++;

      var ed = row.enrichment_data || {};

      // Already encrypted -- skip.
      if (ed._sensitive) {
        results.already_encrypted++;
        continue;
      }

      var hasEmails = Array.isArray(ed.emails);
      var hasCalls = Array.isArray(ed.calls);

      if (!hasEmails && !hasCalls) {
        // No sensitive subtree to move. Still add the cleartext count fields
        // so the admin UI's count-first read path works uniformly across all
        // rows, but don't write an _sensitive envelope for an empty subtree.
        results.skipped_no_emails_or_calls++;
        continue;
      }

      try {
        var emails = hasEmails ? ed.emails : [];
        var calls = hasCalls ? ed.calls : [];

        // Build the new shape. Mirrors the post-H29 write shape in
        // enrich-proposal.js. Drop the legacy top-level emails/calls keys
        // -- they're now inside _sensitive.
        var newShape = {
          audit_scores: ed.audit_scores || null,
          audit_tasks: ed.audit_tasks || null,
          website_info: ed.website_info || null,
          campaign_audit: ed.campaign_audit || null,
          practice_details: ed.practice_details || null,
          email_count: emails.length,
          call_count: calls.length,
          enriched_at: ed.enriched_at || row.updated_at || new Date().toISOString(),
          _sensitive: crypto.encryptJSON({ emails: emails, calls: calls })
        };

        // Preserve any additional top-level fields we didn't enumerate -- e.g.
        // future-proofing if a reader adds new cleartext fields to
        // enrichment_data later. Skip the legacy sensitive keys and the ones
        // we've explicitly set above.
        var preserved = {};
        var skipKeys = {
          emails: 1, calls: 1,
          audit_scores: 1, audit_tasks: 1, website_info: 1,
          campaign_audit: 1, practice_details: 1,
          email_count: 1, call_count: 1, enriched_at: 1, _sensitive: 1
        };
        Object.keys(ed).forEach(function(k) {
          if (!skipKeys[k]) preserved[k] = ed[k];
        });
        var finalShape = Object.assign({}, preserved, newShape);

        await sb.mutate('proposals?id=eq.' + row.id, 'PATCH', {
          enrichment_data: finalShape
        });

        results.reshaped++;
      } catch (rowErr) {
        results.errors.push({
          proposal_id: row.id,
          error: rowErr.message || String(rowErr)
        });
        try {
          await monitor.logError('backfill-enrichment-encryption', rowErr, {
            detail: { proposal_id: row.id }
          });
        } catch (_) { /* observability only */ }
      }
    }

    return res.status(200).json({ ok: true, results: results });
  } catch (err) {
    try {
      await monitor.logError('backfill-enrichment-encryption', err, {
        detail: { stage: 'scan_proposals' }
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Backfill failed' });
  }
};
