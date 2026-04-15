// /api/newsletter-verify.js
// Fact-checks generated newsletter stories by fetching source URLs via SerpAPI
// and having Claude compare claims against the source content.
// POST { newsletter_id }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var SERPAPI_KEY = process.env.SERPAPI_KEY || '';

// Fetch a URL's content snippet via SerpAPI cache
async function fetchSourceContent(url, headline) {
  if (!SERPAPI_KEY) return null;
  // Use google search to find cached/snippet content for this URL
  var query = headline.substring(0, 80);
  var searchUrl = 'https://serpapi.com/search.json?engine=google' +
    '&q=' + encodeURIComponent(query) +
    '&num=3&gl=us&hl=en' +
    '&api_key=' + SERPAPI_KEY;
  try {
    var resp = await fetch(searchUrl);
    if (!resp.ok) return null;
    var data = await resp.json();
    var results = data.organic_results || [];
    // Find the matching or most relevant result
    var snippets = results.map(function(r) {
      return r.title + '. ' + (r.snippet || '');
    }).join('\n');
    // Also grab knowledge panel or answer box if available
    if (data.answer_box && data.answer_box.snippet) {
      snippets = 'Answer: ' + data.answer_box.snippet + '\n' + snippets;
    }
    return snippets || null;
  } catch (e) {
    console.error('Source fetch failed for "' + headline + '":', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    var user = await auth.requireAdmin(req, res);
    if (!user) return;

    var anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    if (!SERPAPI_KEY) return res.status(500).json({ error: 'SERPAPI_KEY not configured' });

    var newsletterId = (req.body || {}).newsletter_id;
    var singleIndex = (req.body || {}).story_index; // optional: 0-indexed, verify only this story
    if (!newsletterId) return res.status(400).json({ error: 'newsletter_id required' });

    // Load newsletter content
    var newsletter;
    try {
      newsletter = await sb.one('newsletters?id=eq.' + newsletterId + '&select=id,content&limit=1');
      if (!newsletter) return res.status(404).json({ error: 'Newsletter not found' });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to load newsletter: ' + e.message });
    }

    var stories = (newsletter.content || {}).stories || [];
    if (stories.length === 0) return res.status(400).json({ error: 'No stories to verify. Generate the draft first.' });

    // Phase 1: Fetch source content (sequential)
    var storiesToCheck = [];
    if (singleIndex !== undefined && singleIndex !== null) {
      var si = parseInt(singleIndex);
      if (stories[si]) storiesToCheck.push({ story: stories[si], idx: si });
    } else {
      stories.forEach(function(s, i) { storiesToCheck.push({ story: s, idx: i }); });
    }

    if (storiesToCheck.length === 0) return res.status(400).json({ error: 'No stories to verify.' });

    console.log('Newsletter verify: checking ' + storiesToCheck.length + ' story(ies)');
    var storyData = [];
    for (var i = 0; i < storiesToCheck.length; i++) {
      var s = storiesToCheck[i].story;
      var sourceContent = await fetchSourceContent(s.source_url || '', s.headline || '');
      storyData.push({
        index: storiesToCheck[i].idx + 1,
        headline: s.headline || '',
        body: (s.body || '').replace(/<[^>]*>/g, ' ').substring(0, 500),
        actions: s.actions || '',
        source_url: s.source_url || '',
        source_content: sourceContent || '(no source content found)'
      });
    }

    // Phase 2: Claude reviews all stories at once
    var systemPrompt = 'You are a fact-checker for a newsletter targeting therapy practice owners. For each story, compare the newsletter text against the source content snippets. Flag any issues.\n\n' +
      'CHECK FOR:\n' +
      '- Incorrect dates, deadlines, or timelines\n' +
      '- Wrong dollar amounts, penalties, or statistics\n' +
      '- Misattributed quotes or sources\n' +
      '- Claims not supported by the source material\n' +
      '- Outdated information presented as current\n\n' +
      'Return ONLY a JSON array. No markdown, no backticks. Each object:\n' +
      '{"story_index": 1, "confidence": "high|medium|low", "issues": ["issue 1", "issue 2"], "notes": "brief summary"}';

    var userPrompt = 'Fact-check these ' + storyData.length + ' newsletter stories:\n\n';
    storyData.forEach(function(sd) {
      userPrompt += '--- Story ' + sd.index + ' ---\n';
      userPrompt += 'Headline: ' + sd.headline + '\n';
      userPrompt += 'Body: ' + sd.body + '\n';
      userPrompt += 'Source URL: ' + sd.source_url + '\n';
      userPrompt += 'Source content: ' + sd.source_content + '\n\n';
    });

    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.2
      })
    });

    if (!aiResp.ok) {
      var errBody = await aiResp.text();
      return res.status(500).json({ error: 'Anthropic API error: ' + aiResp.status });
    }

    var aiData = await aiResp.json();
    var rawText = '';
    if (aiData.content) {
      for (var c = 0; c < aiData.content.length; c++) {
        if (aiData.content[c].type === 'text') rawText += aiData.content[c].text;
      }
    }

    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var jsonStart = rawText.indexOf('[');
    var jsonEnd = rawText.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(500).json({ error: 'No JSON in verification response' });
    }

    var results = JSON.parse(rawText.substring(jsonStart, jsonEnd + 1));

    console.log('Newsletter verify: completed, ' + results.length + ' stories checked');

    return res.status(200).json({
      success: true,
      results: results
    });

  } catch (e) {
    console.error('Newsletter verify FATAL:', e.message);
    return res.status(500).json({ error: 'Verification failed: ' + e.message });
  }
};

