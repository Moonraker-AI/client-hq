// /api/compile-report.js
// Core reporting engine. Pulls data from 5+ sources, writes a report snapshot,
// generates highlights via Claude, and sends team notification via Resend.
//
// Sources:
//   1. Google Search Console (via Google API + service account)
//   2. Local Brand Manager   (via LBM API for GBP data)
//   3. DataForSEO            (AI visibility: Google AI Mode, Gemini, ChatGPT, Perplexity, Claude scrapers)
//   4. Supabase              (task progress from checklist_items)
//   5. Supabase              (previous month snapshot for deltas)
//
// Outputs:
//   - report_snapshots row (status: internal_review)
//   - report_highlights rows (auto-generated via Claude)
//   - Resend email to team for review
//   - Updates report_configs with last_compiled_at
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY,
//   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD, LBM_API_KEY,
//   GOOGLE_SERVICE_ACCOUNT_JSON (optional - graceful skip if missing)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var dfseLogin = process.env.DATAFORSEO_LOGIN;
  var dfsePw = process.env.DATAFORSEO_PASSWORD;
  var lbmKey = process.env.LBM_API_KEY;
  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var clientSlug = body.client_slug;
  var reportMonth = body.report_month; // e.g. "2026-04-01" (first of month)

  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

  // Default to previous month if not specified (reports compile data for the month that just ended)
  if (!reportMonth) {
    var now = new Date();
    var prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    reportMonth = prev.getUTCFullYear() + '-' + String(prev.getUTCMonth() + 1).padStart(2, '0') + '-01';
  }

  var errors = [];
  var warnings = [];

  // ─── Helpers ───────────────────────────────────────────────────
  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  }

  function dfseAuth() {
    return 'Basic ' + Buffer.from(dfseLogin + ':' + dfsePw).toString('base64');
  }

  function monthRange(monthStr) {
    // "2026-04-01" -> { start: "2026-04-01", end: "2026-04-30" }
    var d = new Date(monthStr + 'T00:00:00Z');
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth();
    var lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return {
      start: monthStr,
      end: y + '-' + String(m + 1).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0')
    };
  }

  function prevMonth(monthStr) {
    var d = new Date(monthStr + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01';
  }

  async function safe(label, fn) {
    try { return await fn(); }
    catch (e) { errors.push(label + ': ' + (e.message || String(e))); return null; }
  }

  // Fetch with timeout (AbortController)
  async function fetchT(url, opts, timeoutMs) {
    timeoutMs = timeoutMs || 25000;
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
      var mergedOpts = Object.assign({}, opts, { signal: controller.signal });
      var resp = await fetch(url, mergedOpts);
      clearTimeout(timer);
      return resp;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Timeout after ' + timeoutMs + 'ms');
      throw e;
    }
  }

  // ─── STEP 1: Load report config + contact ─────────────────────
  try {
    var configResp = await fetch(sbUrl + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&active=eq.true&limit=1', { headers: sbHeaders() });
    var configs = await configResp.json();
    if (!configs || configs.length === 0) return res.status(404).json({ error: 'No active report_config for ' + clientSlug });
    var config = configs[0];

    var contactResp = await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + clientSlug + '&select=id,slug,first_name,last_name,practice_name,email,campaign_start,status', { headers: sbHeaders() });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found for ' + clientSlug });
    var contact = contacts[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load config/contact: ' + e.message });
  }

  var range = monthRange(reportMonth);
  var practiceName = contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim();

  // Calculate campaign month number
  var campaignMonth = 1;
  if (contact.campaign_start) {
    var csDate = new Date(contact.campaign_start + 'T00:00:00Z');
    var rmDate = new Date(reportMonth + 'T00:00:00Z');
    campaignMonth = (rmDate.getUTCFullYear() - csDate.getUTCFullYear()) * 12 + (rmDate.getUTCMonth() - csDate.getUTCMonth()) + 1;
    if (campaignMonth < 1) campaignMonth = 1;
  }

  // ─── STEP 1b: Load tracked keywords (source of truth) ─────────
  // Falls back to report_configs.tracked_queries for backward compat
  var trackedKeywords = [];
  try {
    var kwResp = await fetch(sbUrl + '/rest/v1/tracked_keywords?client_slug=eq.' + clientSlug + '&active=eq.true&order=priority.asc,keyword.asc', { headers: sbHeaders() });
    var kwRows = await kwResp.json();
    if (Array.isArray(kwRows) && kwRows.length > 0) {
      trackedKeywords = kwRows;
    }
  } catch (e) { /* non-fatal */ }

  // Build unified query list for AI visibility (from tracked_keywords or report_configs fallback)
  var aiQueries = [];
  var geogridKeywords = [];
  if (trackedKeywords.length > 0) {
    trackedKeywords.forEach(function(kw) {
      if (kw.track_ai_visibility) {
        aiQueries.push({ label: kw.label || kw.keyword, query: kw.keyword });
      }
      if (kw.track_geogrid) {
        geogridKeywords.push(kw);
      }
    });
  } else if (config.tracked_queries && config.tracked_queries.length > 0) {
    // Fallback to report_configs
    config.tracked_queries.forEach(function(q) {
      aiQueries.push({ label: q.label, query: q.query });
    });
    // Can't do geogrids without tracked_keywords (no place_id etc)
  }

  // ─── STEP 2: Load previous month snapshot for deltas ──────────
  var prevSnap = await safe('prev_snapshot', async function() {
    var pm = prevMonth(reportMonth);
    var r = await fetch(sbUrl + '/rest/v1/report_snapshots?client_slug=eq.' + clientSlug + '&report_month=eq.' + pm + '&limit=1', { headers: sbHeaders() });
    var rows = await r.json();
    return (rows && rows.length > 0) ? rows[0] : null;
  });

  // ─── STEPS 3-7: Pull all data sources IN PARALLEL ──────────────
  // GSC, GBP, DataForSEO, and tasks all run concurrently.
  // Within DataForSEO, all 5 engines also run concurrently.

  var gscFn = safe('gsc', async function() {
    if (!googleSA || !config.gsc_property) {
      warnings.push('GSC: skipped (no credentials or property configured)');
      return null;
    }
    var token = await getGoogleAccessToken(googleSA);
    if (!token || token.error) {
      warnings.push('GSC: token failed - ' + (token ? token.error : 'unknown'));
      return null;
    }

    var gscBase = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(config.gsc_property) + '/searchAnalytics/query';
    var gscHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Run all 3 GSC queries in parallel
    var results = await Promise.all([
      fetchT(gscBase, { method: 'POST', headers: gscHeaders, body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: [], rowLimit: 1 }) }, 15000).then(function(r) { return r.json(); }),
      fetchT(gscBase, { method: 'POST', headers: gscHeaders, body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: ['page'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }) }, 15000).then(function(r) { return r.json(); }),
      fetchT(gscBase, { method: 'POST', headers: gscHeaders, body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: ['query'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }) }, 15000).then(function(r) { return r.json(); })
    ]);

    var totals = (results[0].rows && results[0].rows[0]) || {};
    return {
      clicks: Math.round(totals.clicks || 0),
      impressions: Math.round(totals.impressions || 0),
      ctr: Math.round((totals.ctr || 0) * 10000) / 100,
      position: Math.round((totals.position || 0) * 10) / 10,
      pages: (results[1].rows || []).slice(0, 5).map(function(r) {
        return { page: r.keys[0].replace(/https?:\/\/[^/]+/, ''), clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 10000) / 100, position: Math.round(r.position * 10) / 10 };
      }),
      queries: (results[2].rows || []).slice(0, 5).map(function(r) {
        return { query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 10000) / 100, position: Math.round(r.position * 10) / 10 };
      })
    };
  });

  var gbpFn = safe('lbm', async function() {
    if (!lbmKey || !config.lbm_location_id) {
      warnings.push('LBM/GBP: skipped (no key or location configured)');
      return null;
    }

    var lbmHeaders = { 'Authorization': lbmKey, 'Content-Type': 'application/json' };

    // Step 1: Get the location to find its gbp_id and check if enabled
    var locResp = await fetchT('https://api.localbrandmanager.com/locations', { headers: lbmHeaders }, 10000);
    var locations = await locResp.json();
    var location = null;
    if (Array.isArray(locations)) {
      location = locations.find(function(l) { return l.id === config.lbm_location_id; });
    }
    if (!location) { warnings.push('LBM: location ' + config.lbm_location_id + ' not found'); return null; }
    if (!location.enabled) { warnings.push('LBM: location "' + location.name + '" is disabled in LBM - enable it to generate reports'); return null; }

    // Step 2: Find a report that contains this location
    var reportUrl = 'https://api.localbrandmanager.com/reports';
    var listResp = await fetchT(reportUrl, { headers: lbmHeaders }, 10000);
    var reports = await listResp.json();

    var report = null;
    if (Array.isArray(reports)) {
      report = reports.find(function(r) {
        var locs = r.locations || [];
        return locs.some(function(l) { return l.store_code === location.gbp_id || l.store_code === location.store_code || l.name === location.name; });
      });
    }
    if (!report) { warnings.push('LBM: no report found for "' + location.name + '"'); return null; }

    // Step 3: Get report detail
    var detailResp = await fetchT(reportUrl + '/' + report.id, { headers: lbmHeaders }, 10000);
    var detail = await detailResp.json();

    // Step 4: Extract metrics from charts.stats[] array
    var stats = (detail.charts && detail.charts.stats) || [];
    function statSum(id) {
      var s = stats.find(function(st) { return st.id === id; });
      return s ? (s.sum || 0) : 0;
    }
    function statPrev(id) {
      var s = stats.find(function(st) { return st.id === id; });
      return s ? (s.sum_compare || 0) : 0;
    }

    var reviewData = detail.reviews || {};
    var aggReviews = (reviewData.aggregated && reviewData.aggregated.sum && reviewData.aggregated.sum.data) || {};

    return {
      calls: statSum('call_clicks'),
      direction_requests: statSum('direction_requests'),
      website_clicks: statSum('website_clicks'),
      photo_views: statSum('images'),
      impressions_total: statSum('business_impressions_desktop_maps') + statSum('business_impressions_desktop_search') + statSum('business_impressions_mobile_search'),
      reviews: {
        total: aggReviews.total || statSum('reviews'),
        average: 0,
        new_this_month: statSum('reviews')
      },
      prev: {
        calls: statPrev('call_clicks'),
        website_clicks: statPrev('website_clicks'),
        impressions_total: statPrev('business_impressions_desktop_maps') + statPrev('business_impressions_desktop_search') + statPrev('business_impressions_mobile_search')
      }
    };
  });

  var aiFn = safe('dataforseo', async function() {
    if (!dfseLogin || !dfsePw) {
      warnings.push('DataForSEO: skipped (no credentials)');
      return null;
    }

    if (aiQueries.length === 0) {
      warnings.push('DataForSEO: no tracked queries configured');
      return null;
    }

    var clientDomain = '';
    if (config.gsc_property) {
      clientDomain = config.gsc_property.replace('sc-domain:', '').replace('https://', '').replace('http://', '').split('/')[0];
    }

    var engineChecks = [
      { name: 'Google AI Mode', method: 'google_ai_mode' },
      { name: 'Gemini', method: 'gemini_scraper' },
      { name: 'ChatGPT', method: 'chatgpt_scraper' },
      { name: 'Perplexity', method: 'perplexity_llm' },
      { name: 'Claude', method: 'claude_llm' }
    ];

    var queriesToCheck = aiQueries.slice(0, 3); // Cap at 3 to stay within budget

    // Run ALL engines in parallel — each engine checks its queries sequentially
    var engineResults = await Promise.all(engineChecks.map(async function(engine) {
      var cited = false;
      var context = null;
      var citedQueries = [];

      for (var qi = 0; qi < queriesToCheck.length; qi++) {
        var q = queriesToCheck[qi];
        try {
          var result = await checkEngineVisibility(engine.method, q.query, clientDomain, dfseAuth());
          if (result.cited) {
            cited = true;
            citedQueries.push(q.label || q.query);
            if (!context && result.context) context = result.context;
          }
        } catch (e) {
          warnings.push('DataForSEO ' + engine.name + ' "' + q.query + '": ' + e.message);
        }
      }

      return {
        name: engine.name,
        cited: cited,
        context: context || (cited ? 'Cited for: ' + citedQueries.join(', ') : null),
        queries_checked: queriesToCheck.length,
        queries_cited: citedQueries.length
      };
    }));

    // Pull LLM Mentions aggregated in parallel with engine checks? No — it ran with them.
    var mentionsData = null;
    try {
      mentionsData = await getLLMMentionsAggregated(clientDomain, dfseAuth());
    } catch (e) {
      warnings.push('LLM Mentions aggregated: ' + e.message);
    }

    return {
      engines: engineResults,
      engines_checked: engineResults.length,
      engines_citing: engineResults.filter(function(e) { return e.cited; }).length,
      ai_search_volume: mentionsData ? mentionsData.ai_search_volume : null,
      ai_impressions: mentionsData ? mentionsData.impressions : null,
      ai_mentions_count: mentionsData ? mentionsData.mentions : null,
      citation_trend: []
    };
  });

  var taskFn = safe('tasks', async function() {
    var taskResp = await fetchT(sbUrl + '/rest/v1/checklist_items?client_slug=eq.' + clientSlug + '&select=status', { headers: sbHeaders() }, 10000);
    var tasks = await taskResp.json();
    if (!Array.isArray(tasks)) return { total: 0, complete: 0, in_progress: 0, not_started: 0 };
    return {
      total: tasks.length,
      complete: tasks.filter(function(t) { return t.status === 'complete'; }).length,
      in_progress: tasks.filter(function(t) { return t.status === 'in_progress'; }).length,
      not_started: tasks.filter(function(t) { return t.status === 'not_started'; }).length
    };
  });

  var geogridFn = safe('geogrids', async function() {
    if (!lbmKey || !config.lbm_location_id) {
      warnings.push('Geogrids: skipped (no LBM key or location)');
      return null;
    }

    var lbmHeaders = { 'Authorization': lbmKey, 'Content-Type': 'application/json' };

    // Fetch all geogrids (API doesn't filter by location_id server-side)
    var resp = await fetchT('https://api.localbrandmanager.com/geogrids', { headers: lbmHeaders }, 15000);
    var allGrids = await resp.json();

    if (!Array.isArray(allGrids) || allGrids.length === 0) {
      warnings.push('Geogrids: no data returned');
      return null;
    }

    // Also get the location to find its geogrid_config_id
    var locResp = await fetchT('https://api.localbrandmanager.com/locations/' + config.lbm_location_id, { headers: lbmHeaders }, 10000);
    var location = await locResp.json();
    var locGbpId = location ? location.gbp_id : null;

    // Filter grids for this client's location by matching location_id OR gbp_id
    var clientGrids = allGrids.filter(function(g) {
      return g.location_id === config.lbm_location_id || g.gbp_id === locGbpId;
    });

    if (clientGrids.length === 0) {
      warnings.push('Geogrids: no grids found for location ' + config.lbm_location_id);
      return null;
    }

    // Get the most recent finished grid for each search term
    var byTerm = {};
    clientGrids.forEach(function(g) {
      if (g.state !== 'finished') return;
      var term = g.search_term;
      if (!byTerm[term] || new Date(g.created_at) > new Date(byTerm[term].created_at)) {
        byTerm[term] = g;
      }
    });

    var grids = Object.values(byTerm).map(function(g) {
      return {
        search_term: g.search_term,
        agr: g.agr,
        atgr: g.atgr,
        solv: g.solv,
        grid_size: g.grid_size,
        ranks: g.ranks,
        image_url: g.image_url || null,
        headless_image_url: g.headless_image_url || null,
        public_url: g.public_url || null,
        created_at: g.created_at,
        finished_at: g.finished_at
      };
    });

    // Sort by SOLV descending (best performing terms first)
    grids.sort(function(a, b) { return (b.solv || 0) - (a.solv || 0); });

    // Compute averages across all tracked terms
    var avgAgr = grids.length > 0 ? grids.reduce(function(s, g) { return s + (g.agr || 0); }, 0) / grids.length : 0;
    var avgSolv = grids.length > 0 ? grids.reduce(function(s, g) { return s + (g.solv || 0); }, 0) / grids.length : 0;

    return {
      grids: grids,
      grid_count: grids.length,
      avg_agr: Math.round(avgAgr * 100) / 100,
      avg_solv: Math.round(avgSolv * 1000) / 1000
    };
  });

  // Fire all 5 data sources concurrently
  var parallel = await Promise.all([gscFn, gbpFn, aiFn, taskFn, geogridFn]);
  var gscData = parallel[0];
  var gbpData = parallel[1];
  var aiData = parallel[2];
  var taskData = parallel[3];
  var geogridData = parallel[4];

  // Build citation_trend from historical snapshots
  if (aiData) {
    try {
      var histResp = await fetch(sbUrl + '/rest/v1/report_snapshots?client_slug=eq.' + clientSlug + '&select=report_month,ai_visibility&order=report_month.asc&limit=12', { headers: sbHeaders() });
      var histRows = await histResp.json();
      if (Array.isArray(histRows)) {
        aiData.citation_trend = histRows.map(function(r) {
          var av = r.ai_visibility || {};
          return { month: r.report_month.substring(0, 7), count: av.engines_citing || 0 };
        });
        aiData.citation_trend.push({ month: reportMonth.substring(0, 7), count: aiData.engines_citing });
      }
    } catch (e) { /* non-fatal */ }
  }

  // ─── STEP 8: Build the snapshot row ────────────────────────────
  var snapshot = {
    client_slug: clientSlug,
    report_month: reportMonth,
    campaign_start: contact.campaign_start || null,
    campaign_month: campaignMonth,
    report_status: 'draft',

    // GSC
    gsc_clicks: gscData ? gscData.clicks : null,
    gsc_impressions: gscData ? gscData.impressions : null,
    gsc_ctr: gscData ? gscData.ctr : null,
    gsc_avg_position: gscData ? gscData.position : null,
    gsc_clicks_prev: prevSnap ? prevSnap.gsc_clicks : null,
    gsc_impressions_prev: prevSnap ? prevSnap.gsc_impressions : null,
    gsc_ctr_prev: prevSnap ? prevSnap.gsc_ctr : null,
    gsc_avg_position_prev: prevSnap ? prevSnap.gsc_avg_position : null,

    // GBP
    gbp_calls: gbpData ? gbpData.calls : null,
    gbp_direction_requests: gbpData ? gbpData.direction_requests : null,
    gbp_website_clicks: gbpData ? gbpData.website_clicks : null,
    gbp_photo_views: gbpData ? gbpData.photo_views : null,
    gbp_calls_prev: prevSnap ? prevSnap.gbp_calls : null,
    gbp_direction_requests_prev: prevSnap ? prevSnap.gbp_direction_requests : null,
    gbp_website_clicks_prev: prevSnap ? prevSnap.gbp_website_clicks : null,
    gbp_photo_views_prev: prevSnap ? prevSnap.gbp_photo_views : null,

    // CORE scores (carry forward from previous or null)
    score_credibility: prevSnap ? prevSnap.score_credibility : null,
    score_optimization: prevSnap ? prevSnap.score_optimization : null,
    score_reputation: prevSnap ? prevSnap.score_reputation : null,
    score_engagement: prevSnap ? prevSnap.score_engagement : null,

    // Tasks
    tasks_total: taskData ? taskData.total : 0,
    tasks_complete: taskData ? taskData.complete : 0,
    tasks_in_progress: taskData ? taskData.in_progress : 0,
    tasks_not_started: taskData ? taskData.not_started : 0,

    // Detail JSON
    gsc_detail: gscData ? { date_range: range, pages: gscData.pages, queries: gscData.queries } : {},
    gbp_detail: gbpData ? { reviews: gbpData.reviews } : {},
    ai_visibility: aiData || {},
    neo_data: geogridData || {},
    deliverables: [],
    notes: ''
  };

  // ─── STEP 9: Upsert snapshot to Supabase ──────────────────────
  var snapshotId = null;
  try {
    // Check if snapshot already exists for this month
    var existResp = await fetch(sbUrl + '/rest/v1/report_snapshots?client_slug=eq.' + clientSlug + '&report_month=eq.' + reportMonth + '&limit=1', { headers: sbHeaders() });
    var existing = await existResp.json();

    if (existing && existing.length > 0) {
      // Update existing
      snapshotId = existing[0].id;
      snapshot.updated_at = new Date().toISOString();
      var updateResp = await fetch(sbUrl + '/rest/v1/report_snapshots?id=eq.' + snapshotId, {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(snapshot)
      });
      if (!updateResp.ok) throw new Error('PATCH failed: ' + (await updateResp.text()));
    } else {
      // Insert new
      var insertResp = await fetch(sbUrl + '/rest/v1/report_snapshots', {
        method: 'POST', headers: sbHeaders(), body: JSON.stringify(snapshot)
      });
      if (!insertResp.ok) throw new Error('INSERT failed: ' + (await insertResp.text()));
      var inserted = await insertResp.json();
      snapshotId = Array.isArray(inserted) ? inserted[0].id : inserted.id;
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write snapshot: ' + e.message, errors: errors });
  }

  // ─── STEP 10: Generate highlights via Claude ──────────────────
  var highlights = [];
  if (anthropicKey) {
    try {
      highlights = await generateHighlights(snapshot, prevSnap, practiceName, anthropicKey);
      // Write highlights to Supabase
      // Delete existing highlights for this month first
      await fetch(sbUrl + '/rest/v1/report_highlights?client_slug=eq.' + clientSlug + '&report_month=eq.' + reportMonth, {
        method: 'DELETE', headers: sbHeaders()
      });
      if (highlights.length > 0) {
        var hlResp = await fetch(sbUrl + '/rest/v1/report_highlights', {
          method: 'POST', headers: sbHeaders(), body: JSON.stringify(highlights)
        });
        if (!hlResp.ok) warnings.push('Highlights insert: ' + (await hlResp.text()));
      }
    } catch (e) {
      warnings.push('Highlight generation: ' + e.message);
    }
  }

  // ─── STEP 11: Flip status to internal_review ──────────────────
  try {
    var statusResp = await fetch(sbUrl + '/rest/v1/report_snapshots?id=eq.' + snapshotId, {
      method: 'PATCH', headers: sbHeaders(),
      body: JSON.stringify({ report_status: 'internal_review', updated_at: new Date().toISOString() })
    });
    if (!statusResp.ok) {
      var statusErr = await statusResp.text();
      warnings.push('Status flip failed: ' + statusResp.status + ' ' + statusErr);
    }
  } catch (e) { warnings.push('Status flip: ' + e.message); }

  // ─── STEP 12: Update report_configs compile timestamp ─────────
  try {
    await fetch(sbUrl + '/rest/v1/report_configs?id=eq.' + config.id, {
      method: 'PATCH', headers: sbHeaders(),
      body: JSON.stringify({
        last_compiled_at: new Date().toISOString(),
        last_compiled_status: errors.length > 0 ? 'partial' : 'success',
        last_compiled_errors: errors,
        updated_at: new Date().toISOString()
      })
    });
  } catch (e) { /* non-fatal */ }

  // ─── STEP 13: Send team notification via Resend ───────────────
  var notificationSent = false;
  if (resendKey) {
    try {
      var reviewUrl = 'https://clients.moonraker.ai/admin/reports';
      var aiSummary = '';
      if (aiData) {
        aiSummary = aiData.engines_citing + ' of ' + aiData.engines_checked + ' AI engines citing';
        if (aiData.ai_search_volume) aiSummary += ' | AI Search Volume: ' + aiData.ai_search_volume.toLocaleString();
        if (aiData.ai_impressions) aiSummary += ' | Impressions: ' + aiData.ai_impressions.toLocaleString();
      }

      var emailBody = '<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px">'
        + '<div style="background:#141C3A;padding:20px 24px;border-radius:12px 12px 0 0">'
        + '<img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" height="28" />'
        + '</div>'
        + '<div style="background:#fff;padding:24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px">'
        + '<h2 style="font-family:Outfit,sans-serif;color:#1E2A5E;margin:0 0 8px">Report Ready for Review</h2>'
        + '<p style="color:#6B7599;margin:0 0 16px">Month ' + campaignMonth + ' report for <strong style="color:#1E2A5E">' + practiceName + '</strong> has been compiled.</p>'
        + '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
        + (gscData ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">GSC Clicks</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + gscData.clicks.toLocaleString() + '</td></tr>' : '')
        + (gbpData ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">GBP Calls</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + gbpData.calls + '</td></tr>' : '')
        + (aiSummary ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">AI Visibility</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + aiSummary + '</td></tr>' : '')
        + (geogridData ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">Maps (Geogrids)</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + geogridData.grid_count + ' terms tracked | Avg AGR ' + geogridData.avg_agr + ' | SOLV ' + Math.round(geogridData.avg_solv * 100) + '%</td></tr>' : '')
        + '</table>'
        + (errors.length > 0 ? '<p style="color:#EF4444;font-size:13px">Warnings: ' + errors.join('; ') + '</p>' : '')
        + '<a href="' + reviewUrl + '" style="display:inline-block;background:#00D47E;color:#fff;font-weight:600;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:8px">Review Report</a>'
        + '</div></div>';

      var emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Client HQ <notifications@clients.moonraker.ai>',
          to: ['chris@moonraker.ai', 'scott@moonraker.ai'],
          subject: 'Report Ready: ' + practiceName + ' - Month ' + campaignMonth,
          html: emailBody
        })
      });
      notificationSent = emailResp.ok;
      if (!notificationSent) {
        var resendErr = await emailResp.text();
        warnings.push('Resend failed: ' + emailResp.status + ' ' + resendErr);
      }
      if (notificationSent) {
        await fetch(sbUrl + '/rest/v1/report_configs?id=eq.' + config.id, {
          method: 'PATCH', headers: sbHeaders(),
          body: JSON.stringify({ last_notified_at: new Date().toISOString() })
        });
      }
    } catch (e) { warnings.push('Resend notification: ' + e.message); }
  }

  // ─── DONE ─────────────────────────────────────────────────────
  return res.status(200).json({
    success: true,
    snapshot_id: snapshotId,
    client_slug: clientSlug,
    report_month: reportMonth,
    campaign_month: campaignMonth,
    practice_name: practiceName,
    status: 'internal_review',
    data_sources: {
      gsc: gscData ? 'ok' : 'skipped',
      gbp: gbpData ? 'ok' : 'skipped',
      ai_visibility: aiData ? { engines_citing: aiData.engines_citing, engines_checked: aiData.engines_checked, ai_search_volume: aiData.ai_search_volume, ai_impressions: aiData.ai_impressions } : 'skipped',
      geogrids: geogridData ? { grid_count: geogridData.grid_count, avg_agr: geogridData.avg_agr, avg_solv: geogridData.avg_solv } : 'skipped',
      tasks: taskData ? 'ok' : 'skipped'
    },
    highlights_count: highlights.length,
    notification_sent: notificationSent,
    errors: errors,
    warnings: warnings
  });
};


// ═══════════════════════════════════════════════════════════════════
// Helper: Google Service Account JWT → Access Token
// ═══════════════════════════════════════════════════════════════════
async function getGoogleAccessToken(saJson) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('Service account JSON missing private_key or client_email');
    }
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })).toString('base64url');

    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');

    var jwt = signable + '.' + signature;

    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      throw new Error('Google OAuth error: ' + (tokenData.error_description || tokenData.error || JSON.stringify(tokenData)));
    }
    return tokenData.access_token;
  } catch (e) {
    // Return error message so caller can surface it
    return { error: e.message || String(e) };
  }
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Check AI engine visibility for a query
// ═══════════════════════════════════════════════════════════════════
async function checkEngineVisibility(method, query, clientDomain, authHeader) {
  var baseUrl = 'https://api.dataforseo.com/v3';
  var headers = { 'Authorization': authHeader, 'Content-Type': 'application/json' };
  var cited = false;
  var context = null;
  var TIMEOUT = 30000; // 30s per engine call

  async function timedFetch(url, opts) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, TIMEOUT);
    try {
      var r = await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
      clearTimeout(timer);
      return r;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Timeout after ' + TIMEOUT + 'ms');
      throw e;
    }
  }

  if (method === 'google_ai_mode') {
    var resp = await timedFetch(baseUrl + '/serp/google/ai_mode/live/advanced', {
      method: 'POST', headers: headers, body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: 'en' }])
    });
    var data = await resp.json();
    var task = data.tasks && data.tasks[0];
    if (task && task.result && task.result[0]) {
      var items = task.result[0].items || [];
      for (var i = 0; i < items.length; i++) {
        var refs = items[i].references || [];
        for (var j = 0; j < refs.length; j++) {
          if (refs[j].domain && refs[j].domain.indexOf(clientDomain) !== -1) {
            cited = true;
            context = 'Referenced in Google AI Mode for "' + query + '" (position ' + (j + 1) + ' of ' + refs.length + ')';
            break;
          }
        }
        // Also check nested items
        var nested = items[i].items || [];
        for (var n = 0; n < nested.length; n++) {
          var nRefs = nested[n].references || [];
          for (var nr = 0; nr < nRefs.length; nr++) {
            if (nRefs[nr].domain && nRefs[nr].domain.indexOf(clientDomain) !== -1) {
              cited = true;
              if (!context) context = 'Referenced in Google AI Mode for "' + query + '"';
              break;
            }
          }
        }
        if (cited) break;
      }
    }
  }

  else if (method === 'gemini_scraper') {
    var resp = await timedFetch(baseUrl + '/ai_optimization/gemini/llm_scraper/live/advanced', {
      method: 'POST', headers: headers, body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: 'en' }])
    });
    var data = await resp.json();
    var task = data.tasks && data.tasks[0];
    if (task && task.result && task.result[0]) {
      var items = task.result[0].items || [];
      for (var i = 0; i < items.length; i++) {
        var md = items[i].markdown || items[i].text || '';
        if (md.toLowerCase().indexOf(clientDomain) !== -1) {
          cited = true;
          // Extract context around the mention
          var idx = md.toLowerCase().indexOf(clientDomain);
          var start = Math.max(0, idx - 50);
          var end = Math.min(md.length, idx + clientDomain.length + 80);
          context = 'Gemini: "...' + md.substring(start, end).replace(/\n/g, ' ').trim() + '..."';
          break;
        }
      }
    }
  }

  else if (method === 'chatgpt_scraper') {
    var resp = await timedFetch(baseUrl + '/ai_optimization/chat_gpt/llm_scraper/live/advanced', {
      method: 'POST', headers: headers, body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: 'en' }])
    });
    var data = await resp.json();
    var task = data.tasks && data.tasks[0];
    if (task && task.result && task.result[0]) {
      var items = task.result[0].items || [];
      for (var i = 0; i < items.length; i++) {
        var md = items[i].markdown || items[i].text || '';
        if (md.toLowerCase().indexOf(clientDomain) !== -1) {
          cited = true;
          var idx = md.toLowerCase().indexOf(clientDomain);
          var start = Math.max(0, idx - 50);
          var end = Math.min(md.length, idx + clientDomain.length + 80);
          context = 'ChatGPT: "...' + md.substring(start, end).replace(/\n/g, ' ').trim() + '..."';
          break;
        }
      }
    }
  }

  else if (method === 'perplexity_llm') {
    var resp = await timedFetch(baseUrl + '/ai_optimization/perplexity/llm_responses/live', {
      method: 'POST', headers: headers, body: JSON.stringify([{
        user_prompt: query, model_name: 'sonar', web_search: true, max_output_tokens: 800
      }])
    });
    var data = await resp.json();
    var task = data.tasks && data.tasks[0];
    if (task && task.result && task.result[0]) {
      var items = task.result[0].items || [];
      for (var i = 0; i < items.length; i++) {
        // Check text
        var text = '';
        var sections = items[i].sections || [];
        for (var s = 0; s < sections.length; s++) {
          text += (sections[s].text || '') + ' ';
          // Check annotations
          var annots = sections[s].annotations || [];
          for (var a = 0; a < annots.length; a++) {
            if (annots[a].url && annots[a].url.indexOf(clientDomain) !== -1) {
              cited = true;
              context = 'Cited by Perplexity with direct link to ' + annots[a].url.substring(0, 80);
              break;
            }
          }
          if (cited) break;
        }
        if (!cited && text.toLowerCase().indexOf(clientDomain) !== -1) {
          cited = true;
          context = 'Mentioned in Perplexity response for "' + query + '"';
        }
        if (cited) break;
      }
    }
  }

  else if (method === 'claude_llm') {
    var resp = await timedFetch(baseUrl + '/ai_optimization/claude/llm_responses/live', {
      method: 'POST', headers: headers, body: JSON.stringify([{
        user_prompt: query, model_name: 'claude-haiku-4-5', web_search: true, max_output_tokens: 800
      }])
    });
    var data = await resp.json();
    var task = data.tasks && data.tasks[0];
    if (task && task.result && task.result[0]) {
      var items = task.result[0].items || [];
      for (var i = 0; i < items.length; i++) {
        var text = items[i].text || items[i].markdown || '';
        if (text.toLowerCase().indexOf(clientDomain) !== -1) {
          cited = true;
          context = 'Mentioned in Claude response for "' + query + '"';
          break;
        }
      }
    }
  }

  return { cited: cited, context: context };
}


// ═══════════════════════════════════════════════════════════════════
// Helper: LLM Mentions Aggregated Metrics
// ═══════════════════════════════════════════════════════════════════
async function getLLMMentionsAggregated(clientDomain, authHeader) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 20000);
  try {
    var resp = await fetch('https://api.dataforseo.com/v3/ai_optimization/llm_mentions/aggregated_metrics/live', {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify([{
        language_code: 'en',
        location_code: 2840,
        platform: 'google',
        target: [{ domain: clientDomain, search_filter: 'include', search_scope: ['sources'] }]
      }])
    });
    clearTimeout(timer);
    var data = await resp.json();
    var task = data.tasks && data.tasks[0];
    if (task && task.result && task.result[0]) {
      var total = task.result[0].total || {};
      var platform = (total.platform && total.platform[0]) || {};
      return {
        mentions: platform.mentions || 0,
        ai_search_volume: platform.ai_search_volume || 0,
        impressions: platform.impressions || 0
      };
    }
    return null;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('LLM Mentions timeout after 20s');
    throw e;
  }
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Generate highlights via Claude
// ═══════════════════════════════════════════════════════════════════
async function generateHighlights(snapshot, prevSnap, practiceName, apiKey) {
  var metricsContext = 'Practice: ' + practiceName + '\nCampaign Month: ' + snapshot.campaign_month + '\n\n';

  if (snapshot.gsc_clicks !== null) {
    metricsContext += 'GSC: ' + snapshot.gsc_clicks + ' clicks, ' + snapshot.gsc_impressions + ' impressions, ' + snapshot.gsc_ctr + '% CTR, pos ' + snapshot.gsc_avg_position;
    if (snapshot.gsc_clicks_prev !== null) metricsContext += ' (prev: ' + snapshot.gsc_clicks_prev + ' clicks)';
    metricsContext += '\n';
  }
  if (snapshot.gbp_calls !== null) {
    metricsContext += 'GBP: ' + snapshot.gbp_calls + ' calls, ' + snapshot.gbp_direction_requests + ' directions, ' + snapshot.gbp_website_clicks + ' website clicks';
    if (snapshot.gbp_calls_prev !== null) metricsContext += ' (prev: ' + snapshot.gbp_calls_prev + ' calls)';
    metricsContext += '\n';
  }

  var ai = snapshot.ai_visibility || {};
  if (ai.engines_checked) {
    metricsContext += 'AI Visibility: ' + ai.engines_citing + ' of ' + ai.engines_checked + ' engines citing';
    if (ai.ai_search_volume) metricsContext += ', AI Search Volume: ' + ai.ai_search_volume;
    if (ai.ai_impressions) metricsContext += ', Impressions: ' + ai.ai_impressions;
    metricsContext += '\n';
    var engines = ai.engines || [];
    for (var i = 0; i < engines.length; i++) {
      metricsContext += '  ' + engines[i].name + ': ' + (engines[i].cited ? 'CITED' : 'not cited');
      if (engines[i].context) metricsContext += ' - ' + engines[i].context;
      metricsContext += '\n';
    }
  }

  metricsContext += 'Tasks: ' + snapshot.tasks_complete + '/' + snapshot.tasks_total + ' complete, ' + snapshot.tasks_in_progress + ' in progress\n';

  var neo = snapshot.neo_data || {};
  if (neo.grids && neo.grids.length > 0) {
    metricsContext += '\nMaps/Geogrid Performance (' + neo.grid_count + ' terms tracked, avg AGR ' + neo.avg_agr + ', avg SOLV ' + Math.round(neo.avg_solv * 100) + '%):\n';
    for (var gi = 0; gi < neo.grids.length; gi++) {
      var grid = neo.grids[gi];
      metricsContext += '  "' + grid.search_term + '": AGR ' + grid.agr + ', ATGR ' + grid.atgr + ', SOLV ' + Math.round((grid.solv || 0) * 100) + '%, ' + grid.grid_size + 'x' + grid.grid_size + ' grid\n';
    }
  }

  var claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Generate exactly 3 report highlights for a client\'s monthly campaign report. Each highlight should be a win or milestone.\n\nMetrics:\n' + metricsContext + '\n\nReturn ONLY a JSON array (no markdown, no backticks) with 3 objects, each having:\n- icon: one of "chart-up", "phone", "bot", "target", "globe", "users", "check", "map-pin"\n- headline: short punchy headline (max 8 words, no em dashes)\n- body: 1-2 sentence explanation with specific numbers. AGR = Average Grid Rank (lower is better, 1 is top position). SOLV = Share of Local Voice (higher is better, 100% means appearing in every grid cell).\n- metric_ref: the primary metric referenced (e.g. "gsc_clicks", "gbp_calls", "ai_visibility", "geogrids")\n- highlight_type: "win" or "milestone"\n\nPrioritize AI visibility data and geogrid/maps performance when available. Always include concrete numbers.' }]
    })
  });

  var claudeData = await claudeResp.json();
  var text = '';
  if (claudeData.content) {
    for (var i = 0; i < claudeData.content.length; i++) {
      if (claudeData.content[i].type === 'text') text += claudeData.content[i].text;
    }
  }

  // Parse JSON, strip any markdown fencing
  text = text.replace(/```json/g, '').replace(/```/g, '').trim();
  var parsed = JSON.parse(text);

  return parsed.map(function(h, idx) {
    return {
      client_slug: snapshot.client_slug,
      report_month: snapshot.report_month,
      sort_order: idx + 1,
      icon: h.icon,
      headline: h.headline,
      body: h.body,
      metric_ref: h.metric_ref,
      highlight_type: h.highlight_type
    };
  });
}


