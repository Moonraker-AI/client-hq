// api/newsletter-preview.js
// Renders a newsletter as HTML for preview or GHL export.
// GET ?id=newsletter_id        → returns rendered HTML (Content-Type: text/html)
// GET ?id=newsletter_id&raw=1  → returns raw HTML as JSON { html: "..." } for clipboard copy

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var nl = require('./_lib/newsletter-template');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var newsletterId = req.query.id;
  var raw = req.query.raw === '1';

  if (!newsletterId) return res.status(400).json({ error: 'id query param required' });

  try {
    var newsletter = await sb.one('newsletters?id=eq.' + newsletterId + '&select=*&limit=1');
    if (!newsletter) return res.status(404).json({ error: 'Newsletter not found' });

    // Read warmup state so preview reflects what recipients will actually see
    var warmupActive = false;
    try {
      var settings = await sb.query('settings?key=eq.newsletter_warmup&select=value');
      if (settings.length && settings[0].value && settings[0].value.enabled) {
        var w = settings[0].value;
        var step = w.current_step || 0;
        var schedule = w.ramp_schedule || [];
        warmupActive = step < schedule.length;
      }
    } catch (e) { /* non-fatal — preview without warmup flag */ }

    var html = nl.build(newsletter, 'preview', { warmupActive: warmupActive });

    if (raw) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ html: html });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(html);
  } catch (e) {
    monitor.logError('newsletter-preview', e, { detail: { newsletter_id: newsletterId, raw: raw } });
    return res.status(500).json({ error: 'Preview failed' });
  }
};

