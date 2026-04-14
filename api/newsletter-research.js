// /api/newsletter-research.js
// Two-phase research: SerpAPI searches sequentially, then Claude curates.
// POST { newsletter_id }
// ENV: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, SERPAPI_KEY

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

// SerpAPI Google News search - top 5 results only, minimal fields
async function searchNews(query, apiKey) {
  var url = 'https://serpapi.com/search.json?engine=google_news' +
    '&q=' + encodeURIComponent(query) +
    '&gl=us&hl=en&when=1m' +
    '&api_key=' + apiKey;
  try {
    var resp = await fetch(url);
    if (!resp.ok) {
      console.error('SerpAPI HTTP ' + resp.status + ' for "' + query + '"');
      return [];
    }
    var text = await resp.text();
    var data = JSON.parse(text);
    text = null; // free memory
    var results = [];
    var items = data.news_results || [];
    var limit = Math.min(items.length, 5);
    for (var i = 0; i < limit; i++) {
      var item = items[i];
      if (item.title) {
        results.push({
          title: item.title,
          snippet: (item.snippet || '').substring(0, 150),
          source: (item.source && item.source.name) || '',
          link: item.link || '',
          date: item.date || ''
        });
      }
    }
    data = null; // free memory
    return results;
  } catch (e) {
    console.error('SerpAPI failed for "' + query + '":', e.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
  // Top-level safety catch to prevent silent crashes
  try {
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
      newsletter = await sb.one('newsletters?id=eq.' + newsletterId + '&select=id,edition_number,status&limit=1');
      if (!newsletter) return res.status(404).json({ error: 'Newsletter not found' });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to load newsletter: ' + e.message });
    }

    // Load previous stories for dedup
    var previousHeadlines = [];
    try {
      var recent = await sb.query('newsletter_stories?select=headline&order=created_at.desc&limit=50');
      previousHeadlines = (recent || []).map(function(s) { return s.headline; });
    } catch (e) { /* non-fatal */ }

    // Phase 1: SerpAPI searches — SEQUENTIAL to avoid OOM
    var searchQueries = [
      'Google Business Profile updates therapists',
      'HIPAA enforcement healthcare privacy',
      'AI therapy mental health practice tools',
      'telehealth Medicare policy changes',
      'local SEO Google algorithm healthcare',
      'FTC healthcare advertising enforcement'
    ];

    console.log('Newsletter research: starting ' + searchQueries.length + ' sequential searches');

    var allResults = [];
    for (var qi = 0; qi < searchQueries.length; qi++) {
      try {
        var results = await searchNews(searchQueries[qi], serpApiKey);
        console.log('Search ' + (qi + 1) + '/' + searchQueries.length + ': "' + searchQueries[qi] + '" -> ' + results.length + ' results');
        allResults = allResults.concat(results);
      } catch (e) {
        console.error('Search ' + (qi + 1) + ' failed:', e.message);
      }
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
    var totalFound = uniqueResults.length;
    allResults = null; // free memory

    if (uniqueResults.length === 0) {
      return res.status(500).json({ error: 'No search results found. SerpAPI may be rate-limited.' });
    }

    console.log('Newsletter research: ' + uniqueResults.length + ' unique results, sending to Claude');

    // Phase 2: Claude analyzes and curates
    var today = new Date().toISOString().split('T')[0];

    var systemPrompt = 'You are a newsletter curator for Moonraker AI, serving therapy practice owners in the U.S. and Canada.\n\nFrom the search results, pick the 8-12 MOST RELEVANT stories. Write your own headlines.\n\nCRITERIA (meet at least 2): recent, has deadlines/dates, actionable for therapists, affects visibility/revenue/compliance, shows AI opportunity.\n\nTOPICS: GBP updates, Google algorithm changes, Medicare/telehealth policy, AI tools for therapists, HIPAA enforcement, FTC advertising, review platforms.\n\nAVOID: general AI news without therapist angle, medical/drug topics, speculation, duplicates.\n\nBALANCE: 70% compliance/risk, 30% AI opportunities.\n\nSORT: Return stories sorted by published_date DESCENDING (most recent first).\n\nToday: ' + today + '\n\nReturn ONLY a JSON array. No markdown, no backticks. Each object:\n{"headline":"...","summary":"2-3 sentences","source_url":"...","source_name":"...","published_date":"YYYY-MM-DD","relevance_note":"...","image_suggestion":"..."}';

    // Build compact search text
    var searchText = uniqueResults.length + ' search results:\n\n';
    for (var s = 0; s < uniqueResults.length; s++) {
      var item = uniqueResults[s];
      searchText += (s + 1) + '. ' + item.title + ' (' + item.source + ', ' + item.date + ') ' + item.link + '\n';
      if (item.snippet) searchText += '   ' + item.snippet + '\n';
    }
    uniqueResults = null; // free memory

    if (previousHeadlines.length > 0) {
      searchText += '\nPreviously covered (avoid):\n' +
        previousHeadlines.slice(0, 20).map(function(h) { return '- ' + h; }).join('\n') + '\n';
    }

    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: searchText }],
        temperature: 0.5
      })
    });

    if (!aiResp.ok) {
      var errBody = await aiResp.text();
      return res.status(500).json({ error: 'Anthropic API error ' + aiResp.status + ': ' + errBody.substring(0, 300) });
    }

    var aiData = await aiResp.json();
    var rawText = '';
    if (aiData.content) {
      for (var c = 0; c < aiData.content.length; c++) {
        if (aiData.content[c].type === 'text') rawText += aiData.content[c].text;
      }
    }

    if (!rawText) {
      return res.status(500).json({ error: 'No text response from AI' });
    }

    // Parse JSON
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var jsonStart = rawText.indexOf('[');
    var jsonEnd = rawText.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(500).json({ error: 'No JSON array in response', preview: rawText.substring(0, 300) });
    }

    var stories = JSON.parse(rawText.substring(jsonStart, jsonEnd + 1));
    if (!Array.isArray(stories) || stories.length === 0) {
      return res.status(500).json({ error: 'Empty stories array' });
    }

    console.log('Newsletter research: Claude returned ' + stories.length + ' stories, saving to DB');

    // Delete existing candidates for this newsletter
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
        if (Array.isArray(row) && row.length) saved.push(row[0]); else if (row && !Array.isArray(row)) saved.push(row);
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
      search_results_found: totalFound,
      stories_curated: stories.length,
      stories_saved: saved.length,
      stories: saved
    });

  } catch (e) {
    console.error('Newsletter research FATAL:', e.message, e.stack);
    try {
      return res.status(500).json({ error: 'Research failed: ' + e.message });
    } catch (e2) {
      // Even res.json failed
    }
  }
};

