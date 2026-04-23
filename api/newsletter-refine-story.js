// /api/newsletter-refine-story.js
// Rewrites a single story to hedge uncertain claims based on fact-check feedback.
// POST { story_index, headline, body, feedback }

var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    var user = await auth.requireAdmin(req, res);
    if (!user) return;

    var anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    var body = req.body || {};
    var headline = body.headline || '';
    var storyBody = body.body || '';
    var feedback = body.feedback || '';
    if (!headline || !storyBody) return res.status(400).json({ error: 'headline and body required' });

    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: 'Rewrite this newsletter story for therapy practice owners. Some facts could not be fully verified. Use hedging language like "according to reports," "sources indicate," or "as reported by" where claims are uncertain. Keep the same structure, tone, and approximate length (100-150 words). Do NOT use em dashes. Use commas, colons, or periods instead.\n\nFact-check feedback: ' + feedback + '\n\nOriginal headline: ' + headline + '\n\nOriginal body:\n' + storyBody + '\n\nReturn ONLY a JSON object with no markdown: {"headline":"refined headline","body":"refined body with <p> tags"}'
        }]
      })
    });

    if (!aiResp.ok) {
      return res.status(500).json({ error: 'Anthropic API error: ' + aiResp.status });
    }

    var aiData = await aiResp.json();
    var rawText = (aiData.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var jsonStart = rawText.indexOf('{');
    var jsonEnd = rawText.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return res.status(500).json({ error: 'No JSON in response' });
    }

    var refined = JSON.parse(rawText.substring(jsonStart, jsonEnd + 1));

    // Strip em dashes
    function stripEm(s) { return (s || '').replace(/\u2014/g, ', ').replace(/\u2013/g, ', ').replace(/ —/g, ',').replace(/— /g, ', ').replace(/—/g, ', '); }
    refined.headline = stripEm(refined.headline);
    refined.body = stripEm(refined.body);

    return res.status(200).json({ success: true, headline: refined.headline, body: refined.body });
  } catch (e) {
    monitor.logError('newsletter-refine-story', e, { detail: { stage: 'refine_handler' } });
    return res.status(500).json({ error: 'Refine failed' });
  }
};
