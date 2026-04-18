// /api/campaign-summary-chat.js
// Streaming chat endpoint for the campaign-summary chatbot (client-facing).
// Uses Claude Sonnet 4.6 with full context of the engagement: window, cost,
// bookings, GSC, attribution YoY, performance guarantee, striking-distance
// queries, deliverables by category, and next-period plan.
// Raw byte pipe streaming (proven pattern from report-chat / agreement-chat).
//
// POST { messages: [...], context: { slug, data } }
//
// Auth posture matches /api/campaign-summary (GET): origin validation +
// per-IP rate limit. No page-token because the underlying data endpoint is
// public-read (link-gated).
//
// ENV VARS: ANTHROPIC_API_KEY

var rateLimit = require('./_lib/rate-limit');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://clients.moonraker.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Origin validation: block cross-origin abuse (protects Anthropic API credits)
  var origin = req.headers.origin || '';
  if (origin && origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Rate limit: 20 req/min per IP (protects Anthropic API credits)
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':campaign-summary-chat', 20, 60);
  rateLimit.setHeaders(res, rl, 20);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again.' });
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

  // Call Anthropic with retry on 529 overloaded
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

// ─ System prompt builder ───────────────────────────────────────────

function buildSystemPrompt(context) {
  var data = context.data || {};
  var client = data.client || {};
  var win = data.window || {};

  var practiceName = client.practice || 'your practice';
  var name = client.name || '';
  var location = client.location || '';

  // Engagement window
  var windowText = '';
  if (win.start && win.end) {
    windowText = '\n\nENGAGEMENT WINDOW:\n'
      + '- Contract start: ' + win.start + '\n'
      + '- Contract end: ' + win.end + '\n'
      + '- Duration: ' + (win.months || '?') + ' months\n';
  }

  // Investment
  var costText = '';
  var cost = data.cost || {};
  if (cost.available) {
    costText = '\n\nINVESTMENT:\n'
      + '- Monthly retainer: $' + Math.round(cost.monthly_dollars).toLocaleString() + '\n'
      + '- Months billed to date: ' + cost.billed_months + '\n'
      + '- Total invested to date: $' + Math.round(cost.total_dollars).toLocaleString() + '\n';
  }

  // Performance guarantee
  var guaranteeText = '';
  var g = data.guarantee || {};
  if (g.available) {
    guaranteeText = '\n\nPERFORMANCE GUARANTEE:\n'
      + '- Threshold: $' + Math.round(g.threshold_dollars || 0).toLocaleString() + ' in attributed revenue\n';
    if (typeof g.google_only_dollars === 'number') {
      guaranteeText += '- Google-attributed revenue: $' + Math.round(g.google_only_dollars).toLocaleString()
        + ' (' + (g.met_by_google ? 'MEETS' : 'below') + ' threshold';
      if (typeof g.multiple_google === 'number') guaranteeText += ', ' + g.multiple_google.toFixed(2) + 'x threshold';
      guaranteeText += ')\n';
    }
    if (typeof g.total_online_dollars === 'number') {
      guaranteeText += '- Total online-attributed revenue: $' + Math.round(g.total_online_dollars).toLocaleString()
        + ' (' + (g.met_by_total ? 'MEETS' : 'below') + ' threshold';
      if (typeof g.multiple_total === 'number') guaranteeText += ', ' + g.multiple_total.toFixed(2) + 'x threshold';
      guaranteeText += ')\n';
    }
    if (g.reason && typeof g.google_only_dollars !== 'number') {
      guaranteeText += '- Status: ' + g.reason + '\n';
    }
  }

  // Attribution YoY
  var attributionText = '';
  var attr = data.attribution || {};
  if (attr.available && attr.yoy) {
    var yoy = attr.yoy;
    attributionText = '\n\nATTRIBUTION (client-reported, typically undercounts because it depends on patient self-report):\n'
      + '- Baseline period: ' + yoy.baseline_label + '\n'
      + '- Current period: ' + yoy.current_label + '\n';
    if (yoy.google) {
      attributionText += '- Google appointments: ' + yoy.google.appointments_baseline
        + ' baseline to ' + yoy.google.appointments_current + ' current\n'
        + '- Google revenue: $' + Math.round(yoy.google.revenue_dollars_baseline).toLocaleString()
        + ' to $' + Math.round(yoy.google.revenue_dollars_current).toLocaleString();
      if (yoy.google.revenue_growth_pct !== null && yoy.google.revenue_growth_pct !== undefined) {
        attributionText += ' (' + (yoy.google.revenue_growth_pct >= 0 ? '+' : '') + Math.round(yoy.google.revenue_growth_pct * 100) + '%)';
      }
      attributionText += '\n';
    }
    if (yoy.total_online) {
      attributionText += '- Total online revenue: $' + Math.round(yoy.total_online.revenue_dollars_baseline).toLocaleString()
        + ' to $' + Math.round(yoy.total_online.revenue_dollars_current).toLocaleString();
      if (yoy.total_online.revenue_growth_pct !== null && yoy.total_online.revenue_growth_pct !== undefined) {
        attributionText += ' (' + (yoy.total_online.revenue_growth_pct >= 0 ? '+' : '') + Math.round(yoy.total_online.revenue_growth_pct * 100) + '%)';
      }
      attributionText += '\n';
    }
    var current = attr.periods && attr.periods.slice().reverse().find(function(p) { return !p.is_baseline; });
    if (current && current.sources && current.sources.length > 0) {
      attributionText += 'Source breakdown (current period):\n';
      current.sources.forEach(function(s) {
        attributionText += '  - ' + s.source_name + ' (' + (s.source_category || 'other') + '): '
          + s.appointment_count + ' appts, $' + Math.round(s.revenue_dollars).toLocaleString() + '\n';
      });
    }
  }

  // Measured performance (bookings + GSC + conversion + CPC)
  var performanceText = '';
  var bookings = data.bookings || {};
  var gsc = data.gsc || {};
  var conversion = data.conversion || {};
  var cpc = data.cost_per_consultation || {};

  if (bookings.available || gsc.available) {
    performanceText = '\n\nMEASURED PERFORMANCE:\n';
    if (bookings.available) {
      performanceText += '- Consultations booked: ' + (bookings.total_booked || 0) + '\n'
        + '- Cancellations: ' + (bookings.total_canceled || 0) + '\n'
        + '- Net consultations: ' + (bookings.net || 0) + '\n';
    }
    if (gsc.available) {
      performanceText += '- Website clicks from Google: ' + (gsc.totals.clicks || 0) + '\n'
        + '- Impressions: ' + (gsc.totals.impressions || 0) + '\n';
      if (gsc.position_first !== null && gsc.position_last !== null) {
        performanceText += '- Avg Google position: ' + (gsc.position_first ? gsc.position_first.toFixed(1) : '?')
          + ' at start, ' + (gsc.position_last ? gsc.position_last.toFixed(1) : '?') + ' now\n';
      }
    }
    if (conversion.available) {
      performanceText += '- Click-to-booking rate: ' + conversion.rate_pct.toFixed(1)
        + '% (1 booking per ' + conversion.clicks_per_booking + ' clicks)\n';
    }
    if (cpc.available) {
      performanceText += '- Cost per net consultation: $' + Math.round(cpc.dollars).toLocaleString() + '\n';
    }
    if (gsc.available && gsc.top_queries && gsc.top_queries.length > 0) {
      performanceText += 'Top search queries (recent window):\n';
      gsc.top_queries.slice(0, 8).forEach(function(q) {
        performanceText += '  - "' + q.query + '": ' + q.clicks + ' clicks, pos ' + (q.position ? q.position.toFixed(1) : '?') + '\n';
      });
    }
  }

  // GBP Performance (engagement actions from the business profile itself)
  var gbpText = '';
  var gbpP = data.gbp || {};
  if (gbpP.available) {
    gbpText = '\n\nGOOGLE BUSINESS PROFILE ENGAGEMENT (over the engagement window):\n'
      + '- Total impressions: ' + (gbpP.impressions_total || 0).toLocaleString()
        + ' (appeared in Google Maps + local search)\n'
      + '- Website clicks from the listing: ' + (gbpP.website_clicks || 0).toLocaleString() + '\n'
      + '- Phone calls tapped: ' + (gbpP.calls || 0).toLocaleString() + '\n'
      + '- Direction requests tapped: ' + (gbpP.direction_requests || 0).toLocaleString() + '\n';
    var br = gbpP.impressions_breakdown || {};
    var mobileTotal  = (br.mobile_maps  || 0) + (br.mobile_search  || 0);
    var desktopTotal = (br.desktop_maps || 0) + (br.desktop_search || 0);
    var mapsTotal    = (br.desktop_maps || 0) + (br.mobile_maps    || 0);
    var searchTotal  = (br.desktop_search || 0) + (br.mobile_search || 0);
    if (mobileTotal || desktopTotal) {
      gbpText += '- Device split: ' + mobileTotal.toLocaleString() + ' mobile, '
        + desktopTotal.toLocaleString() + ' desktop\n';
    }
    if (mapsTotal || searchTotal) {
      gbpText += '- Surface split: ' + mapsTotal.toLocaleString() + ' on Google Maps, '
        + searchTotal.toLocaleString() + ' on Google Search\n';
    }
  }

  // Striking distance
  var strikingText = '';
  if (gsc.available && gsc.striking_distance && gsc.striking_distance.length > 0) {
    strikingText = '\n\nSTRIKING-DISTANCE QUERIES (ranking 11-20, near page 1):\n';
    var totalLift = 0;
    gsc.striking_distance.forEach(function(q) {
      strikingText += '  - "' + q.query + '": position ' + q.position.toFixed(1)
        + ', ' + q.impressions + ' impressions, ' + q.clicks + ' clicks'
        + (q.estimated_lift_clicks ? ', est lift into top 10: +' + q.estimated_lift_clicks + ' clicks/mo' : '') + '\n';
      totalLift += q.estimated_lift_clicks || 0;
    });
    if (totalLift > 0) {
      strikingText += 'Combined estimated lift if all moved to top 10: +' + totalLift + ' clicks per month.\n';
    }
  }

  // Shipped work
  var deliverablesText = '';
  var d = data.deliverables || {};
  if (d.available && d.by_category && d.by_category.length > 0) {
    deliverablesText = '\n\nSHIPPED WORK (' + d.total + ' deliverables total across engagement):\n';
    d.by_category.forEach(function(cat) {
      deliverablesText += '- ' + cat.category + ': ' + cat.count + ' items\n';
      var sample = cat.items.slice(0, 3);
      sample.forEach(function(it) {
        deliverablesText += '    * ' + (it.title || it.type) + (it.status ? ' (' + it.status + ')' : '') + '\n';
      });
      if (cat.items.length > 3) {
        deliverablesText += '    * plus ' + (cat.items.length - 3) + ' more\n';
      }
    });
  }

  // Next period
  var nextText = '';
  var np = data.next_period || {};
  if (np.heading && np.body) {
    nextText = '\n\nNEXT PERIOD PLAN:\n'
      + 'Heading: ' + np.heading + '\n'
      + 'Body: ' + np.body + '\n';
  }

  return `You are the Moonraker Campaign Summary Assistant, a warm and knowledgeable AI that helps therapy practice clients understand their full-engagement campaign summary.

IDENTITY & TONE:
- You represent Moonraker AI, a digital marketing agency specializing in visibility for therapy practices
- Be warm, direct, and encouraging. The audience is therapists, not marketers. Explain in plain language.
- Celebrate wins genuinely. When results are below expectations, be honest and frame what is being done about it.
- Keep answers concise: 2 to 4 short paragraphs unless the question asks for depth.
- Do not use em dashes. Use commas, periods, or restructure the sentence.
- Never direct the client to email, call, or book time with the Moonraker team. Answer fully here.
- If asked something not covered by this summary, answer from the CORE system knowledge below if relevant, otherwise say clearly that you can speak to what is in this summary.

PRACTICE: ${practiceName}
CLIENT: ${name}
LOCATION: ${location}
${windowText}${costText}${guaranteeText}${attributionText}${performanceText}${gbpText}${strikingText}${deliverablesText}${nextText}

METRIC DEFINITIONS (use these to explain the data in plain language):
- Attributed revenue: dollars the practice's own admin team tagged to a specific source (Google, ChatGPT, referral, etc.) based on patient self-report at intake. Typically undercounts.
- Performance guarantee: the revenue threshold Moonraker commits to, typically 2x the contract investment.
- Net consultations: initial consultations booked, minus cancellations.
- Click-to-booking rate: percentage of Google-search visitors who went on to book.
- Cost per consultation: total campaign investment divided by net consultations. Campaign-level ROI view.
- Striking distance: search queries where the practice ranks on page 2 of Google (positions 11-20). These are the closest wins because they are already ranking, they just need a nudge into the top 10.
- Average position: where the website ranks on Google. Lower is better (1 = top of page 1).
- Impressions: how often the website appeared in search results, even if not clicked.
- Google Business Profile engagement: direct actions taken from the practice's Google Maps / local search listing, including calls tapped, direction requests, and website clicks. Distinct from Google Search clicks: GBP engagement is people who found the listing in maps or the local pack, not by clicking a web search result.

THE CORE MARKETING SYSTEM (what Moonraker delivered):
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
   - Google Business Profile and social media content
   - YouTube endorsement slideshows
   - Quora Space amplification
   - Press release syndication (500+ sites via LinkDaddy)

4. ENGAGEMENT (E): Guiding visitors toward booking a consultation
   - Hero section redesign (Why + What + CTA + Trust)
   - Booking calendar optimization

RESPONSE GUIDELINES:
- For performance-guarantee questions, be precise about which revenue figure meets the threshold and which does not. Attribution is typically an undercount because it depends on patient self-report.
- For year-over-year questions, lead with the headline (total revenue growth, appointment growth), then break down by source.
- For "what did you deliver" questions, organize by CORE pillar and give concrete counts from the shipped-work section.
- For "what is next" questions, lead with the next-period plan if present, then point at striking-distance queries as specific near-term wins.
- Be honest about attribution limits. Revenue figures come from the practice's own admin tracking and typically miss cases where patients do not self-report the channel.
- Never direct to email, call, or book time with Moonraker.`;
}
