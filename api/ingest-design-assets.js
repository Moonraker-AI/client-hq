// /api/ingest-design-assets.js
// Callback from VPS agent after capturing design assets (screenshots, CSS, content).
// Updates design_specs with captured data, then optionally triggers Claude analysis.
//
// POST body: { design_spec_id, screenshots: {homepage, service, about}, computed_css, crawled_text, crawled_urls }

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var sb = require('./_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body;
  if (!body || !body.design_spec_id) {
    return res.status(400).json({ error: 'design_spec_id required' });
  }

  try {
    var updateData = {
      capture_status: 'complete',
      capture_error: null,
      updated_at: new Date().toISOString()
    };

    // Screenshots
    if (body.screenshots) {
      if (body.screenshots.homepage) updateData.screenshot_homepage = body.screenshots.homepage;
      if (body.screenshots.service) updateData.screenshot_service = body.screenshots.service;
      if (body.screenshots.about) updateData.screenshot_about = body.screenshots.about;
    }

    // Computed CSS
    if (body.computed_css) {
      updateData.computed_css = body.computed_css;
    }

    // Crawled text
    if (body.crawled_text) {
      if (body.crawled_text.homepage) updateData.crawled_homepage_text = body.crawled_text.homepage;
      if (body.crawled_text.service) updateData.crawled_service_text = body.crawled_text.service;
      if (body.crawled_text.about) updateData.crawled_about_text = body.crawled_text.about;
    }

    // Crawled URLs
    if (body.crawled_urls) {
      updateData.crawled_urls = body.crawled_urls;
    }

    await sb.mutate('design_specs?id=eq.' + encodeURIComponent(body.design_spec_id), 'PATCH', updateData, 'return=minimal');

    return res.status(200).json({
      success: true,
      design_spec_id: body.design_spec_id,
      screenshots_received: Object.keys(body.screenshots || {}).length,
      has_css: !!(body.computed_css),
      has_text: !!(body.crawled_text)
    });

  } catch (err) {
    monitor.logError('ingest-design-assets', err, {
      detail: { stage: 'ingest_handler' }
    });
    return res.status(500).json({ error: 'Failed to ingest design assets' });
  }
};
