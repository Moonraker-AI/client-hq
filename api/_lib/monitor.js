// api/_lib/monitor.js
// Lightweight error monitoring: logs to Supabase error_log table + alerts via Resend.
// No external dependencies (uses existing Supabase + Resend infrastructure).
//
// Usage:
//   var monitor = require('./_lib/monitor');
//   try { ... } catch (err) {
//     await monitor.logError('compile-report', err, { client_slug: slug });
//     // Or for critical errors that should alert the team:
//     await monitor.critical('stripe-webhook', err, { session_id: '...' });
//   }

var sb = require('./supabase');

// Log an error to the error_log table. Non-blocking (fire-and-forget).
async function logError(route, error, opts) {
  opts = opts || {};
  var severity = opts.severity || 'error';
  var clientSlug = opts.client_slug || opts.slug || null;

  var message = '';
  var detail = {};

  if (error instanceof Error) {
    message = error.message;
    detail = { stack: error.stack, name: error.name };
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = JSON.stringify(error);
    detail = error;
  }

  // Merge any extra context
  if (opts.detail) {
    detail = Object.assign(detail, opts.detail);
  }

  // Truncate message to 1000 chars
  if (message.length > 1000) message = message.substring(0, 1000);

  // Also console.error for Vercel logs (ephemeral but immediate).
  // N3: sanitize CR/LF so user-sourced content that propagates into error.message
  // (e.g. PostgREST echoing an invalid slug) cannot forge multi-line log entries.
  var safeMessage = message.replace(/[\r\n]+/g, ' \\n ');
  console.error('[' + severity.toUpperCase() + '] ' + route + ': ' + safeMessage);

  try {
    await sb.mutate('error_log', 'POST', {
      route: route,
      error_type: opts.error_type || 'runtime',
      message: message,
      detail: detail,
      client_slug: clientSlug,
      severity: severity
    }, 'return=minimal');
  } catch (e) {
    // If we can't log to Supabase, at least console.error
    console.error('monitor: failed to log error:', e.message);
  }
}

// Log a critical error + send alert email to team
async function critical(route, error, opts) {
  opts = opts || {};
  opts.severity = 'critical';
  await logError(route, error, opts);

  // Send alert email
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  var message = error instanceof Error ? error.message : String(error);
  var slug = opts.client_slug || opts.slug || '';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Moonraker Alerts <notifications@clients.moonraker.ai>',
        to: ['chris@moonraker.ai'],
        subject: 'CRITICAL: ' + route + (slug ? ' (' + slug + ')' : ''),
        html: '<div style="font-family:Inter,sans-serif;padding:20px;">' +
          '<h2 style="color:#EF4444;margin:0 0 12px;">Critical Error</h2>' +
          '<p><strong>Route:</strong> ' + escHtml(route) + '</p>' +
          (slug ? '<p><strong>Client:</strong> ' + escHtml(slug) + '</p>' : '') +
          '<p><strong>Error:</strong> ' + escHtml(message) + '</p>' +
          '<p><strong>Time:</strong> ' + new Date().toISOString() + '</p>' +
          '<hr style="border:1px solid #E2E8F0;margin:16px 0;">' +
          '<p style="font-size:12px;color:#6B7599;">View error log in <a href="https://clients.moonraker.ai/admin/">Client HQ Admin</a></p>' +
          '</div>'
      })
    });
  } catch (e) {
    console.error('monitor: failed to send critical alert:', e.message);
  }
}

// Log a warning (lower severity, no email)
async function warn(route, message, opts) {
  opts = opts || {};
  opts.severity = 'warning';
  await logError(route, message, opts);
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { logError: logError, critical: critical, warn: warn };
