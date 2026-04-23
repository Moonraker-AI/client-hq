// /api/newsletter-regenerate-story.js
// Generates full body + action items for a single story from its headline/summary.
// POST { headline, summary?, source_name?, source_url? }

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    var user = await auth.requireAdmin(req, res);
    if (!user) return;

    var anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    var b = req.body || {};
    if (!b.headline) return res.status(400).json({ error: 'headline required' });

    var prompt = 'Write newsletter content for therapy practice owners about this story.\n\n' +
      'Headline: ' + b.headline + '\n' +
      (b.summary ? 'Summary: ' + b.summary + '\n' : '') +
      (b.source_name ? 'Source: ' + b.source_name + '\n' : '') +
      (b.source_url ? 'URL: ' + b.source_url + '\n' : '') +
      '\nRules:\n' +
      '- Body: 1-2 paragraphs, 100-150 words, use <p> tags\n' +
      '- Include specific dates, numbers, or penalties where available\n' +
      '- Professional but accessible tone for therapists\n' +
      '- Use "client" not "patient"\n' +
      '- Do NOT use em dashes. Use commas, colons, or periods.\n' +
      '- Actions: exactly 3 specific, implementable steps (one per line, plain text)\n\n' +
      'Return ONLY JSON, no markdown: {"body":"<p>...</p>","actions":"line1\\nline2\\nline3"}';

    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        temperature: 0.4,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiResp.ok) return res.status(500).json({ error: 'Anthropic error: ' + aiResp.status });

    var aiData = await aiResp.json();
    var rawText = (aiData.content || []).filter(function(bl) { return bl.type === 'text'; }).map(function(bl) { return bl.text; }).join('');
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    var js = rawText.indexOf('{');
    var je = rawText.lastIndexOf('}');
    if (js < 0 || je <= js) return res.status(500).json({ error: 'No JSON in response' });

    var result = JSON.parse(rawText.substring(js, je + 1));

    // Strip em dashes
    function stripEm(s) { return (s || '').replace(/\u2014/g, ', ').replace(/\u2013/g, ', ').replace(/—/g, ', '); }
    result.body = stripEm(result.body);
    result.actions = stripEm(result.actions);

    return res.status(200).json({ success: true, body: result.body, actions: result.actions });
  } catch (e) {
    monitor.logError('newsletter-regenerate-story', e, { detail: { stage: 'regenerate_handler' } });
    return res.status(500).json({ error: 'Regenerate failed' });
  }
};
