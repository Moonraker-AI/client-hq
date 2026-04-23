// /api/newsletter-research.js
// Two-phase research: SerpAPI searches sequentially (core + rotating + CA pools), then Claude curates.
// POST { newsletter_id }
// ENV: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, SERPAPI_KEY

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

// ----- Query pools (Tier 2) -----
// Core: always run. Non-negotiable beats.
var CORE_QUERIES = [
  'Google Business Profile updates therapists',
  'HIPAA enforcement healthcare privacy',
  'Medicare telehealth policy changes'
];

// Rotating: pick ROTATING_WINDOW per run based on edition_number.
// Full pool covered every ceil(length / window) editions.
var ROTATING_POOL = [
  'AI therapy mental health practice tools',
  'AI mental health regulation',
  'local SEO Google algorithm healthcare',
  'Google core update healthcare',
  'FTC healthcare advertising enforcement',
  'review platform therapist reputation',
  'telehealth insurance reimbursement',
  'private practice business news',
  'Psychology Today directory',
  'mental health practice software',
  'EHR HIPAA breach',
  'state psychology board licensing',
  'insurance credentialing therapists',
  'mental health parity enforcement',
  'Google Maps ranking local business'
];
var ROTATING_WINDOW = 5;

// Canadian: one per run, rotating. Uses gl=ca locale.
var CA_POOL = [
  'PHIPA Ontario health privacy',
  'Canada telehealth psychotherapy regulation',
  'CRTC mental health advertising'
];
var CA_WINDOW = 1;

// Deterministic sliding window: edition N -> items starting at (N*window % len), wrapping.
function pickRotating(pool, editionNumber, windowSize) {
  var n = Number(editionNumber) || 0;
  var start = (n * windowSize) % pool.length;
  if (start < 0) start += pool.length;
  var picked = [];
  for (var i = 0; i < windowSize; i++) {
    picked.push(pool[(start + i) % pool.length]);
  }
  return picked;
}

// SerpAPI Google News search, locale-aware
async function searchNews(query, apiKey, locale) {
  var gl = locale === 'ca' ? 'ca' : 'us';
  var url = 'https://serpapi.com/search.json?engine=google' +
    '&q=' + encodeURIComponent(query) +
    '&tbm=nws&num=10&tbs=qdr:m' +
    '&gl=' + gl + '&hl=en' +
    '&api_key=' + apiKey;
  try {
    var resp = await fetch(url);
    if (!resp.ok) {
      console.error('SerpAPI HTTP ' + resp.status + ' for "' + query + '" (' + gl + ')');
      return [];
    }
    var data = await resp.json();
    var results = [];
    var items = data.news_results || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.title) {
        results.push({
          title: item.title,
          snippet: (item.snippet || '').substring(0, 300),
          source: item.source || '',
          link: item.link || '',
          date: item.date || ''
        });
      }
    }
    return results;
  } catch (e) {
    console.error('SerpAPI failed for "' + query + '":', e.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
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

    // Load newsletter (need edition_number for rotation)
    var newsletter;
    try {
      newsletter = await sb.one('newsletters?id=eq.' + newsletterId + '&select=id,edition_number,status&limit=1');
      if (!newsletter) return res.status(404).json({ error: 'Newsletter not found' });
    } catch (e) {
      monitor.logError('newsletter-research', e, { detail: { stage: 'load_newsletter', newsletter_id: newsletterId } });
      return res.status(500).json({ error: 'Failed to load newsletter' });
    }

    // Load previous stories for dedup
    var previousHeadlines = [];
    var existingUrls = new Set();
    try {
      var recent = await sb.query('newsletter_stories?select=headline,source_url&order=created_at.desc&limit=500');
      previousHeadlines = (recent || []).map(function(s) { return s.headline; });
      (recent || []).forEach(function(s) {
        if (s.source_url) existingUrls.add(s.source_url.replace(/\/$/, '').toLowerCase());
      });
      console.log('Newsletter research: ' + existingUrls.size + ' existing URLs for dedup');
    } catch (e) { /* non-fatal */ }

    // ----- Build query plan -----
    var editionNumber = newsletter.edition_number;
    var rotatingQueries = pickRotating(ROTATING_POOL, editionNumber, ROTATING_WINDOW);
    var caQueries = pickRotating(CA_POOL, editionNumber, CA_WINDOW);

    var queryPlan = [];
    CORE_QUERIES.forEach(function(q) { queryPlan.push({ query: q, locale: 'us', core: true }); });
    rotatingQueries.forEach(function(q) { queryPlan.push({ query: q, locale: 'us', core: false }); });
    caQueries.forEach(function(q) { queryPlan.push({ query: q, locale: 'ca', core: false }); });

    console.log('Newsletter research: edition ' + editionNumber + ', ' + queryPlan.length + ' queries (' +
      CORE_QUERIES.length + ' core + ' + rotatingQueries.length + ' rotating + ' + caQueries.length + ' CA)');

    // ----- Phase 1: sequential SerpAPI calls -----
    var allResults = [];
    var queryStats = [];
    for (var qi = 0; qi < queryPlan.length; qi++) {
      var plan = queryPlan[qi];
      var results = [];
      try {
        results = await searchNews(plan.query, serpApiKey, plan.locale);
      } catch (e) {
        console.error('Search ' + (qi + 1) + ' failed:', e.message);
      }
      console.log('Search ' + (qi + 1) + '/' + queryPlan.length + ' [' + plan.locale + ']: "' + plan.query + '" -> ' + results.length + ' results');
      queryStats.push({
        query: plan.query,
        locale: plan.locale,
        core: plan.core,
        raw_count: results.length,
        selected_count: 0
      });
      for (var r = 0; r < results.length; r++) {
        results[r]._query_index = qi;
        allResults.push(results[r]);
      }
    }

    // ----- Dedup within this run (by URL) -----
    var seen = {};
    var uniqueResults = [];
    for (var u = 0; u < allResults.length; u++) {
      var key = allResults[u].link || allResults[u].title;
      if (!seen[key]) {
        seen[key] = true;
        uniqueResults.push(allResults[u]);
      }
    }
    var rawCount = allResults.length;
    var uniqueCount = uniqueResults.length;
    allResults = null;

    // ----- Pre-filter: remove URLs already used in previous editions -----
    var preFilterCount = uniqueResults.length;
    uniqueResults = uniqueResults.filter(function(item) {
      if (!item.link) return true;
      var normalized = item.link.replace(/\/$/, '').toLowerCase();
      return !existingUrls.has(normalized);
    });
    var preFilteredDups = preFilterCount - uniqueResults.length;
    if (preFilteredDups > 0) {
      console.log('Newsletter research: pre-filtered ' + preFilteredDups + ' candidate(s) already covered in previous editions');
    }

    if (uniqueResults.length === 0) {
      // Persist audit trail even on empty result so we can diagnose
      var emptyStats = {
        run_at: new Date().toISOString(),
        edition_number: editionNumber,
        queries: queryStats,
        totals: { raw: rawCount, unique: uniqueCount, pre_filtered_dups: preFilteredDups, sent_to_ai: 0, saved: 0, safety_dups_removed: 0 }
      };
      try {
        await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', { search_stats: emptyStats });
      } catch (e) { /* non-fatal */ }
      return res.status(500).json({ error: 'No fresh search results found (all candidates already covered in previous editions).', search_stats: emptyStats });
    }

    console.log('Newsletter research: ' + uniqueResults.length + ' fresh unique results, sending to Claude');

    // ----- Phase 2: Claude curates -----
    var today = new Date().toISOString().split('T')[0];

    var systemPrompt = 'You are a newsletter curator for Moonraker AI, serving therapy practice owners in the U.S. and Canada.\n\nFrom the search results, pick every story that is genuinely relevant. Aim for 8-12 but return fewer only if the pool is thin, and return more if more are strong. Do not force picks that do not fit, but do not leave strong stories on the table either. All candidates below are already fresh (not previously covered).\n\nWrite your own headlines in an engaging, practitioner-focused voice.\n\nCRITERIA (meet at least 2): recent, has deadlines/dates, actionable for therapists, affects visibility/revenue/compliance, shows AI opportunity.\n\nTOPICS: GBP updates, Google algorithm changes, Medicare/telehealth policy, AI tools for therapists, HIPAA enforcement, FTC advertising, review platforms, Canadian health privacy.\n\nAVOID: general AI news without therapist angle, medical/drug topics, speculation, duplicates.\n\nBALANCE: lean 70% compliance/risk, 30% AI opportunities, but do not drop a strong story just to hit the ratio.\n\nSORT: Return stories sorted by published_date DESCENDING (most recent first).\n\nToday: ' + today + '\n\nReturn ONLY a JSON array. No markdown, no backticks. Each object:\n{"headline":"...","summary":"2-3 sentences","source_url":"...","source_name":"...","published_date":"YYYY-MM-DD","relevance_note":"...","image_suggestion":"..."}';

    var searchText = uniqueResults.length + ' search results:\n\n';
    for (var s = 0; s < uniqueResults.length; s++) {
      var item = uniqueResults[s];
      searchText += (s + 1) + '. ' + item.title + ' (' + item.source + ', ' + item.date + ') ' + item.link + '\n';
      if (item.snippet) searchText += '   ' + item.snippet + '\n';
    }

    // URL -> query_index lookup for attribution after Claude picks
    var urlToQueryIndex = {};
    for (var q = 0; q < uniqueResults.length; q++) {
      if (uniqueResults[q].link) {
        urlToQueryIndex[uniqueResults[q].link.replace(/\/$/, '').toLowerCase()] = uniqueResults[q]._query_index;
      }
    }
    var candidatesSentCount = uniqueResults.length;
    uniqueResults = null;

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

    // Safety-net dedup (URLs pre-filtered, but Claude could hallucinate)
    var beforeCount = stories.length;
    stories = stories.filter(function(s) {
      if (!s.source_url) return true;
      var normalized = s.source_url.replace(/\/$/, '').toLowerCase();
      return !existingUrls.has(normalized);
    });
    var dupsRemoved = beforeCount - stories.length;
    if (dupsRemoved > 0) {
      console.log('Newsletter research: safety-net removed ' + dupsRemoved + ' duplicate URL(s) from Claude output');
    }

    console.log('Newsletter research: Claude returned ' + stories.length + ' stories, saving to DB');

    // Delete only unselected candidates (preserve locked/selected stories)
    try {
      await sb.mutate('newsletter_stories?newsletter_id=eq.' + newsletterId + '&selected=eq.false', 'DELETE');
    } catch (e) { /* may not exist */ }

    // Include already-selected story URLs so we do not duplicate our own picks
    var selectedStories = [];
    try {
      selectedStories = await sb.query('newsletter_stories?newsletter_id=eq.' + newsletterId + '&selected=eq.true&select=source_url,headline&order=sort_order');
    } catch (e) { /* non-fatal */ }
    (selectedStories || []).forEach(function(s) {
      if (s.source_url) existingUrls.add(s.source_url.replace(/\/$/, '').toLowerCase());
    });

    // Save stories + attribute each back to the query that surfaced it
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

        if (story.source_url) {
          var normalizedUrl = story.source_url.replace(/\/$/, '').toLowerCase();
          var qIdx = urlToQueryIndex[normalizedUrl];
          if (typeof qIdx === 'number' && queryStats[qIdx]) {
            queryStats[qIdx].selected_count++;
          }
        }
      } catch (e) {
        console.error('Failed to save story:', story.headline, e.message);
      }
    }

    // ----- Persist audit trail -----
    var searchStats = {
      run_at: new Date().toISOString(),
      edition_number: editionNumber,
      queries: queryStats,
      totals: {
        raw: rawCount,
        unique: uniqueCount,
        pre_filtered_dups: preFilteredDups,
        sent_to_ai: candidatesSentCount,
        saved: saved.length,
        safety_dups_removed: dupsRemoved
      }
    };

    await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', {
      status: 'researched',
      search_stats: searchStats,
      updated_at: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      search_results_found: uniqueCount,
      pre_filtered_duplicates: preFilteredDups,
      candidates_sent_to_ai: candidatesSentCount,
      stories_curated: stories.length + dupsRemoved,
      safety_duplicates_removed: dupsRemoved,
      stories_saved: saved.length,
      stories: saved,
      search_stats: searchStats
    });

  } catch (e) {
    monitor.logError('newsletter-research', e, { detail: { stage: 'research_handler' } });
    try {
      return res.status(500).json({ error: 'Research failed' });
    } catch (e2) { /* */ }
  }
};
