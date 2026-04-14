// /api/newsletter-generate.js
// Takes selected stories from newsletter_stories and generates the full
// newsletter content (stories with body/actions, quick wins, final thoughts).
// Saves structured content to newsletters.content and generates html_content.
//
// POST { newsletter_id }
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var PEXELS_KEY = process.env.PEXELS_API_KEY || '';

async function searchPexelsImage(query) {
  if (!PEXELS_KEY || !query) return null;
  try {
    var searchTerms = query.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    if (!searchTerms) return null;
    var resp = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(searchTerms) + '&per_page=1&orientation=landscape', {
      headers: { 'Authorization': PEXELS_KEY }
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    if (data.photos && data.photos.length > 0) {
      var photo = data.photos[0];
      // Build a 600x300 cropped URL for consistent email sizing
      var baseUrl = photo.src.original.split('?')[0];
      return {
        url: baseUrl + '?auto=compress&cs=tinysrgb&w=600&h=300&fit=crop',
        alt: photo.alt || searchTerms,
        photographer: photo.photographer || ''
      };
    }
  } catch (e) {
    console.error('Pexels search failed for "' + query + '":', e.message);
  }
  return null;
}

module.exports = async function handler(req, res) {
  try {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  var newsletterId = (req.body || {}).newsletter_id;
  if (!newsletterId) return res.status(400).json({ error: 'newsletter_id required' });

  // Load newsletter
  var newsletter;
  try {
    newsletter = await sb.one('newsletters?id=eq.' + newsletterId + '&select=*&limit=1');
    if (!newsletter) return res.status(404).json({ error: 'Newsletter not found' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load newsletter: ' + e.message });
  }

  // Load selected stories (sorted by sort_order)
  var stories;
  try {
    stories = await sb.query('newsletter_stories?newsletter_id=eq.' + newsletterId + '&selected=eq.true&order=sort_order&limit=5');
    if (!stories || stories.length === 0) {
      return res.status(400).json({ error: 'No stories selected. Select exactly 5 stories before generating.' });
    }
    if (stories.length !== 5) {
      return res.status(400).json({ error: 'Exactly 5 stories required, ' + stories.length + ' selected.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load stories: ' + e.message });
  }

  var today = new Date().toISOString().split('T')[0];

  var systemPrompt = 'You are the newsletter writer for Moonraker.AI, a digital marketing agency serving therapy practice owners. You write the weekly newsletter following strict editorial rules.\n\n' +
    'CRITICAL RULES:\n' +
    '- Use "client" not "patient" (except official regulatory language)\n' +
    '- NEVER use em dashes (the long dash character). Use commas, periods, colons, or restructure sentences instead. This is a strict formatting requirement.\n' +
    '- No paid advertising recommendations (no Google Ads, Facebook Ads)\n' +
    '- No industry jargon. Plain language throughout.\n' +
    '- All claims must be factual and verifiable\n' +
    '- Active voice preferred\n' +
    '- Specific data: exact dates, penalties, timelines (not "soon" or "many")\n' +
    '- Professional but accessible tone. Urgent but not alarmist.\n' +
    '- Empathetic toward therapists who are overwhelmed by digital complexity\n\n' +
    'STORY LENGTH (strict):\n' +
    '- Each story body: 100-150 words maximum (about 1 minute to read). Be concise and direct.\n' +
    '- Action items: exactly 3 per story, one sentence each\n' +
    '- Quick wins: one sentence each, 4 total\n' +
    '- Final thoughts: 2 short paragraphs\n\n' +
    'EMOJI RULES (strict):\n' +
    '- Use the pointing right emoji ONLY for Action sections (one per story)\n' +
    '- No other emojis in story content\n\n' +
    'Today\'s date: ' + today + '\n\n' +
    'RESPONSE FORMAT: Return ONLY a JSON object with no markdown fences:\n' +
    '{\n' +
    '  "stories": [\n' +
    '    {\n' +
    '      "headline": "Clear headline",\n' +
    '      "body": "1-2 short paragraphs of HTML (<p> tags). 100-150 words max.",\n' +
    '      "actions": "3 specific action items, one per line, plain text",\n' +
    '      "image_suggestion": "Description of relevant stock image"\n' +
    '    }\n' +
    '  ],\n' +
    '  "quick_wins": ["Win 1 (one sentence)", "Win 2", "Win 3", "Win 4"],\n' +
    '  "final_thoughts": "2 short paragraphs in HTML (<p> tags). Connect themes, emphasize complexity, position Moonraker. MUST include this exact closing line: While you\\\'re providing therapy, we\\\'re monitoring policy changes, protecting your Google presence, and optimizing for AI search. You shouldn\\\'t need to become an SEO expert, compliance specialist, and tech strategist on top of being a therapist.",\n' +
    '  "subject_lines": ["Option 1", "Option 2", "Option 3"],\n' +
    '  "preview_texts": ["Preview 1", "Preview 2", "Preview 3"]\n' +
    '}';

  var storySummaries = stories.map(function(s, i) {
    return (i + 1) + '. ' + s.headline + '\n   Source: ' + (s.source_name || 'Unknown') + (s.source_url ? ' (' + s.source_url + ')' : '') +
      '\n   Published: ' + (s.published_date || 'Recent') +
      '\n   Summary: ' + (s.summary || '') +
      '\n   Relevance: ' + (s.relevance_note || '');
  }).join('\n\n');

  var userPrompt = 'Write the complete content for Newsletter Edition #' + newsletter.edition_number + '.\n\n' +
    'Here are the 5 selected stories in order:\n\n' + storySummaries + '\n\n' +
    'For each story, write:\n' +
    '- A clear, specific headline (no em dashes)\n' +
    '- 1-2 body paragraphs, 100-150 words MAX (use <p> tags). Include specific dates and numbers.\n' +
    '- Exactly 3 action items (one per line, plain text, one sentence each)\n' +
    '- A suggested image description\n\n' +
    'Also write:\n' +
    '- 4 Quick Wins (one sentence each)\n' +
    '- Final Thoughts (2 short paragraphs, include the required closing line verbatim)\n' +
    '- 3 subject line options (specific, urgent, no em dashes)\n' +
    '- 3 preview text options\n\n' +
    'IMPORTANT: Do not use em dashes (the long dash) anywhere. Use commas, colons, or periods instead.\n\n' +
    'Return ONLY the JSON object. No markdown fences.';

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
        max_tokens: 10000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })
    });

    if (!aiResp.ok) {
      var errBody = await aiResp.text();
      return res.status(500).json({ error: 'Anthropic API error: ' + aiResp.status, detail: errBody.substring(0, 500) });
    }

    var aiData = await aiResp.json();

    // Extract text from response blocks
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

    // Clean and parse
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var jsonStart = rawText.indexOf('{');
    var jsonEnd = rawText.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(500).json({ error: 'Could not find JSON in response', raw: rawText.substring(0, 500) });
    }

    var content = JSON.parse(rawText.substring(jsonStart, jsonEnd + 1));

    // Post-process: strip any em dashes that slipped through
    function stripEmDashes(s) {
      if (typeof s !== 'string') return s;
      return s.replace(/\u2014/g, ', ').replace(/\u2013/g, ', ').replace(/ —/g, ',').replace(/— /g, ', ').replace(/—/g, ', ');
    }
    if (content.stories) {
      content.stories.forEach(function(s) {
        s.headline = stripEmDashes(s.headline);
        s.body = stripEmDashes(s.body);
        s.actions = stripEmDashes(s.actions);
      });
    }
    if (content.final_thoughts) content.final_thoughts = stripEmDashes(content.final_thoughts);
    if (content.quick_wins) content.quick_wins = content.quick_wins.map(stripEmDashes);
    if (content.subject_lines) content.subject_lines = content.subject_lines.map(stripEmDashes);
    if (content.preview_texts) content.preview_texts = content.preview_texts.map(stripEmDashes);

    // Validate required fields
    if (!content.stories || !Array.isArray(content.stories) || content.stories.length !== 5) {
      return res.status(500).json({ error: 'Expected 5 stories in response', got: content.stories ? content.stories.length : 0 });
    }

    // Search Pexels for story images, fall back to existing URLs from newsletter_stories
    for (var p = 0; p < content.stories.length; p++) {
      var existingImg = stories[p] ? (stories[p].image_url || '') : '';
      var existingAlt = stories[p] ? (stories[p].image_alt || '') : '';

      if (PEXELS_KEY) {
        var suggestion = content.stories[p].image_suggestion || content.stories[p].headline || '';
        var img = await searchPexelsImage(suggestion);
        if (img) {
          content.stories[p].image_url = img.url;
          content.stories[p].image_alt = img.alt;
        } else if (existingImg) {
          // Pexels failed but we have an existing image from a previous run
          content.stories[p].image_url = existingImg;
          content.stories[p].image_alt = existingAlt;
        }
      } else if (existingImg) {
        // No Pexels key, use existing
        content.stories[p].image_url = existingImg;
        content.stories[p].image_alt = existingAlt;
      }
    }

    // Update each newsletter_story with generated body/actions AND image
    for (var s = 0; s < content.stories.length; s++) {
      var generated = content.stories[s];
      var original = stories[s];
      try {
        var patch = {
          headline: generated.headline || original.headline,
          body: generated.body || '',
          action_items: generated.actions || '',
          image_suggestion: generated.image_suggestion || original.image_suggestion || '',
          updated_at: new Date().toISOString()
        };
        if (generated.image_url) {
          patch.image_url = generated.image_url;
          patch.image_alt = generated.image_alt || '';
        }
        await sb.mutate('newsletter_stories?id=eq.' + original.id, 'PATCH', patch);
      } catch (e) {
        console.error('Failed to update story:', original.id, e.message);
      }
    }

    // Build the structured content object
    var structuredContent = {
      stories: content.stories,
      quick_wins: content.quick_wins || [],
      final_thoughts: content.final_thoughts || '',
      subject_lines: content.subject_lines || [],
      preview_texts: content.preview_texts || []
    };

    // Update newsletter with content
    await sb.mutate('newsletters?id=eq.' + newsletterId, 'PATCH', {
      content: structuredContent,
      status: 'draft',
      subject: (content.subject_lines && content.subject_lines[0]) || newsletter.subject || '',
      preview_text: (content.preview_texts && content.preview_texts[0]) || newsletter.preview_text || '',
      updated_at: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      content: structuredContent
    });

  } catch (e) {
    return res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
  } catch (fatal) {
    console.error('Newsletter generate FATAL:', fatal.message, fatal.stack);
    try { return res.status(500).json({ error: 'Fatal: ' + fatal.message }); } catch(e2) {}
  }
};


