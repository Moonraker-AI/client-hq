// /api/newsletter-research.js
// Two-phase research: SerpAPI searches for recent news, Claude analyzes and curates.
// POST { newsletter_id }
// ENV: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, SERPAPI_KEY

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

// SerpAPI Google News search
async function searchNews(query, apiKey) {
  var url = 'https://serpapi.com/search.json?engine=google_news' +
    '&q=' + encodeURIComponent(query) +
    '&gl=us&hl=en' +
    '&api_key=' + apiKey;
  try {
    var resp = await fetch(url);
    if (!resp.ok) return [];
    var data = await resp.json();
    var results = [];
    // Google News returns news_results array
    var items = data.news_results || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      results.push({
        title: item.title || '',
        snippet: item.snippet || '',
        source: (item.source && item.source.name) || '',
        link: item.link || '',
        date: item.date || ''
      });
      // Also check sub-stories (Google News clusters)
      if (item.stories && item.stories.length) {
        for (var j = 0; j < item.stories.length; j++) {
          var sub = item.stories[j];
          results.push({
            title: sub.title || '',
            snippet: sub.snippet || '',
            source: (sub.source && sub.source.name) || '',
            link: sub.link || '',
            date: sub.date || ''
          });
        }
      }
    }
    return results;
  } catch (e) {
    console.error('SerpAPI search failed for "' + query + '":', e.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var serpApiKey = process.env.SERPAPI_KEY;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!serpApiKey) return res.status(500).json({ error: 'SERPAPI_KEY not configured' });

  var newsletterId = (req.body || {}).newsletter_id;
  if (!newsletterId) return res.status(400).json({ error: 'newsletter_id required' });

  // Load the newsletter
  var newsletter;
  try {
    newsletter = await sb.one('newsletters?id=eq.' + newsletterId + '&select=*&limit=1');
    if (!newsletter) return res.status(404).json({ error: 'Newsletter not found' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load newsletter: ' + e.message });
  }

  // Load previous stories for dedup
  var previousHeadlines = [];
  try {
    var recent = await sb.query('newsletter_stories?select=headline&order=created_at.desc&limit=80');
    previousHeadlines = (recent || []).map(function(s) { return s.headline; });
  } catch (e) { /* non-fatal */ }

  // Phase 1: SerpAPI searches (parallel)
  var searchQueries = [
    'Google Business Profile updates therapists 2026',
    'HIPAA enforcement healthcare privacy 2026',
    'AI chatbot therapy mental health practice',
    'telehealth Medicare Medicaid policy changes 2026',
    'local SEO Google algorithm update healthcare',
    'FTC healthcare advertising enforcement compliance',
    'therapist private practice marketing digital',
    'mental health practice technology AI tools'
  ];

  var allResults = [];
  try {
    var searchPromises = searchQueries.map(function(q) { return searchNews(q, serpApiKey); });
    var searchResults = await Promise.all(searchPromises);
    for (var i = 0; i < searchResults.length; i++) {
      allResults = allResults.concat(searchResults[i]);
    }
  } catch (e) {
    return res.status(500).json({ error: 'Search phase failed: ' + e.message });
  }

  // Deduplicate by URL
  var seen = {};
  var uniqueResults = [];
  for (var r = 0; r < allResults.length; r++) {
    var key = allResults[r].link || allResults[r].title;
    if (!seen[key]) {
      seen[key] = true;
      uniqueResults.push(allResults[r]);
    }
  }

  if (uniqueResults.length === 0) {
    return res.status(500).json({ error: 'No search results found. SerpAPI may be rate-limited.' });
  }

  // Phase 2: Claude analyzes and curates
  var today = new Date().toISOString().split('T')[0];

  var systemPrompt = 'You are a newsletter curator for Moonraker AI, a digital marketing agency serving therapy practice owners (solo and group practices) in the U.S. and Canada.\n\n' +
    'You will receive raw search results from Google News. Your job is to identify the 8-12 MOST RELEVANT stories for therapy practice owners and write structured story objects.\n\n' +
    'STORY SELECTION CRITERIA (must meet at least 2):\n' +
    '- Recent (within past 7-10 days)\n' +
    '- Has specific dates, deadlines, or enforcement timelines\n' +
    '- Has clear, actionable next steps therapists can take\n' +
    '- Affects practice visibility, client acquisition, revenue, or compliance\n' +
    '- Has penalty, risk, or compliance implications\n' +
    '- Shows practical AI opportunity for therapists\n\n' +
    'PRIORITY TOPICS:\n' +
    '- Google Business Profile updates, suspensions, policy changes\n' +
    '- Google algorithm updates affecting local search\n' +
    '- Medicare/Medicaid telehealth coverage changes\n' +
    '- AI chatbot and LLM developments relevant to therapists\n' +
    '- HIPAA enforcement actions, OCR settlements\n' +
    '- State AI and telehealth legislation\n' +
    '- Review platform policy changes\n' +
    '- FTC healthcare advertising enforcement\n' +
    '- AI tools solving real therapy practice problems\n\n' +
    'AVOID:\n' +
    '- General AI news without therapist application\n' +
    '- General medical/prescription drug topics\n' +
    '- Speculative predictions without actionable items\n' +
    '- Duplicate coverage of the same event\n\n' +
    'BALANCE: Roughly 70% urgent compliance/risk news, 30% positive AI opportunities.\n\n' +
    'Today\'s date: ' + today + '\n\n' +
    'Respond with ONLY a JSON array. No markdown, no backticks, no preamble. Each object:\n' +
    '{\n' +
    '  "headline": "Clear, specific headline (write your own, do not just copy the search title)",\n' +
    '  "summary": "2-3 sentence summary of what happened and why therapists should care",\n' +
    '  "source_url": "URL from the search results",\n' +
    '  "source_name": "Publication name",\n' +
    '  "published_date": "YYYY-MM-DD or approximate",\n' +
    '  "relevance_note": "One sentence on why this matters for therapy practices specifically",\n' +
    '  "image_suggestion": "Description of a relevant stock image for this story"\n' +
    '}';

  // Build the search results text for Claude
  var searchText = 'Here are ' + uniqueResults.length + ' recent search results from Google News. Select the 8-12 most relevant for therapy practice owners:\n\n';
  for (var s = 0; s < uniqueResults.length; s++) {
    var r = uniqueResults[s];
    searchText += '--- Result ' + (s + 1) + ' ---\n';
    searchText += 'Title: ' + r.title + '\n';
    if (r.snippet) searchText += 'Snippet: ' + r.snippet + '\n';
    searchText += 'Source: ' + r.source + '\n';
    searchText += 'URL: ' + r.link + '\n';
    if (r.date) searchText += 'Date: ' + r.date + '\n';
    searchText += '\n';
  }

  if (previousHeadlines.length > 0) {
    searchText += '\nAVOID these previously covered stories (do NOT repeat):\n' +
      previousHeadlines.slice(0, 30).map(function(h) { return '- ' + h; }).join('\n') + '\n';
  }

  try {
    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: 'user', content: searchText }],
        temperature: 0.5
      })
    });

    if (!aiResp.ok) {
      var errBody = await aiResp.text();
      var errMsg = 'Anthropic API error ' + aiResp.status;
      try {
        var errJson = JSON.parse(errBody);
        errMsg += ': ' + (errJson.error && errJson.error.message || errBody.substring(0, 200));
      } catch (e) { errMsg += ': ' + errBody.substring(0, 200); }
      return res.status(500).json({ error: errMsg });
    }

    var aiData = await aiResp.json();
    var rawText = '';
    if (aiData.content) {
      for (var c = 0; c < aiData.content.length; c++) {
        if (aiData.content[c].type === 'text' && aiData.content[c].text) {
          rawText += aiData.content[c].text;
        }
      }
    }

    if (!rawText) {
      return res.status(500).json({ error: 'No text response from AI', debug: { stop_reason: aiData.stop_reason } });
    }

    // Parse JSON
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var jsonStart = rawText.indexOf('[');
    var jsonEnd = rawText.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(500).json({ error: 'No JSON array in AI response', raw_preview: rawText.substring(0, 500) });
    }

    var stories = JSON.parse(rawText.substring(jsonStart, jsonEnd + 1));
    if (!Array.isArray(stories) || stories.length === 0) {
      return res.status(500).json({ error: 'Empty stories array' });
    }

    // Delete existing candidates for this newsletter (re-research)
    try {
      await sb.mutate('newsletter_stories?newsletter_id=eq.' + newsletterId, 'DELETE');
    } catch (e) { /* may not exist */ }

    // Save stories to database
    var saved = [];
    for (var si = 0; si < stories.length; si++) {
      var story = stories[si];
      try {
        var row = await sb.mutate('newsletter_stories', 'POST', {
          newsletter_id: newsletterId,
          headline: (story.headline || '').substring(0, 500),
          summary: story.summary || '',
          source_url: story.source_url || '',
          source_name: story.source_name || '',
          published_date: story.published_date || null,
          relevance_note: story.relevance_note || '',
          image_suggestion: story.image_suggestion || '',
          selected: false,
          sort_order: si,
          ai_generated: true
        });
        if (row) saved.push(row);
      } catch (e) {
        console.error('Failed to save story:', story.headline, e.message);
      }
    }

    // Update newsletter status
    await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', {
      status: 'researched',
      updated_at: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      search_results_found: uniqueResults.length,
      stories_curated: stories.length,
      stories_saved: saved.length,
      stories: saved
    });

  } catch (e) {
    return res.status(500).json({ error: 'Research failed: ' + e.message });
  }
};
