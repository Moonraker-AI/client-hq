// /api/newsletter-research.js
// Uses Claude with web_search tool to find 8-12 candidate stories
// for the weekly newsletter. Saves candidates to newsletter_stories table.
//
// POST { newsletter_id }
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

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

  // Load previous editions to avoid duplicate stories
  var previousStories = [];
  try {
    var recent = await sb.query('newsletter_stories?select=headline,source_url&order=created_at.desc&limit=80');
    previousStories = (recent || []).map(function(s) { return s.headline; });
  } catch (e) {
    // Non-fatal, continue without dedup
  }

  var today = new Date().toISOString().split('T')[0];

  var systemPrompt = 'You are a research assistant for Moonraker.AI\'s weekly newsletter for therapy practice owners (solo and group practices) in the U.S. and Canada. Your job is to find 8-12 recent, verifiable news stories from the past 7-10 days that impact therapists.\n\n' +
    'STORY SELECTION CRITERIA (must meet at least 2):\n' +
    '- Recent (within past 7-10 days)\n' +
    '- Has specific dates, deadlines, enforcement timelines\n' +
    '- Has clear, actionable next steps therapists can take\n' +
    '- Affects practice visibility, client acquisition, revenue, or compliance\n' +
    '- Has penalty, risk, or compliance implications\n' +
    '- Shows practical AI opportunity for therapists\n\n' +
    'PRIORITY TOPICS:\n' +
    '- Google Business Profile updates, suspensions, policy changes\n' +
    '- Google algorithm updates affecting local search\n' +
    '- Medicare/Medicaid telehealth coverage changes\n' +
    '- AI chatbot and LLM developments relevant to therapists (ChatGPT, Claude, Gemini, etc.)\n' +
    '- HIPAA enforcement actions, OCR settlements\n' +
    '- State AI and telehealth legislation\n' +
    '- Review platform policy changes\n' +
    '- FTC healthcare advertising enforcement\n' +
    '- AI tools solving real therapy practice problems\n\n' +
    'AVOID:\n' +
    '- General AI news without therapist application\n' +
    '- Stories older than 10 days\n' +
    '- General medical/prescription drug topics\n' +
    '- Speculative predictions without current actionable items\n' +
    '- Stories without verifiable sources\n\n' +
    'BALANCE: Roughly 70% urgent compliance/risk news, 30% positive AI opportunities.\n\n' +
    'Today\'s date: ' + today + '\n\n' +
    'IMPORTANT: Search multiple source categories. Do at least 6-8 searches covering: Google/SEO updates, HIPAA/healthcare compliance, AI/LLM developments for therapists, telehealth policy, FTC enforcement, and platform changes.\n\n' +
    'Respond with ONLY a JSON array of story objects. No markdown, no backticks, no preamble. Each object:\n' +
    '{\n' +
    '  "headline": "Clear, specific headline",\n' +
    '  "summary": "2-3 sentence summary of what happened and why therapists should care",\n' +
    '  "source_url": "URL of the primary source",\n' +
    '  "source_name": "Name of the source publication",\n' +
    '  "published_date": "YYYY-MM-DD",\n' +
    '  "relevance_note": "Brief note on why this matters for therapy practices specifically",\n' +
    '  "image_suggestion": "Description of a relevant stock image"\n' +
    '}';

  var userPrompt = 'Find 8-12 recent news stories (past 7-10 days) that impact therapy practice owners. Use web search to find real, verifiable stories from authoritative sources.\n\n' +
    'Search these source categories:\n' +
    '1. Google Search Central Blog + Search Engine Journal/Land for SEO updates\n' +
    '2. HIPAA Journal + HHS/OCR for compliance enforcement\n' +
    '3. OpenAI, Anthropic, Google AI blogs for LLM updates relevant to therapists\n' +
    '4. CMS.gov for telehealth/Medicare policy changes\n' +
    '5. FTC.gov for healthcare advertising enforcement\n' +
    '6. State legislature trackers for AI healthcare laws\n' +
    '7. Google Business Profile forums/updates\n' +
    '8. Behavioral Health Business for industry news\n\n';

  if (previousStories.length > 0) {
    userPrompt += 'AVOID these previously covered stories (do NOT repeat):\n' +
      previousStories.slice(0, 40).map(function(h) { return '- ' + h; }).join('\n') + '\n\n';
  }

  userPrompt += 'Return ONLY a JSON array of story objects. No markdown fences, no commentary.';

  try {
    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2025-04-14'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });

    if (!aiResp.ok) {
      var errBody = await aiResp.text();
      var errMsg = 'Anthropic API error ' + aiResp.status;
      try { var errJson = JSON.parse(errBody); errMsg += ': ' + (errJson.error && errJson.error.message || errBody.substring(0, 200)); } catch(e) { errMsg += ': ' + errBody.substring(0, 200); }
      return res.status(500).json({ error: errMsg });
    }

    var aiData = await aiResp.json();

    // Extract the text content (may have multiple blocks from tool use)
    var rawText = '';
    if (aiData.content) {
      for (var i = 0; i < aiData.content.length; i++) {
        if (aiData.content[i].type === 'text' && aiData.content[i].text) {
          rawText += aiData.content[i].text;
        }
      }
    }

    if (!rawText) {
      return res.status(500).json({ error: 'No text response from AI', raw: aiData });
    }

    // Clean and parse JSON
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // Find the JSON array in the response
    var jsonStart = rawText.indexOf('[');
    var jsonEnd = rawText.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(500).json({ error: 'Could not find JSON array in response', raw: rawText.substring(0, 500) });
    }

    var stories = JSON.parse(rawText.substring(jsonStart, jsonEnd + 1));

    if (!Array.isArray(stories) || stories.length === 0) {
      return res.status(500).json({ error: 'No stories returned', raw: rawText.substring(0, 500) });
    }

    // Delete any existing stories for this newsletter (re-research)
    try {
      await sb.mutate('newsletter_stories?newsletter_id=eq.' + newsletterId, 'DELETE');
    } catch (e) {
      // May not exist yet, that's fine
    }

    // Save stories to database
    var saved = [];
    for (var s = 0; s < stories.length; s++) {
      var story = stories[s];
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
          sort_order: s,
          ai_generated: true
        });
        if (row) saved.push(row);
      } catch (e) {
        // Skip individual failures
        console.error('Failed to save story:', story.headline, e.message);
      }
    }

    // Update newsletter status
    await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', {
      status: 'researching',
      updated_at: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      stories_found: stories.length,
      stories_saved: saved.length,
      stories: saved
    });

  } catch (e) {
    return res.status(500).json({ error: 'Research failed: ' + e.message });
  }
};
