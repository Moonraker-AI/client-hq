// /api/internal-render.js
// TEMPORARY one-shot endpoint to render a content_page to HTML for audit cycles.
// Authenticates via CRON_SECRET. Used during impeccable audit cycles.
//
// GET /api/internal-render?token=<CRON_SECRET>&page_id=<uuid>
// Returns: { html, page_id, page_type, client_slug, page_slug }

var sb = require('./_lib/supabase');
var pageToken = require('./_lib/page-token');
var renderPagePreview = require('./render-page-preview');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var token = (req.query && req.query.token) || '';
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var pageId = (req.query && req.query.page_id) || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pageId)) {
    return res.status(400).json({ error: 'Valid page_id required' });
  }

  var page;
  try {
    page = await sb.one('content_pages?id=eq.' + encodeURIComponent(pageId) + '&limit=1');
  } catch (err) {
    return res.status(500).json({ error: 'Page lookup failed', detail: err.message });
  }
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (!page.contact_id) return res.status(500).json({ error: 'Page missing contact_id' });
  if (!page.client_slug || !page.page_slug) {
    return res.status(500).json({ error: 'Page missing slug fields' });
  }

  var ptToken;
  try {
    ptToken = pageToken.sign({
      scope: 'content_preview',
      contact_id: page.contact_id,
      ttl_seconds: 900
    });
  } catch (err) {
    return res.status(500).json({ error: 'Token mint failed', detail: err.message });
  }

  var cookieName = pageToken.cookieName('content_preview');
  var syntheticReq = {
    method: 'GET',
    query: { slug: page.client_slug, path: page.page_slug, format: 'json' },
    headers: { cookie: cookieName + '=' + ptToken },
    cookies: {}
  };
  syntheticReq.cookies[cookieName] = ptToken;

  var captured = { status: 200, headers: {}, body: null };
  var syntheticRes = {
    status: function(code) { captured.status = code; return syntheticRes; },
    setHeader: function(k, v) { captured.headers[k.toLowerCase()] = v; return syntheticRes; },
    json: function(obj) { captured.body = obj; captured.headers['content-type'] = 'application/json'; return syntheticRes; },
    send: function(body) { captured.body = body; return syntheticRes; },
    end: function(body) { if (body != null) captured.body = body; return syntheticRes; }
  };

  try {
    await renderPagePreview(syntheticReq, syntheticRes);
  } catch (err) {
    return res.status(500).json({ error: 'Render failed', detail: err.message, stack: (err.stack||'').slice(0,500) });
  }

  if (captured.status !== 200) {
    return res.status(502).json({
      error: 'Render returned non-200',
      detail: { status: captured.status, body: captured.body }
    });
  }

  var html = '';
  if (captured.body && typeof captured.body === 'object' && captured.body.html) {
    html = captured.body.html;
  } else if (typeof captured.body === 'string') {
    html = captured.body;
  } else {
    return res.status(500).json({ error: 'Unexpected render output', detail: typeof captured.body });
  }

  return res.status(200).json({
    html: html,
    html_length: html.length,
    page_id: page.id,
    page_type: page.page_type,
    client_slug: page.client_slug,
    page_slug: page.page_slug
  });
};
