// /api/ingest-design-assets.js
// Callback from VPS agent after capturing design assets (screenshots, CSS, content).
// Updates design_specs with captured data, then optionally triggers Claude analysis.
//
// POST body: {
//   design_spec_id,
//   screenshots: {homepage, service, about},
//   computed_css,
//   crawled_text,
//   crawled_urls,
//   capture_errors: {homepage: '...', ...},   // 2026-04-26: new
//   pages_attempted: ['homepage','service','about'],   // 2026-04-26: new
//   pages_succeeded: ['service']                       // 2026-04-26: new
// }
//
// 2026-04-26: capture_status is now honest. Previously this endpoint blindly
// wrote 'complete' regardless of payload completeness, which masked the
// agent's silent partial-capture bug (only 1/3 pages screenshotted, no CSS).
// Status now reflects what actually came back:
//   - 'failed'   : 0 pages succeeded
//   - 'partial'  : 1+ but fewer than attempted
//   - 'complete' : all attempted pages have screenshots
// Older agent versions that don't send pages_succeeded/pages_attempted fall
// back to inferring from screenshots/css presence.

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
    var screenshots = body.screenshots || {};
    var captureErrors = body.capture_errors || null;
    var pagesAttempted = Array.isArray(body.pages_attempted) ? body.pages_attempted : null;
    var pagesSucceeded = Array.isArray(body.pages_succeeded) ? body.pages_succeeded : null;

    // Compute honest capture_status.
    var status;
    var statusError = null;

    if (pagesAttempted && pagesSucceeded) {
      // New-format payload from rewritten agent.
      if (pagesSucceeded.length === 0) {
        status = 'failed';
        statusError = summarizeErrors(captureErrors) || 'No pages captured';
      } else if (pagesSucceeded.length < pagesAttempted.length) {
        status = 'partial';
        statusError = summarizeErrors(captureErrors);
      } else {
        status = 'complete';
      }
    } else {
      // Legacy payload — infer from screenshots presence.
      var screenshotCount = ['homepage','service','about'].filter(function(k){ return !!screenshots[k]; }).length;
      if (screenshotCount === 0) {
        status = 'failed';
        statusError = 'No screenshots received';
      } else if (screenshotCount < 3) {
        status = 'partial';
      } else {
        status = 'complete';
      }
    }

    var updateData = {
      capture_status: status,
      capture_error: statusError,
      capture_errors: captureErrors,
      pages_attempted: pagesAttempted,
      pages_succeeded: pagesSucceeded,
      updated_at: new Date().toISOString()
    };

    // Screenshots
    if (screenshots.homepage) updateData.screenshot_homepage = screenshots.homepage;
    if (screenshots.service) updateData.screenshot_service = screenshots.service;
    if (screenshots.about) updateData.screenshot_about = screenshots.about;

    // Computed CSS
    if (body.computed_css && Object.keys(body.computed_css).length > 0) {
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

    await sb.mutate(
      'design_specs?id=eq.' + encodeURIComponent(body.design_spec_id),
      'PATCH',
      updateData,
      'return=minimal'
    );

    // Log partials/failures so they don't slip past observability.
    if (status === 'partial' || status === 'failed') {
      monitor.logError('ingest-design-assets', new Error('Capture ' + status), {
        detail: {
          design_spec_id: body.design_spec_id,
          status: status,
          pages_attempted: pagesAttempted,
          pages_succeeded: pagesSucceeded,
          capture_errors: captureErrors,
          summary: statusError
        }
      });
    }

    return res.status(200).json({
      success: true,
      design_spec_id: body.design_spec_id,
      capture_status: status,
      screenshots_received: Object.keys(screenshots).filter(function(k){ return !!screenshots[k]; }).length,
      has_css: !!(body.computed_css && Object.keys(body.computed_css).length > 0),
      has_text: !!(body.crawled_text)
    });

  } catch (err) {
    monitor.logError('ingest-design-assets', err, {
      detail: { stage: 'ingest_handler' }
    });
    return res.status(500).json({ error: 'Failed to ingest design assets' });
  }
};

function summarizeErrors(errs) {
  if (!errs || typeof errs !== 'object') return null;
  var parts = [];
  for (var k in errs) {
    if (Object.prototype.hasOwnProperty.call(errs, k) && errs[k]) {
      parts.push(k + ': ' + String(errs[k]).substring(0, 100));
    }
  }
  return parts.length ? parts.join('; ').substring(0, 500) : null;
}
