// /api/activate-reporting.js
// One-button reporting activation. Creates LocalFalcon campaigns for all active
// tracked keywords, stores campaign keys on report_configs, and marks deliverables.
//
// POST { client_slug: "anna-skomorovskaia" }
//
// Creates 6 campaigns (one per platform):
//   Maps:  google (7x7, 5mi), apple (7x7, 5mi)
//   AI:    aimode (3x3, 5mi), gaio (3x3, 5mi), chatgpt (3x3, 5mi), gemini (3x3, 5mi)
//
// All campaigns: monthly frequency, run on the 28th at 6:00 AM UTC
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, LOCALFALCON_API_KEY

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var lfKey = process.env.LOCALFALCON_API_KEY;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!lfKey) return res.status(500).json({ error: 'LOCALFALCON_API_KEY not configured' });

  var clientSlug = (req.body && req.body.client_slug) || (req.query && req.query.client_slug);
  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

  var headers = {
    'apikey': sbKey,
    'Authorization': 'Bearer ' + sbKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    // ─── 1. Load report config ────────────────────────────────────
    var configResp = await fetch(sb.url() + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&limit=1', { headers: headers });
    var configs = await configResp.json();
    if (!configs || configs.length === 0) {
      return res.status(404).json({ error: 'No report_config found for ' + clientSlug });
    }
    var config = configs[0];

    if (!config.localfalcon_place_id) {
      return res.status(400).json({ error: 'localfalcon_place_id not set on report_config. Complete LocalFalcon setup first.' });
    }

    // Check if campaigns already exist
    var existingKeys = config.lf_campaign_keys || {};
    if (Object.keys(existingKeys).length > 0) {
      return res.status(409).json({
        error: 'Campaigns already exist for this client. Use force=true to recreate.',
        existing_keys: existingKeys
      });
    }

    // ─── 2. Load contact (for practice name) ─────────────────────
    var contactResp = await fetch(sb.url() + '/rest/v1/contacts?slug=eq.' + clientSlug + '&select=id,practice_name,first_name,last_name', { headers: headers });
    var contacts = await contactResp.json();
    var contact = (contacts && contacts.length > 0) ? contacts[0] : null;
    var practiceName = contact ? (contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim()) : clientSlug;

    // ─── 3. Load tracked keywords ────────────────────────────────
    var kwResp = await fetch(sb.url() + '/rest/v1/tracked_keywords?client_slug=eq.' + clientSlug + '&active=eq.true&order=priority.asc', { headers: headers });
    var keywords = await kwResp.json();
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'No active tracked_keywords for ' + clientSlug + '. Add keywords before activating reporting.' });
    }

    var keywordList = keywords.map(function(kw) { return kw.keyword; }).join(',');

    // ─── 4. Calculate start date (28th of current or next month) ──
    var now = new Date();
    var startYear = now.getUTCFullYear();
    var startMonth = now.getUTCMonth(); // 0-indexed

    // If we're past the 28th already, schedule for next month
    if (now.getUTCDate() > 28) {
      startMonth += 1;
      if (startMonth > 11) {
        startMonth = 0;
        startYear += 1;
      }
    }

    // Use the 28th (exists in every month including February)
    var startDay = 28;
    var startDate = String(startMonth + 1).padStart(2, '0') + '/' + String(startDay).padStart(2, '0') + '/' + startYear;

    // ─── 5. Create 6 campaigns ───────────────────────────────────
    var CAMPAIGN_CONFIG = [
      { suffix: 'Google Maps', platform: 'google', grid_size: '7', radius: '5' },
      { suffix: 'Apple Maps',  platform: 'apple',  grid_size: '7', radius: '5' },
      { suffix: 'AI Mode',     platform: 'aimode',  grid_size: '3', radius: '5' },
      { suffix: 'AI Overviews', platform: 'gaio',   grid_size: '3', radius: '5' },
      { suffix: 'ChatGPT',     platform: 'chatgpt', grid_size: '3', radius: '5' },
      { suffix: 'Gemini',      platform: 'gemini',  grid_size: '3', radius: '5' }
    ];

    var campaignKeys = {};
    var campaignErrors = [];
    var totalCredits = 0;

    for (var i = 0; i < CAMPAIGN_CONFIG.length; i++) {
      var cfg = CAMPAIGN_CONFIG[i];
      var campaignName = practiceName + ' ' + cfg.suffix;

      var body = 'api_key=' + encodeURIComponent(lfKey)
        + '&name=' + encodeURIComponent(campaignName)
        + '&measurement=mi'
        + '&grid_size=' + cfg.grid_size
        + '&radius=' + cfg.radius
        + '&frequency=monthly'
        + '&place_id=' + encodeURIComponent(config.localfalcon_place_id)
        + '&keyword=' + encodeURIComponent(keywordList)
        + '&start_date=' + encodeURIComponent(startDate)
        + '&start_time=' + encodeURIComponent('6:00 AM')
        + '&ai_analysis=0'
        + '&notify=0'
        + '&platform=' + cfg.platform;

      try {
        var lfResp = await fetch('https://api.localfalcon.com/v2/campaigns/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body
        });
        var lfResult = await lfResp.json();

        if (lfResult.success && lfResult.data && lfResult.data.campaign_key) {
          campaignKeys[cfg.platform] = lfResult.data.campaign_key;
          var credits = parseInt(lfResult.data.campaign_details.credits) || 0;
          totalCredits += credits;
        } else {
          campaignErrors.push(cfg.platform + ': ' + (lfResult.message || 'Unknown error'));
        }
      } catch (e) {
        campaignErrors.push(cfg.platform + ': ' + e.message);
      }
    }

    if (Object.keys(campaignKeys).length === 0) {
      return res.status(500).json({ error: 'All campaign creations failed', details: campaignErrors });
    }

    // ─── 6. Store campaign keys + activate config ────────────────
    var updateResp = await fetch(sb.url() + '/rest/v1/report_configs?id=eq.' + config.id, {
      method: 'PATCH',
      headers: headers,
      body: JSON.stringify({
        lf_campaign_keys: campaignKeys,
        updated_at: new Date().toISOString()
      })
    });

    if (!updateResp.ok) {
      var updateErr = await updateResp.text();
      return res.status(500).json({ error: 'Campaigns created but failed to store keys: ' + updateErr, campaign_keys: campaignKeys });
    }

    // ─── 7. Mark deliverables as complete ────────────────────────
    var deliverableTypes = ['localfalcon_setup', 'report_config'];
    var contactId = contact ? contact.id : null;

    if (contactId) {
      for (var di = 0; di < deliverableTypes.length; di++) {
        try {
          await fetch(sb.url() + '/rest/v1/deliverables?contact_id=eq.' + contactId + '&deliverable_type=eq.' + deliverableTypes[di] + '&status=neq.delivered', {
            method: 'PATCH',
            headers: headers,
            body: JSON.stringify({
              status: 'delivered',
              delivered_at: new Date().toISOString(),
              notes: 'Auto-completed by activate-reporting',
              updated_at: new Date().toISOString()
            })
          });
        } catch (e) { /* non-fatal */ }
      }
    }

    // ─── 8. Log activity ─────────────────────────────────────────
    try {
      await fetch(sb.url() + '/rest/v1/activity_log', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          contact_id: contactId,
          action: 'reporting_activated',
          detail: JSON.stringify({
            campaigns_created: Object.keys(campaignKeys).length,
            platforms: Object.keys(campaignKeys),
            keywords: keywords.length,
            credits_per_run: totalCredits,
            start_date: startDate,
            errors: campaignErrors
          }),
          created_by: 'system'
        })
      });
    } catch (e) { /* non-fatal */ }

    // ─── Done ────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      client_slug: clientSlug,
      practice_name: practiceName,
      campaigns_created: Object.keys(campaignKeys).length,
      campaign_keys: campaignKeys,
      keywords: keywords.length,
      keyword_list: keywords.map(function(kw) { return kw.keyword; }),
      credits_per_run: totalCredits,
      first_run: startDate + ' 6:00 AM UTC',
      frequency: 'monthly',
      config_active: config.active || false,
      campaign_errors: campaignErrors.length > 0 ? campaignErrors : undefined
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
};

