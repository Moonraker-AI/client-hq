/**
 * /api/process-batch-synthesis.js
 *
 * Processes the batch synthesis from a content audit and generates
 * checklist items for cross-page strategic actions.
 *
 * POST body: { batch_id }
 *
 * Flow:
 * 1. Fetch batch record with synthesis_raw
 * 2. Send to Claude to extract structured actions
 * 3. Create checklist_items with source='content_batch'
 * 4. Store processed synthesis on batch record
 *
 * Can be called:
 * - Automatically when batch reaches 'complete' status (from cron)
 * - Manually from admin UI
 */

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  if (!body.batch_id) return res.status(400).json({ error: 'batch_id required' });

  var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    // 1. Fetch batch
    var batch = await sb.one('content_audit_batches?id=eq.' + body.batch_id + '&limit=1');
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (!batch.synthesis_raw) return res.status(400).json({ error: 'No synthesis data to process' });

    // 2. Fetch contact for context
    var contact = await sb.one('contacts?slug=eq.' + batch.client_slug + '&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // 3. Check for existing entity audit to get the audit_id for checklist items
    var audits = await sb.query('entity_audits?client_slug=eq.' + batch.client_slug +
      '&status=in.(complete,delivered)&order=created_at.desc&limit=1');
    var auditId = (audits && audits[0]) ? audits[0].id : null;

    // 4. Send synthesis to Claude for extraction
    var prompt = buildExtractionPrompt(batch.synthesis_raw, contact);

    var claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeResp.ok) {
      var errText = await claudeResp.text();
      return res.status(502).json({ error: 'Claude API error: ' + claudeResp.status, detail: errText.substring(0, 300) });
    }

    var claudeResult = await claudeResp.json();
    var responseText = '';
    for (var i = 0; i < claudeResult.content.length; i++) {
      if (claudeResult.content[i].type === 'text') responseText += claudeResult.content[i].text;
    }

    // 5. Parse JSON response
    var parsed = null;
    try {
      // Extract JSON from response (may be wrapped in markdown)
      var jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.error('Failed to parse synthesis extraction:', e.message);
      return res.status(500).json({ error: 'Failed to parse Claude response', raw: responseText.substring(0, 500) });
    }

    if (!parsed) {
      return res.status(500).json({ error: 'No structured data extracted from synthesis' });
    }

    // 6. Create checklist items from extracted actions
    var items = [];
    var sortBase = 1000; // Start after entity audit items

    // Site-wide gaps
    if (parsed.site_wide_gaps && Array.isArray(parsed.site_wide_gaps)) {
      parsed.site_wide_gaps.forEach(function(gap, idx) {
        items.push({
          id: batch.client_slug + '-batch-gap-' + (idx + 1),
          client_slug: batch.client_slug,
          task_id: 'batch-gap-' + (idx + 1),
          priority: gap.priority || 'P1',
          category: gap.category || 'optimization',
          scope: gap.scope || 'on-page',
          title: gap.title || 'Site-wide gap',
          description: gap.description || '',
          owner: gap.owner || 'moonraker',
          status: 'not_started',
          sort_order: sortBase + idx,
          phase: gap.phase || 'batch-synthesis',
          web_visible: true,
          audit_id: auditId,
          audit_period: new Date().toISOString().substring(0, 7)
        });
      });
    }

    // Internal linking tasks
    if (parsed.internal_links && Array.isArray(parsed.internal_links)) {
      parsed.internal_links.forEach(function(link, idx) {
        items.push({
          id: batch.client_slug + '-batch-link-' + (idx + 1),
          client_slug: batch.client_slug,
          task_id: 'batch-link-' + (idx + 1),
          priority: 'P2',
          category: 'optimization',
          scope: 'on-page',
          title: 'Internal link: ' + (link.from_page || '?') + ' → ' + (link.to_page || '?'),
          description: 'Anchor text: "' + (link.anchor_text || '') + '". ' + (link.rationale || ''),
          owner: 'moonraker',
          status: 'not_started',
          sort_order: sortBase + 100 + idx,
          phase: 'batch-synthesis',
          web_visible: true,
          audit_id: auditId,
          audit_period: new Date().toISOString().substring(0, 7)
        });
      });
    }

    // Unified action plan items
    if (parsed.action_plan && Array.isArray(parsed.action_plan)) {
      parsed.action_plan.forEach(function(action, idx) {
        // Skip if already covered by site_wide_gaps or internal_links
        items.push({
          id: batch.client_slug + '-batch-action-' + (idx + 1),
          client_slug: batch.client_slug,
          task_id: 'batch-action-' + (idx + 1),
          priority: action.priority || 'P2',
          category: action.category || 'optimization',
          scope: action.scope || 'on-page',
          title: action.title || 'Batch action item',
          description: action.description || '',
          owner: action.owner || 'moonraker',
          status: 'not_started',
          sort_order: sortBase + 200 + idx,
          phase: action.phase || 'batch-synthesis',
          web_visible: true,
          audit_id: auditId,
          audit_period: new Date().toISOString().substring(0, 7)
        });
      });
    }

    // 7. Upsert checklist items (ON CONFLICT DO NOTHING for idempotency)
    var itemsCreated = 0;
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      try {
        await sb.mutate('checklist_items', 'POST', item, 'return=minimal,resolution=ignore-duplicates');
        itemsCreated++;
      } catch (e) {
        // 409 Conflict on duplicate is expected — sb.mutate still throws but
        // the row already existed. Treat any 409 as success to preserve the
        // original behavior (createResp.status === 409 → itemsCreated++).
        if (e.status === 409) itemsCreated++;
      }
    }

    // 8. Store processed synthesis on batch record
    await sb.mutate('content_audit_batches?id=eq.' + body.batch_id, 'PATCH', {
      synthesis_processed: parsed,
      updated_at: new Date().toISOString()
    }, 'return=minimal');

    return res.status(200).json({
      success: true,
      batch_id: body.batch_id,
      items_created: itemsCreated,
      total_items: items.length,
      has_gaps: !!(parsed.site_wide_gaps && parsed.site_wide_gaps.length),
      has_links: !!(parsed.internal_links && parsed.internal_links.length),
      has_actions: !!(parsed.action_plan && parsed.action_plan.length)
    });

  } catch(err) {
    console.error('process-batch-synthesis error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


function buildExtractionPrompt(synthesisRaw, contact) {
  var practiceName = contact.practice_name || (contact.first_name + ' ' + contact.last_name);

  return 'You are analyzing a Surge batch audit synthesis for "' + practiceName + '".\n\n' +
    'Extract actionable items from this synthesis into a structured JSON format.\n\n' +
    'The synthesis contains:\n' +
    '- Site-wide gaps (issues affecting multiple pages)\n' +
    '- Page-specific priorities and rankings\n' +
    '- Internal linking recommendations with anchor text\n' +
    '- TEPM (Transmodal Entity Phase Mapping) cluster analysis\n' +
    '- A unified action plan (P1/P2/P3)\n\n' +
    'Return ONLY valid JSON (no markdown, no explanation) with this structure:\n\n' +
    '{\n' +
    '  "site_wide_gaps": [\n' +
    '    {\n' +
    '      "title": "Short actionable title",\n' +
    '      "description": "What needs to be done and why",\n' +
    '      "priority": "P1" or "P2" or "P3",\n' +
    '      "category": "credibility" or "optimization" or "reputation" or "engagement",\n' +
    '      "scope": "on-page" or "off-page" or "technical",\n' +
    '      "owner": "moonraker" or "client" or "collaboration",\n' +
    '      "phase": "batch-synthesis"\n' +
    '    }\n' +
    '  ],\n' +
    '  "internal_links": [\n' +
    '    {\n' +
    '      "from_page": "/page-a",\n' +
    '      "to_page": "/page-b",\n' +
    '      "anchor_text": "the recommended anchor text",\n' +
    '      "rationale": "Why this link matters"\n' +
    '    }\n' +
    '  ],\n' +
    '  "action_plan": [\n' +
    '    {\n' +
    '      "title": "Action title",\n' +
    '      "description": "Detailed description",\n' +
    '      "priority": "P1" or "P2" or "P3",\n' +
    '      "category": "credibility" or "optimization" or "reputation" or "engagement",\n' +
    '      "scope": "on-page" or "off-page" or "technical",\n' +
    '      "owner": "moonraker" or "client" or "collaboration",\n' +
    '      "phase": "P1 - This Week" or "P2 - Next 2 Weeks" or "P3 - Ongoing"\n' +
    '    }\n' +
    '  ],\n' +
    '  "summary": {\n' +
    '    "avg_variance": number,\n' +
    '    "site_health": "string",\n' +
    '    "entity_health": "string",\n' +
    '    "strongest_page": "/path",\n' +
    '    "weakest_page": "/path",\n' +
    '    "tepm_level": number,\n' +
    '    "tepm_score": number,\n' +
    '    "priority_engine": "string",\n' +
    '    "single_highest_leverage_action": "string"\n' +
    '  }\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Do NOT duplicate items between site_wide_gaps and action_plan. If a gap appears in both, put it in site_wide_gaps only.\n' +
    '- Internal links should use URL paths (e.g., "/emdr-therapy"), not full URLs.\n' +
    '- Map priorities directly from the synthesis P1/P2/P3 designations.\n' +
    '- Category mapping: schema/structured data = optimization, citations/directories = credibility, content depth/FAQ = optimization, reviews/evidence = reputation, CTAs/booking = engagement.\n' +
    '- Owner mapping: technical SEO/schema/content = moonraker, directory claims/video creation = collaboration, review solicitation = client.\n' +
    '- Keep titles concise (under 80 chars). Put detail in description.\n\n' +
    'Here is the synthesis:\n\n' + synthesisRaw;
}
