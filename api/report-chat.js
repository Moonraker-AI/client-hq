// /api/report-chat.js
// Streaming chat endpoint for the report chatbot (client-facing).
// Uses Claude Sonnet 4.6 with full context of the report snapshot, metrics,
// and the CORE Marketing System services reference.
// Standard Node.js serverless function with SSE streaming.
//
// POST { messages: [...], context: { snapshot, highlights, practice_name, campaign_month } }
//
// ENV VARS: ANTHROPIC_API_KEY

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  var messages = req.body && req.body.messages;
  var context = (req.body && req.body.context) || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  var systemPrompt = buildSystemPrompt(context);

  var aiResp = null;
  var maxRetries = 2;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: systemPrompt,
          messages: messages,
          stream: true
        })
      });
    } catch(e) {
      if (attempt === maxRetries) return res.status(500).json({ error: 'Failed to reach Anthropic API' });
      await new Promise(function(r) { setTimeout(r, Math.pow(2, attempt) * 1000 + Math.random() * 500); });
      continue;
    }
    if (aiResp.status === 529) {
      if (attempt < maxRetries) {
        console.log('Anthropic 529 overloaded (attempt ' + (attempt + 1) + '/' + maxRetries + '), retrying...');
        await new Promise(function(r) { setTimeout(r, Math.pow(2, attempt) * 1000 + Math.random() * 500); });
        continue;
      }
    }
    break;
  }

  if (!aiResp || !aiResp.ok) {
    var errBody = aiResp ? await aiResp.text() : 'No response';
    return res.status(aiResp ? aiResp.status : 500).json({ error: 'Anthropic API error', status: aiResp ? aiResp.status : 500 });
  }

  // Stream: pipe raw Anthropic SSE bytes directly
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  var reader = aiResp.body.getReader();
  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      res.write(chunk.value);
    }
  } catch(e) {
    // Stream error, close gracefully
  }

  res.end();
};

function buildSystemPrompt(context) {
  var snapshot = context.snapshot || {};
  var highlights = context.highlights || [];
  var practiceName = context.practice_name || 'your practice';
  var campaignMonth = context.campaign_month || 1;

  // Format highlights into readable text
  var highlightText = '';
  if (highlights.length > 0) {
    highlightText = '\n\nTHIS MONTH\'S HIGHLIGHTS:\n';
    highlights.forEach(function(h, i) {
      highlightText += (i + 1) + '. ' + h.headline + ': ' + h.body + '\n';
    });
  }

  // Format GSC data
  var gscText = '';
  if (snapshot.gsc_clicks !== null && snapshot.gsc_clicks !== undefined) {
    gscText = '\n\nWEBSITE SEARCH PERFORMANCE (Google Search Console):\n'
      + '- Clicks: ' + snapshot.gsc_clicks + (snapshot.gsc_clicks_prev !== null ? ' (previous month: ' + snapshot.gsc_clicks_prev + ')' : '') + '\n'
      + '- Impressions: ' + snapshot.gsc_impressions + (snapshot.gsc_impressions_prev !== null ? ' (previous: ' + snapshot.gsc_impressions_prev + ')' : '') + '\n'
      + '- Click-through rate: ' + snapshot.gsc_ctr + '%\n'
      + '- Average position: ' + snapshot.gsc_avg_position + '\n';
    var gscDetail = snapshot.gsc_detail || {};
    if (gscDetail.queries && gscDetail.queries.length > 0) {
      gscText += 'Top search queries:\n';
      gscDetail.queries.forEach(function(q) {
        gscText += '  "' + q.query + '": ' + q.clicks + ' clicks, ' + q.impressions + ' impressions, pos ' + q.position + '\n';
      });
    }
    if (gscDetail.pages && gscDetail.pages.length > 0) {
      gscText += 'Top pages:\n';
      gscDetail.pages.forEach(function(p) {
        gscText += '  ' + p.page + ': ' + p.clicks + ' clicks, pos ' + p.position + '\n';
      });
    }
  }

  // Format GBP data
  var gbpText = '';
  var gbpDetail = snapshot.gbp_detail || {};
  if (gbpDetail.rating) {
    gbpText = '\n\nGOOGLE BUSINESS PROFILE:\n'
      + '- Rating: ' + gbpDetail.rating + ' stars (' + gbpDetail.reviews + ' reviews)\n';
  }
  if (snapshot.gbp_calls !== null && snapshot.gbp_calls !== undefined) {
    gbpText += '- Calls: ' + snapshot.gbp_calls + (snapshot.gbp_calls_prev !== null ? ' (previous: ' + snapshot.gbp_calls_prev + ')' : '') + '\n'
      + '- Website clicks: ' + snapshot.gbp_website_clicks + '\n'
      + '- Direction requests: ' + snapshot.gbp_direction_requests + '\n';
    if (gbpDetail.impressions_total) {
      gbpText += '- Total impressions: ' + gbpDetail.impressions_total + '\n';
    }
  }

  // Format AI visibility
  var aiText = '';
  var ai = snapshot.ai_visibility || {};
  if (ai.engines_checked) {
    aiText = '\n\nAI VISIBILITY (how AI platforms recommend this practice):\n'
      + ai.engines_citing + ' of ' + ai.engines_checked + ' AI platforms are citing this practice.\n';
    var engines = ai.engines || [];
    engines.forEach(function(e) {
      aiText += '- ' + e.name + ': ' + (e.cited ? 'VISIBLE' : 'Not visible');
      if (e.avg_solv) aiText += ' (avg SoLV: ' + e.avg_solv + '%)';
      if (e.context) aiText += ' - ' + e.context;
      aiText += '\n';
    });
    var kwBreakdown = ai.keyword_breakdown || [];
    if (kwBreakdown.length > 0) {
      aiText += '\nPer-keyword AI coverage:\n';
      kwBreakdown.forEach(function(kw) {
        var platforms = Object.keys(kw.platforms || {});
        var citedIn = platforms.filter(function(p) { return kw.platforms[p].cited; });
        aiText += '  "' + kw.label + '": visible in ' + citedIn.length + '/' + platforms.length + ' platforms';
        if (citedIn.length > 0) aiText += ' (' + citedIn.join(', ') + ')';
        aiText += '\n';
      });
    }
  }

  // Format Maps/Geogrid data
  var mapsText = '';
  var neo = snapshot.neo_data || {};
  if (neo.grids && neo.grids.length > 0) {
    mapsText = '\n\nMAPS VISIBILITY (geo-grid rank tracking):\n'
      + neo.grid_count + ' grids total | Average ARP: ' + neo.avg_arp + ' | Average SoLV: ' + neo.avg_solv + '%\n'
      + '(ARP = Average Rank Position, lower is better. 1 = top spot. SoLV = Share of Local Voice, higher is better. 100% means top 3 everywhere.)\n\n';
    neo.grids.forEach(function(g) {
      mapsText += '- "' + g.search_term + '": ARP ' + g.arp + ', SoLV ' + (Math.round((g.solv || 0) * 100) / 100) + '%, ' + g.grid_size + 'x' + g.grid_size + ' grid\n';
    });
  }

  // Format tasks
  var tasksText = '\n\nCAMPAIGN PROGRESS:\n'
    + '- Total tasks: ' + (snapshot.tasks_total || 0) + '\n'
    + '- Complete: ' + (snapshot.tasks_complete || 0) + '\n'
    + '- In progress: ' + (snapshot.tasks_in_progress || 0) + '\n'
    + '- Not started: ' + (snapshot.tasks_not_started || 0) + '\n';

  return `You are the Moonraker Report Assistant, a warm and knowledgeable AI that helps therapy practice clients understand their monthly campaign report.

IDENTITY & TONE:
- You represent Moonraker AI, a digital marketing agency specializing in visibility for therapy practices
- Be warm, encouraging, and clear. These are therapists, not marketers. Explain everything in plain language.
- Celebrate wins genuinely. When metrics are down, frame it constructively with what is being done to improve.
- Keep answers concise: 2-4 short paragraphs unless the question requires more detail.
- Do not use em dashes. Use commas, periods, or restructure.
- If asked something outside the report data, be honest that you can only speak to the data available in this report. Do your best to answer based on what you know about the CORE system and the metrics provided.

PRACTICE: ${practiceName}
CAMPAIGN MONTH: ${campaignMonth}
${highlightText}
${gscText}
${gbpText}
${aiText}
${mapsText}
${tasksText}

METRIC DEFINITIONS (use these to explain data in plain language):
- GSC Clicks: How many people clicked through to the practice website from Google search results
- GSC Impressions: How many times the website appeared in Google search results (even if not clicked)
- CTR: Click-through rate. What percentage of people who saw the website in search results actually clicked.
- Average Position: Where the website ranks in Google search. Lower is better (1 = top spot).
- ARP (Average Rank Position): Where the practice shows up on the map grid. Lower is better. 1 = top spot.
- ATRP (Average Total Rank Position): Like ARP but includes grid points where the practice does not show up at all (scored as 21). Gives the full picture.
- SoLV (Share of Local Voice): Percentage of grid points where the practice appears in the top 3 map results. Higher is better. 100% = top 3 everywhere in the scanned area.
- SAIV (Share of AI Voice): Similar concept but for AI platforms. How consistently AI recommends this practice.
- GBP: Google Business Profile. The listing that appears on Google Maps and in local search results.

THE CORE MARKETING SYSTEM (what Moonraker does):
Moonraker uses the CORE system, which has four pillars:

1. CREDIBILITY (C): Proving the practice exists and is qualified
   - Google Workspace and DNS setup (DKIM, DMARC, SPF)
   - 15+ directory citations via BrightLocal + 5 data aggregators
   - Social profile buildout across up to 9 platforms
   - Entity Veracity Hub (cryptographic grounding of practice identity)
   - Professional credentials and association listings

2. OPTIMIZATION (O): Teaching AI about the practice's services
   - 5 custom target service pages with structured content
   - Location pages, bio pages, FAQ pages
   - Technical SEO (heading hierarchy, schema markup, meta tags)
   - Platform-specific optimization (WordPress, Squarespace, Wix, etc.)

3. REPUTATION (R): Proving expertise and amplifying it
   - Professional endorsement strategy
   - Google Business Profile + social media content (2 posts/month on 4 platforms)
   - YouTube endorsement slideshows
   - Quora Space amplification
   - Press release syndication (500+ sites via LinkDaddy)

4. ENGAGEMENT (E): Guiding visitors toward booking a consultation
   - Hero section redesign (Why + What + CTA + Trust)
   - Booking calendar optimization
   - Engage AI Chatbot (HIPAA-compliant, in beta)

RESPONSE GUIDELINES:
- For metric questions, explain in plain language with the specific numbers from the report
- For "why" questions (why am I not showing up on ChatGPT, etc.), explain what factors affect visibility and what Moonraker is doing about it
- For progress questions, reference the task completion data and explain the current phase
- For scope questions, reference the CORE system to explain what is included
- Always be honest about metrics. If something is not performing well, acknowledge it and explain the plan
- Never direct the client to reach out to the Moonraker team, email anyone, or book a call. Your job is to answer their questions fully using the report data and CORE system knowledge provided here.
- If you truly cannot answer from the data available, say so clearly, but do not suggest contacting anyone.`;
}
