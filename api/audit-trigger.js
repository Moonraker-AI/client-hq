// /api/_audit-trigger.js
// TEMPORARY one-shot GET wrapper to invoke the agent design audit when
// the operator's network can't make outbound HTTPS calls. Authenticates
// via a query-string token matching CRON_SECRET. To be deleted once the
// Step 4 close-out audit run is captured.
//
// Usage: GET /api/_audit-trigger?token=<CRON_SECRET>&url=<target>

var fetchT = require('./_lib/fetch-with-timeout');

module.exports = async function(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var token = (req.query && req.query.token) || '';
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var url = (req.query && req.query.url) || '';
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url query param required (http/https)' });
  }

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: 'Agent not configured' });
  }

  try {
    var r = await fetchT(AGENT_URL + '/tasks/design-audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify({ url: url, timeout_seconds: 30 })
    }, 70000);

    var body = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(body);
  } catch (err) {
    return res.status(502).json({ error: 'Agent call failed', detail: err.message });
  }
};
