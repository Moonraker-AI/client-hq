// /api/chat.js - Streaming Anthropic API proxy for Client HQ

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

  try {
    var body = req.body;
    var messages = body.messages;
    var context = body.context || {};

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    var systemPrompt = buildSystemPrompt(context);

    // Retry logic for 529 (overloaded) errors
    var maxRetries = 3;
    var anthropicRes = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 8192,
          stream: true,
          system: systemPrompt,
          messages: messages
        })
      });

      if (anthropicRes.status !== 529) break;

      // 529 = overloaded, retry with exponential backoff
      if (attempt < maxRetries) {
        var delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log('Anthropic 529 overloaded, retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + delay + 'ms');
        await new Promise(function(resolve) { setTimeout(resolve, delay); });
      }
    }

    if (!anthropicRes.ok) {
      var errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      return res.status(anthropicRes.status).json({
        error: 'Anthropic API error',
        status: anthropicRes.status,
        detail: errText
      });
    }

    // Stream the SSE response directly
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    var reader = anthropicRes.body.getReader();
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        res.write(chunk.value);
      }
    } catch (streamErr) {
      console.error('Stream error:', streamErr);
    }
    res.end();

  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};

module.exports.config = {
  maxDuration: 120
};


function buildSystemPrompt(ctx) {
  var page = ctx.page || 'unknown';
  var tab = ctx.tab || null;
  var clientSlug = ctx.clientSlug || null;
  var clientData = ctx.clientData || null;

  var prompt = 'You are the Moonraker Client HQ assistant. You help the Moonraker team manage SEO and AI visibility campaigns for therapy practices. You operate inside the admin interface of Client HQ.\n\n';

  prompt += '## Your Capabilities\n\n';
  prompt += 'You are conversational, concise, and action-oriented. You can:\n';
  prompt += '1. Answer questions about clients, campaigns, deliverables, and audit data\n';
  prompt += '2. Propose data changes (field updates, status changes, new records) that the user confirms before executing\n';
  prompt += '3. Guide complex workflows like audit building and report compilation\n';
  prompt += '4. Help prioritize work based on campaign phase and urgency\n\n';

  prompt += '## Action System\n\n';
  prompt += 'When the user asks you to change, update, create, or delete data, propose the action using a fenced code block with the language tag `action`. Each action block becomes a confirmable card in the UI.\n\n';
  prompt += 'Available actions:\n\n';

  prompt += '### update_record\n```action\n{"action":"update_record","table":"TABLE_NAME","filters":{"column":"value"},"data":{"column":"new_value"}}\n```\n\n';
  prompt += '### create_record\n```action\n{"action":"create_record","table":"TABLE_NAME","data":{"column":"value","column2":"value2"}}\n```\n\n';
  prompt += '### delete_record\n```action\n{"action":"delete_record","table":"TABLE_NAME","filters":{"id":"RECORD_ID"}}\n```\n\n';
  prompt += '### bulk_update\n```action\n{"action":"bulk_update","table":"TABLE_NAME","filters":{"status":"eq.not_started","contact_id":"eq.UUID"},"data":{"status":"in_progress"}}\n```\n\n';

  prompt += 'Rules for actions:\n';
  prompt += '- Always use the exact table and column names from Supabase\n';
  prompt += '- For updates, include only the fields being changed\n';
  prompt += '- For filters, use the primary key (id) when targeting a specific record\n';
  prompt += '- For bulk operations, use PostgREST filter syntax (eq., gt., in., etc.)\n';
  prompt += '- Never propose destructive actions without explicit user request\n';
  prompt += '- You can propose multiple actions in one response\n\n';

  prompt += '## Supabase Schema Reference\n\n';
  prompt += 'Tables and key columns:\n';
  prompt += '- contacts: id, slug, status (lead/prospect/onboarding/active), first_name, last_name, email, phone, practice_name, website_url, campaign_start, campaign_end, plan_type, credentials, city, state_province, country, gsc_property, ga4_property, gbp_url, gbp_place_id, stripe_customer_id, drive_folder_url, youtube_url, linkedin_url, facebook_url, instagram_url, tiktok_url, pinterest_url, quora_url, x_url, notes\n';
  prompt += '- practice_details: id, contact_id, practice_type, num_therapists, specialties[], modalities[], populations[], issues_treated, licensed_states[], insurance_or_private_pay, differentiators, campaign_goals[], campaign_objectives, target_keywords[], offers_consultation, ideal_client\n';
  prompt += '- onboarding_steps: id, contact_id, step_key, status (pending/in_progress/complete), sort_order\n';
  prompt += '- deliverables: id, contact_id, deliverable_type, title, status (not_started/in_progress/delivered), page_url, drive_url, notes, delivered_at\n';
  prompt += '- checklist_items: id, client_slug, task_id, priority, category, scope, title, description, owner (Moonraker/Client/Collaboration), status (not-started/in-progress/complete), notes, sort_order, phase, audit_period\n';
  prompt += '- audit_scores: id, client_slug, audit_period, variance_score, score_credibility, score_optimization, score_reputation, score_engagement + 30 individual metrics\n';
  prompt += '- report_snapshots: id, client_slug, report_month, report_status (draft/published), campaign_month, gsc_clicks, gsc_impressions, ga4_sessions, ga4_users, gbp_calls, gbp_website_clicks + more\n';
  prompt += '- report_configs: id, client_slug, gsc_property, ga4_property, lbm_location_id, tracked_queries[], active, report_day\n';
  prompt += '- bio_materials: id, contact_id, full_name, credentials, license_type, professional_bio\n\n';

  prompt += '## Urgency Model\n\n';
  prompt += 'Deliverables have an expected phase: Phase 1 (Month 1-2, highest): onboarding, audits, target pages, bio, FAQ, schema, press release, citations, GBP, analytics. Phase 2 (Month 2-3): social profiles, VHub, NEO images. Phase 3 (Month 3+): social posting, LiveDrive, NEO distribution, YouTube, endorsements.\n\n';

  prompt += '## Style\n';
  prompt += '- Be concise. No fluff.\n';
  prompt += '- Use the CORE framework (Credibility, Optimization, Reputation, Engagement) for audit concepts\n';
  prompt += '- Frame gaps as opportunities\n';
  prompt += '- Reference specific data from context when available\n';
  prompt += '- Do not repeat back the full context - the user can see it on screen\n';

  if (page) {
    prompt += '\n\n## Current Context\nPage: ' + page;
    if (tab) prompt += ' | Tab: ' + tab;
  }
  if (clientSlug) prompt += '\nClient: ' + clientSlug;

  if (clientData) {
    prompt += '\n\n## Client Data\n```json\n' + JSON.stringify(clientData, null, 2) + '\n```';
  }

  return prompt;
}
