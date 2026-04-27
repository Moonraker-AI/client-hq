// api/admin/lock-reporting-keywords.js
// "Lock Keywords & Initiate Reporting" button on the Reports tab posts here.
// Pulls target_keyword from every published service-type content_page, creates
// tracked_keywords rows, and stamps report_configs.keywords_locked_at — which
// is the gate /api/cron/enqueue-reports uses to decide who gets compiled.
//
// Readiness gate (all four required, server-enforced):
//   1. report_configs.gbp_location_id
//   2. report_configs.gsc_property
//   3. report_configs.localfalcon_place_id
//   4. >=1 content_pages row with page_type='service' AND target_keyword IS NOT NULL
//
// Idempotency: if keywords_locked_at is already set, returns 409 unless
// ?force=true. Existing active tracked_keywords rows are NEVER deleted —
// per the keyword change protocol, retire only. Force re-lock retires all
// existing rows with reason='relocked' before inserting the new set.
//
// POST body:
//   { client_slug: string }
// Optional:
//   { client_slug, keywords: ["override 1", "override 2"] }   // skip auto-extract
//
// Returns 200 with { keywords_locked_at, locked_by, keyword_count, keywords }.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var clientSlug = body.client_slug;
  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

  var force = req.query && (req.query.force === 'true' || req.query.force === '1');
  var useExisting = body.use_existing === true;
  var manualKeywords = Array.isArray(body.keywords) && body.keywords.length > 0 ? body.keywords : null;

  try {
    // 1. Load report_configs row to enforce readiness gate
    var config = await sb.one(
      'report_configs?client_slug=eq.' + encodeURIComponent(clientSlug) + '&limit=1'
    );
    if (!config) return res.status(404).json({ error: 'No report_configs row for ' + clientSlug });

    var missing = [];
    if (!config.gbp_location_id)      missing.push('gbp_location_id');
    if (!config.gsc_property)         missing.push('gsc_property');
    if (!config.localfalcon_place_id) missing.push('localfalcon_place_id');

    // 2. Already locked? Block unless force.
    if (config.keywords_locked_at && !force) {
      return res.status(409).json({
        error: 'Keywords already locked',
        locked_at: config.keywords_locked_at,
        locked_by: config.keywords_locked_by,
        message: 'Pass ?force=true to relock — this retires existing keywords and replaces them.'
      });
    }

    // 3. Resolve the keyword set. Three modes:
    //    a) use_existing — the client already has tracked_keywords from the
    //       legacy intro-call form; just stamp the lock and return.
    //    b) manual override — explicit list passed in body.keywords.
    //    c) default — pull target_keyword from service pages.
    var sourceLabel = manualKeywords ? 'override' : (useExisting ? 'existing' : 'page_lock');
    var keywords = [];
    var pageMap = {}; // keyword -> target_url for tracked_keywords.target_page
    var skipInsert = false;

    if (useExisting) {
      var existingKws = await sb.query(
        'tracked_keywords?client_slug=eq.' + encodeURIComponent(clientSlug) +
        '&active=eq.true&retired_at=is.null&select=keyword'
      );
      if (!Array.isArray(existingKws) || existingKws.length === 0) {
        return res.status(400).json({
          error: 'use_existing requested but no active tracked_keywords found',
          missing: ['existing_keywords']
        });
      }
      keywords = existingKws.map(function(k) { return k.keyword; });
      skipInsert = true; // rows already exist; we're just stamping the lock
    } else if (manualKeywords) {
      keywords = manualKeywords
        .map(function(k) { return (k || '').trim(); })
        .filter(function(k) { return k.length > 0; });
    } else {
      var pages = await sb.query(
        'content_pages?client_slug=eq.' + encodeURIComponent(clientSlug) +
        '&page_type=eq.service' +
        '&target_keyword=not.is.null' +
        '&select=target_keyword,target_url,page_slug'
      );
      if (!Array.isArray(pages) || pages.length === 0) {
        missing.push('service_pages_with_target_keyword');
      } else {
        var seen = {};
        pages.forEach(function(p) {
          var k = (p.target_keyword || '').trim();
          if (!k) return;
          var lower = k.toLowerCase();
          if (seen[lower]) return; // dedupe case-insensitively, keep first casing
          seen[lower] = true;
          keywords.push(k);
          if (p.target_url) pageMap[k] = p.target_url;
          else if (p.page_slug) pageMap[k] = '/' + p.page_slug;
        });
      }
    }

    // 4. Final readiness check (after attempting to extract keywords).
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Reporting readiness gate not satisfied',
        missing: missing
      });
    }

    if (keywords.length === 0) {
      return res.status(400).json({ error: 'No keywords to lock' });
    }

    // 5. If forcing relock, retire existing active rows first.
    var retiredCount = 0;
    if (force && !skipInsert) {
      var existing = await sb.query(
        'tracked_keywords?client_slug=eq.' + encodeURIComponent(clientSlug) +
        '&active=eq.true&retired_at=is.null&select=id'
      );
      if (Array.isArray(existing) && existing.length > 0) {
        await sb.mutate(
          'tracked_keywords?client_slug=eq.' + encodeURIComponent(clientSlug) +
          '&active=eq.true&retired_at=is.null',
          'PATCH',
          { active: false, retired_at: new Date().toISOString(), retired_reason: 'relocked' },
          'return=minimal'
        );
        retiredCount = existing.length;
      }
    }

    // 6. Insert the new keyword set unless we're locking against existing rows.
    if (!skipInsert) {
      var rows = keywords.map(function(k, idx) {
        return {
          client_slug: clientSlug,
          contact_id: config.contact_id || null,
          keyword: k,
          label: k,
          keyword_type: 'service',
          priority: 2,
          target_page: pageMap[k] || null,
          source: sourceLabel,
          active: true
        };
      });

      await sb.mutate(
        'tracked_keywords',
        'POST',
        rows,
        'return=representation'
      );
    }

    // 7. Stamp the lock onto report_configs.
    var lockedAt = new Date().toISOString();
    await sb.mutate(
      'report_configs?client_slug=eq.' + encodeURIComponent(clientSlug),
      'PATCH',
      {
        keywords_locked_at: lockedAt,
        keywords_locked_by: user.email || user.user_id || 'admin',
        updated_at: lockedAt
      },
      'return=minimal'
    );

    // 8. Audit trail.
    try {
      await sb.mutate('activity_log', 'POST', {
        client_slug: clientSlug,
        table_name: 'report_configs',
        record_id: clientSlug,
        field_name: 'keywords_locked_at',
        old_value: force ? 'relocked' : null,
        new_value: lockedAt,
        changed_by: user.email || 'admin'
      }, 'return=minimal');
    } catch (alErr) {
      // Non-critical; lock already succeeded.
      console.error('lock-reporting-keywords: activity_log write failed', alErr.message);
    }

    return res.status(200).json({
      success: true,
      locked_at: lockedAt,
      locked_by: user.email || 'admin',
      source: sourceLabel,
      keyword_count: keywords.length,
      keywords: keywords,
      retired_count: retiredCount,
      readiness_passed: { gbp: true, gsc: true, lf: true, keywords: true }
    });
  } catch (e) {
    monitor.logError('admin/lock-reporting-keywords', e, {
      client_slug: clientSlug,
      detail: { force: force, manual: !!manualKeywords }
    });
    return res.status(500).json({ error: 'Lock failed', detail: e.message || String(e) });
  }
};
