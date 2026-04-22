// /api/cron/agent-error-alerter.js
// Daily cron that groups recent entity_audits agent_error rows by
// last_agent_error_code and emails chris@moonraker.ai when any group
// crosses a threshold of 3+ rows in the past 72h.
//
// Scheduled in vercel.json: "15 8 * * *" (08:15 UTC daily), 15 min
// after cron-heartbeat-check (0 8 * * *), stays in the quiet-hour
// cluster near other morning crons, no load-spike overlap.
//
// Auth: CRON_SECRET / admin JWT / AGENT_API_KEY via requireAdminOrInternal.
//
// Suppression: each (source='agent_error_alerter', key=<error_code>)
// combination is recorded in cron_alerts_sent after a successful email.
// Subsequent runs check for a matching row in the last 24h and skip.
// Fail-open: if the suppression check errors, we send anyway (prefer
// over-alerting to silent suppression).
//
// Out of scope:
//   No automatic row remediation. Alert-only. Chris decides what to do
//   (regen, terminate, VPS investigation, etc.).
//   No threshold tuning. 3/72h is hardcoded per spec; change here and
//   document in the PR.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');
var fetchT = require('../_lib/fetch-with-timeout');
var email = require('../_lib/email-template');
var cronRuns = require('../_lib/cron-runs');

var THRESHOLD = 3;
var WINDOW_HOURS = 72;
var SUPPRESSION_HOURS = 24;
var ALERT_SOURCE = 'agent_error_alerter';
var ADMIN_BASE = 'https://clients.moonraker.ai/admin/clients/';

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  }

  try {
    // 1. Pull agent_error rows from the last 72h. Include retriable
    //    so Chris can see BOTH retriable-looping errors and terminals.
    //    Pull client_slug + short audit id so we can build deep-links.
    var windowCutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    var rows = await sb.query(
      'entity_audits' +
      '?status=eq.agent_error' +
      '&last_agent_error_at=gte.' + encodeURIComponent(windowCutoff) +
      '&select=id,client_slug,last_agent_error_code,agent_error_retriable,last_agent_error_at' +
      '&order=last_agent_error_at.desc'
    );

    // 2. Group by code. Treat NULL as its own bucket ("__null_code__")
    //    so it gets alerted if 3+ rows lack instrumentation, a data
    //    quality signal worth surfacing.
    var groups = {};
    if (rows && rows.length > 0) {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var key = r.last_agent_error_code || '__null_code__';
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
      }
    }

    // 3. Filter groups at or above threshold
    var triggered = [];
    Object.keys(groups).forEach(function(k) {
      if (groups[k].length >= THRESHOLD) triggered.push({ code: k, rows: groups[k] });
    });

    if (triggered.length === 0) {
      return res.status(200).json({
        ok: true,
        groups_scanned: Object.keys(groups).length,
        groups_triggered: 0,
        rows_scanned: rows ? rows.length : 0
      });
    }

    // 4. Suppression check. For each triggered group, look up
    //    cron_alerts_sent for a recent send. Fail-open on errors.
    var suppressionCutoff = new Date(Date.now() - SUPPRESSION_HOURS * 60 * 60 * 1000).toISOString();
    var toSend = [];
    var suppressed = [];
    for (var t = 0; t < triggered.length; t++) {
      var grp = triggered[t];
      var recentlyAlerted = false;
      try {
        var prior = await sb.query(
          'cron_alerts_sent' +
          '?alert_source=eq.' + encodeURIComponent(ALERT_SOURCE) +
          '&alert_key=eq.' + encodeURIComponent(grp.code) +
          '&sent_at=gte.' + encodeURIComponent(suppressionCutoff) +
          '&select=id&limit=1'
        );
        recentlyAlerted = !!(prior && prior.length > 0);
      } catch (supprErr) {
        // Fail-open: log but don't suppress. Over-alerting beats silent gap.
        monitor.logError('cron/agent-error-alerter', supprErr, {
          detail: { stage: 'suppression_check', alert_key: grp.code }
        });
        recentlyAlerted = false;
      }
      if (recentlyAlerted) suppressed.push(grp.code);
      else toSend.push(grp);
    }

    if (toSend.length === 0) {
      return res.status(200).json({
        ok: true,
        groups_triggered: triggered.length,
        groups_suppressed: suppressed.length,
        suppressed_codes: suppressed,
        rows_scanned: rows.length
      });
    }

    // 5. Build one email covering all non-suppressed groups.
    //    Keeps mailbox noise low (one daily email vs N).
    var esc = email.esc;
    var p = email.p;
    var pRaw = email.pRaw;

    var bodyParts = [];
    bodyParts.push(p(
      'The agent_error alerter detected ' + toSend.length + ' error ' +
      (toSend.length === 1 ? 'class' : 'classes') + ' crossing the ' +
      THRESHOLD + '/' + WINDOW_HOURS + 'h threshold. Each group is listed ' +
      'below with affected audit rows and deep-link to the client deep-dive.'
    ));

    for (var g = 0; g < toSend.length; g++) {
      var grp2 = toSend[g];
      var codeLabel = grp2.code === '__null_code__'
        ? '(no error code, legacy or uninstrumented)'
        : grp2.code;

      var header =
        '<p style="font-family:Inter,sans-serif;font-size:14px;color:#141C3A;' +
        'font-weight:600;margin:24px 0 8px;">' +
        esc(codeLabel) + ' &middot; ' + grp2.rows.length + ' rows</p>';
      bodyParts.push(pRaw(header));

      var tbl = '<table cellpadding="0" cellspacing="0" border="0" width="100%" ' +
        'style="border-collapse:collapse;font-family:Inter,sans-serif;font-size:13px;color:#141C3A;">';
      tbl += '<tr style="background:#F2F6FC;"><th align="left" style="padding:8px 12px;font-weight:600;">Audit</th>' +
        '<th align="left" style="padding:8px 12px;font-weight:600;">Client</th>' +
        '<th align="left" style="padding:8px 12px;font-weight:600;">Retriable</th>' +
        '<th align="left" style="padding:8px 12px;font-weight:600;">Errored at (UTC)</th></tr>';
      for (var k = 0; k < grp2.rows.length; k++) {
        var row = grp2.rows[k];
        var shortId = String(row.id || '').slice(0, 8);
        var slug = row.client_slug || '';
        var deepLink = slug ? (ADMIN_BASE + encodeURIComponent(slug)) : null;
        var errAt = row.last_agent_error_at
          ? new Date(row.last_agent_error_at).toISOString().replace('T', ' ').slice(0, 16)
          : '';
        var retriableBadge = row.agent_error_retriable
          ? '<span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:10px;font-size:11px;">retriable</span>'
          : '<span style="background:#E5E7EB;color:#374151;padding:2px 8px;border-radius:10px;font-size:11px;">terminal</span>';
        tbl +=
          '<tr style="border-bottom:1px solid #E2E8F0;">' +
            '<td style="padding:8px 12px;font-family:ui-monospace,Menlo,monospace;">' + esc(shortId) + '</td>' +
            '<td style="padding:8px 12px;">' +
              (deepLink
                ? '<a href="' + esc(deepLink) + '" style="color:#00D47E;text-decoration:none;">' + esc(slug) + '</a>'
                : esc(slug || '(no slug)')) +
            '</td>' +
            '<td style="padding:8px 12px;">' + retriableBadge + '</td>' +
            '<td style="padding:8px 12px;color:#6B7599;">' + esc(errAt) + '</td>' +
          '</tr>';
      }
      tbl += '</table>';
      bodyParts.push(pRaw(tbl));
    }

    if (suppressed.length > 0) {
      bodyParts.push(pRaw(
        '<p style="font-family:Inter,sans-serif;font-size:12px;color:#6B7599;margin-top:24px;">' +
        'Also triggered but suppressed (already alerted within the last ' + SUPPRESSION_HOURS + 'h): ' +
        esc(suppressed.join(', ')) +
        '</p>'
      ));
    }

    var htmlBody = email.wrap({
      headerLabel: 'Agent error digest',
      content: bodyParts.join(''),
      footerNote: 'Suppressed for ' + SUPPRESSION_HOURS + 'h per error code. ' +
        'Threshold ' + THRESHOLD + ' rows / ' + WINDOW_HOURS + 'h window.'
    });

    // 6. Send via Resend
    var resendResp = await fetchT('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Moonraker Alerts <notifications@clients.moonraker.ai>',
        to: 'chris@moonraker.ai',
        subject: 'Agent error digest: ' + toSend.length + ' code(s) over threshold',
        html: htmlBody
      })
    }, 15000);

    if (!resendResp.ok) {
      var errText = '';
      try { errText = await resendResp.text(); } catch (e) { /* noop */ }
      monitor.logError('cron/agent-error-alerter', new Error('Resend HTTP ' + resendResp.status), {
        detail: { stage: 'send', status: resendResp.status, body: errText.substring(0, 400) }
      });
      return res.status(500).json({
        ok: false,
        error: 'email_send_failed',
        resend_status: resendResp.status
      });
    }

    // 7. Record suppression entries, one per sent group.
    //    Per-group insert so a single failure doesn't lose the others.
    var recorded = 0;
    for (var s = 0; s < toSend.length; s++) {
      try {
        await sb.mutate('cron_alerts_sent', 'POST', {
          alert_source: ALERT_SOURCE,
          alert_key: toSend[s].code,
          detail: {
            row_count: toSend[s].rows.length,
            audit_ids: toSend[s].rows.map(function(r) { return r.id; }),
            threshold: THRESHOLD,
            window_hours: WINDOW_HOURS
          }
        }, 'return=minimal');
        recorded++;
      } catch (recErr) {
        monitor.logError('cron/agent-error-alerter', recErr, {
          detail: { stage: 'record_suppression', alert_key: toSend[s].code }
        });
      }
    }

    return res.status(200).json({
      ok: true,
      rows_scanned: rows.length,
      groups_triggered: triggered.length,
      groups_sent: toSend.length,
      groups_suppressed: suppressed.length,
      suppressed_codes: suppressed,
      suppression_recorded: recorded
    });
  } catch (e) {
    console.error('[agent-error-alerter] error:', e.message);
    monitor.logError('cron/agent-error-alerter', e, {
      detail: { stage: 'handler' }
    });
    return res.status(500).json({ error: 'Agent error alerter failed' });
  }
}

module.exports = cronRuns.withTracking('agent-error-alerter', handler);
