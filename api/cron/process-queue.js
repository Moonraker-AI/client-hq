// /api/cron/process-queue.js - Process next pending report from queue
// Called every 5 minutes by Vercel Cron, or manually
// Picks ONE pending item where scheduled_for <= now, compiles it

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var auth = req.headers['authorization'];
    var querySecret = req.query && req.query.secret;
    if (auth !== 'Bearer ' + cronSecret && querySecret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var sbHeaders = {
    'apikey': serviceKey,
    'Authorization': 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    // Find the next pending item where scheduled_for <= now
    var now = new Date().toISOString();
    var queueResp = await fetch(
      sbUrl + '/rest/v1/report_queue?status=eq.pending&scheduled_for=lte.' + now + '&order=scheduled_for.asc&limit=1',
      { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );
    var items = await queueResp.json();

    if (!items || items.length === 0) {
      return res.status(200).json({ success: true, message: 'No pending items ready to process', processed: 0 });
    }

    var item = items[0];

    // Mark as processing
    await fetch(sbUrl + '/rest/v1/report_queue?id=eq.' + item.id, {
      method: 'PATCH',
      headers: sbHeaders,
      body: JSON.stringify({ status: 'processing', started_at: now, attempt: (item.attempt || 0) + 1 })
    });

    // Call compile-report via custom domain (VERCEL_URL is behind deployment protection)
    var baseUrl = 'https://clients.moonraker.ai';

    var compileResp = await fetch(baseUrl + '/api/compile-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_slug: item.client_slug,
        report_month: item.report_month
      }),
      signal: AbortSignal.timeout(280000) // 280s timeout (under Vercel's 300s limit)
    });

    var compileText = await compileResp.text();
    var compileResult;
    try {
      compileResult = JSON.parse(compileText);
    } catch (e) {
      // Non-JSON response (HTML error page, timeout, etc.)
      var errorMsg = 'Compile returned non-JSON (HTTP ' + compileResp.status + '): ' + compileText.substring(0, 200);
      await fetch(sbUrl + '/rest/v1/report_queue?id=eq.' + item.id, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString(), error_message: errorMsg })
      });
      return res.status(200).json({ success: false, processed: 1, client_slug: item.client_slug, error: errorMsg });
    }

    if (compileResult.success) {
      // Mark complete
      await fetch(sbUrl + '/rest/v1/report_queue?id=eq.' + item.id, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          status: 'complete',
          completed_at: new Date().toISOString(),
          snapshot_id: compileResult.snapshot_id || null,
          error_message: null
        })
      });

      return res.status(200).json({
        success: true,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        snapshot_id: compileResult.snapshot_id,
        compile_time: compileResult.compile_time || null,
        warnings: compileResult.warnings || []
      });
    } else {
      // Mark failed
      var errorMsg = compileResult.error || compileResult.errors?.join('; ') || 'Unknown compile error';
      await fetch(sbUrl + '/rest/v1/report_queue?id=eq.' + item.id, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: errorMsg
        })
      });

      return res.status(200).json({
        success: false,
        processed: 1,
        client_slug: item.client_slug,
        report_month: item.report_month,
        error: errorMsg,
        warnings: compileResult.warnings || []
      });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
