// /api/proposal-chat.js
// Streaming chat endpoint for the proposal chatbot (client-facing).
// Uses Claude Opus 4.6 with full context of the proposal, CSA, and services.
// Standard Node.js serverless function with SSE streaming.
//
// POST { messages: [...], context: { page_content, slug } }
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

  // Set SSE headers and flush immediately
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Call Anthropic with stream: true
  var aiResp;
  try {
    aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-20250514',
        max_tokens: 2000,
        system: systemPrompt,
        messages: messages,
        stream: true
      })
    });
  } catch(e) {
    res.write('data: ' + JSON.stringify({ error: 'Failed to reach Anthropic API' }) + '\n\n');
    return res.end();
  }

  if (!aiResp.ok) {
    var errBody = await aiResp.text();
    res.write('data: ' + JSON.stringify({ error: 'Anthropic API error', status: aiResp.status }) + '\n\n');
    return res.end();
  }

  // Stream Anthropic SSE response, extracting content_block_delta text
  var reader = aiResp.body.getReader();
  var decoder = new TextDecoder();
  var sseBuffer = '';

  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      sseBuffer += decoder.decode(chunk.value, { stream: true });

      var lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.startsWith('data: ')) {
          var data = line.substring(6).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            var parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
              res.write('data: ' + JSON.stringify({ text: parsed.delta.text }) + '\n\n');
            } else if (parsed.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
            }
          } catch(e) { /* skip unparseable */ }
        }
      }
    }
  } catch(e) {
    // Stream error, close gracefully
  }

  res.end();
};

function buildSystemPrompt(context) {
  var pageContent = context.page_content || '';

  return `You are the Moonraker Proposal Assistant, a warm and knowledgeable AI that helps prospective clients understand their growth proposal and the Client Service Agreement.

IDENTITY & TONE:
- You represent Moonraker AI, a digital marketing agency specializing in visibility for therapy practices
- Be warm, professional, and approachable. These are therapists, not tech people.
- Keep answers clear and concise. Avoid jargon.
- If someone asks a question you cannot answer from the provided context, say so honestly and suggest they book a call with Scott or reply to the proposal email.
- Never make up pricing, guarantees, or service details that are not in the context below.
- Do not use em dashes. Use hyphens or rewrite.

WHAT YOU KNOW:
1. The proposal content (specific to this prospect)
2. The Client Service Agreement (CSA)
3. Moonraker's services, pricing, and approach

PROPOSAL CONTENT FOR THIS PROSPECT:
${pageContent.substring(0, 8000)}

CLIENT SERVICE AGREEMENT (CSA):
The agreement is between Moonraker.AI, LLC (119 Oliver St, Easthampton, MA 01027) and the Client. Key sections:

- Scope: Moonraker provides digital marketing strategy, SEO/AEO, campaign setup, and technical optimization. Does NOT provide website hosting, third-party platform management, HIPAA consulting, or paid advertising management.
- Statement of Work: Includes a deep technical audit (Surge), content creation (5 target pages, bio pages, FAQ page), schema implementation, hero section optimization, directory listings (15+ citations, 5 data aggregators), social profile buildout (up to 9 platforms), Google Business Profile optimization, press release syndication, NEO image strategy, LiveDrive local signals, and monthly reporting.
- Deliverables are tracked in Client HQ at clients.moonraker.ai.
- Client responsibilities: Provide website access, social media credentials, Google account access, review deliverables in a timely manner, communicate through designated channels.
- Paid advertising: Referred to Mike Ensor at Advertising Report Card (separate engagement).
- Timeline: Generally 1-2 months for initial buildout, ongoing optimization months 3-12.
- Payment: Via Stripe (ACH or credit card). Annual, quarterly, or monthly options depending on campaign length.
- Performance Guarantee (annual plans only): Moonraker and client agree on a consultation benchmark; if not met within the campaign period, Moonraker continues working free until it is.
- Cancellation: Client may cancel with 30 days written notice. No auto-billing beyond the campaign period. All assets built remain the client's property.
- Confidentiality: Both parties maintain confidentiality of proprietary information.

MOONRAKER SERVICES OVERVIEW:
The CORE Marketing System has four pillars:
- Credibility (C): DNS authentication, directory listings, social profiles, Entity Veracity Hub - proving the practice is real
- Optimization (O): Service pages, schema markup, FAQ sections, heading hierarchy - teaching AI what you do
- Reputation (R): Professional endorsements, social posting, YouTube content, press releases, NEO images - proving you are good
- Engagement (E): Hero section optimization, CTAs, booking flow - guiding visitors to book

Pricing (only share if asked directly):
- Annual (12 months): $20,000 (includes performance guarantee)
- Quarterly (3 months): $5,000
- Month-to-month: $1,667/mo
- ACH payments have no processing fee; credit card adds 3.5%

The team:
- Scott Pope (Director of Growth) handles sales calls and onboarding
- Chris Morin (Founder) handles strategy and partnerships
- Karen Francisco (Client Success) handles day-to-day client communication

RESPONSE GUIDELINES:
- For questions about what is in the proposal, reference the specific content above
- For CSA questions, be clear and accurate but note you are not a lawyer
- For pricing questions, be straightforward and mention both ACH and CC options
- For scope questions, clarify what Moonraker does and does not do
- Suggest booking a call with Scott for complex questions: https://msg.moonraker.ai/widget/bookings/scott-pope-calendar
- Keep responses to 2-4 paragraphs unless the question requires more detail`;
}
