// /api/compile-report.js
// Core reporting engine. Pulls data from multiple sources, writes a report snapshot,
// generates highlights via Claude, and sends team notification via Resend.
//
// Sources:
//   1. Google Search Console (via Google API + service account)
//   2. LocalFalcon           (geo-grid Maps + AI visibility via Data Retrieval API)
//   3. Supabase              (task progress from checklist_items)
//   4. Supabase              (previous month snapshot for deltas)
//
// Outputs:
//   - report_snapshots row (status: internal_review)
//   - report_highlights rows (auto-generated via Claude)
//   - Resend email to team for review
//   - Updates report_configs with last_compiled_at
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY,
//   LOCALFALCON_API_KEY,
//   GOOGLE_SERVICE_ACCOUNT_JSON (optional - graceful skip if missing)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var lfKey = process.env.LOCALFALCON_API_KEY;
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

  function monthRange(monthStr) {
    var d = new Date(monthStr + 'T00:00:00Z');
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth();
    var lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return {
      start: monthStr,
      end: y + '-' + String(m + 1).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0')
    };
  }

  // Convert YYYY-MM-DD to MM/DD/YYYY for LocalFalcon API
  function toLfDate(isoStr) {
    var parts = isoStr.split('-');
    return parts[1] + '/' + parts[2] + '/' + parts[0];
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

    var contactResp = await fetch(sbUrl + '/rest/v1/contacts?slug=eq.' + clientSlug + '&select=id,slug,first_name,last_name,practice_name,email,campaign_start,status,campaign_type', { headers: sbHeaders() });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found for ' + clientSlug });
    var contact = contacts[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load config/contact: ' + e.message });
  }

  var range = monthRange(reportMonth);
  var practiceName = contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim();

  var campaignMonth = 1;
  if (contact.campaign_start) {
    var csDate = new Date(contact.campaign_start + 'T00:00:00Z');
    var rmDate = new Date(reportMonth + 'T00:00:00Z');
    campaignMonth = (rmDate.getUTCFullYear() - csDate.getUTCFullYear()) * 12 + (rmDate.getUTCMonth() - csDate.getUTCMonth()) + 1;
    if (campaignMonth < 1) campaignMonth = 1;
  }

  // ─── STEP 1b: Load tracked keywords ───────────────────────────
  var trackedKeywords = [];
  try {
    var kwResp = await fetch(sbUrl + '/rest/v1/tracked_keywords?client_slug=eq.' + clientSlug + '&active=eq.true&order=priority.asc,keyword.asc', { headers: sbHeaders() });
    var kwRows = await kwResp.json();
    if (Array.isArray(kwRows) && kwRows.length > 0) {
      trackedKeywords = kwRows;
    }
  } catch (e) { /* non-fatal */ }

  // Build unified keyword list (from tracked_keywords or report_configs fallback)
  var scanKeywords = [];
  if (trackedKeywords.length > 0) {
    trackedKeywords.forEach(function(kw) {
      scanKeywords.push({
        keyword: kw.keyword,
        label: kw.label || kw.keyword,
        track_geogrid: kw.track_geogrid,
        track_ai_visibility: kw.track_ai_visibility,
        grid_size: kw.geogrid_grid_size || 7,
        point_distance: kw.geogrid_point_distance || 1.0
      });
    });
  } else if (config.tracked_queries && config.tracked_queries.length > 0) {
    config.tracked_queries.forEach(function(q) {
      scanKeywords.push({
        keyword: q.query,
        label: q.label || q.query,
        track_geogrid: true,
        track_ai_visibility: true,
        grid_size: 7,
        point_distance: 1.0
      });
    });
  }

  // ─── STEP 2: Load previous month snapshot for deltas ──────────
  var prevSnap = await safe('prev_snapshot', async function() {
    var pm = prevMonth(reportMonth);
    var r = await fetch(sbUrl + '/rest/v1/report_snapshots?client_slug=eq.' + clientSlug + '&report_month=eq.' + pm + '&limit=1', { headers: sbHeaders() });
    var rows = await r.json();
    return (rows && rows.length > 0) ? rows[0] : null;
  });

  // ─── STEPS 3-5: Pull all data sources IN PARALLEL ─────────────

  // --- 3. GSC (unchanged) ---
  var gscFn = safe('gsc', async function() {
    if (!googleSA || !config.gsc_property) {
      warnings.push('GSC: skipped (no credentials or property configured)');
      return null;
    }
    var token = await getDelegatedToken(googleSA, 'support@moonraker.ai', 'https://www.googleapis.com/auth/webmasters.readonly');
    if (!token || token.error) {
      warnings.push('GSC: token failed - ' + (token ? token.error : 'unknown'));
      return null;
    }

    var gscBase = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(config.gsc_property) + '/searchAnalytics/query';
    var gscHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

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

  // --- 3b. GBP Performance API (calls, clicks, directions, impressions) ---
  // DISABLED: API quota is zero pending Google approval (case 8-326800040416).
  // Re-enable once quota is granted by removing the early return below.
  var gbpPerfFn = safe('gbp_performance', async function() {
    warnings.push('GBP Performance: disabled pending API quota approval');
    return null;
    if (!googleSA || !config.gbp_location_id) {
      warnings.push('GBP Performance: skipped (no service account or gbp_location_id configured)');
      return null;
    }
    var gbpToken = await getDelegatedToken(googleSA, 'support@moonraker.ai', 'https://www.googleapis.com/auth/business.manage');
    if (!gbpToken || gbpToken.error) {
      warnings.push('GBP Performance: delegated token failed - ' + (gbpToken ? gbpToken.error : 'unknown'));
      return null;
    }

    var startDate = new Date(range.start + 'T00:00:00Z');
    var endDate = new Date(range.end + 'T00:00:00Z');

    var gbpUrl = 'https://businessprofileperformance.googleapis.com/v1/locations/' + config.gbp_location_id
      + ':fetchMultiDailyMetricsTimeSeries'
      + '?dailyMetrics=CALL_CLICKS'
      + '&dailyMetrics=WEBSITE_CLICKS'
      + '&dailyMetrics=BUSINESS_DIRECTION_REQUESTS'
      + '&dailyMetrics=BUSINESS_IMPRESSIONS_DESKTOP_MAPS'
      + '&dailyMetrics=BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'
      + '&dailyMetrics=BUSINESS_IMPRESSIONS_MOBILE_MAPS'
      + '&dailyMetrics=BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
      + '&dailyRange.startDate.year=' + startDate.getUTCFullYear()
      + '&dailyRange.startDate.month=' + (startDate.getUTCMonth() + 1)
      + '&dailyRange.startDate.day=' + startDate.getUTCDate()
      + '&dailyRange.endDate.year=' + endDate.getUTCFullYear()
      + '&dailyRange.endDate.month=' + (endDate.getUTCMonth() + 1)
      + '&dailyRange.endDate.day=' + endDate.getUTCDate();

    var gbpResp = await fetchT(gbpUrl, {
      headers: { 'Authorization': 'Bearer ' + gbpToken }
    }, 15000);

    if (!gbpResp.ok) {
      var errText = await gbpResp.text();
      throw new Error('GBP API ' + gbpResp.status + ': ' + errText.substring(0, 300));
    }

    var gbpResult = await gbpResp.json();
    var timeSeries = gbpResult.multiDailyMetricTimeSeries || [];

    function sumMetric(metricName) {
      for (var i = 0; i < timeSeries.length; i++) {
        var ts = timeSeries[i];
        var dmt = ts.dailyMetricTimeSeries || {};
        if (dmt.dailyMetric === metricName) {
          var points = (dmt.timeSeries && dmt.timeSeries.datedValues) || [];
          var total = 0;
          for (var j = 0; j < points.length; j++) {
            total += parseInt(points[j].value || 0);
          }
          return total;
        }
      }
      return 0;
    }

    var calls = sumMetric('CALL_CLICKS');
    var websiteClicks = sumMetric('WEBSITE_CLICKS');
    var directionRequests = sumMetric('BUSINESS_DIRECTION_REQUESTS');
    var impressionsDesktopMaps = sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_MAPS');
    var impressionsDesktopSearch = sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH');
    var impressionsMobileMaps = sumMetric('BUSINESS_IMPRESSIONS_MOBILE_MAPS');
    var impressionsMobileSearch = sumMetric('BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
    var impressionsTotal = impressionsDesktopMaps + impressionsDesktopSearch + impressionsMobileMaps + impressionsMobileSearch;

    return {
      calls: calls,
      website_clicks: websiteClicks,
      direction_requests: directionRequests,
      impressions_total: impressionsTotal,
      impressions_breakdown: {
        desktop_maps: impressionsDesktopMaps,
        desktop_search: impressionsDesktopSearch,
        mobile_maps: impressionsMobileMaps,
        mobile_search: impressionsMobileSearch
      }
    };
  });

  // --- 4. LocalFalcon: Maps + AI visibility (Data Retrieval API) ---
  // Reads pre-existing scan results from campaigns scheduled to run on the 30th.
  // No on-demand scans. Fast: ~2-5s instead of 60-90s.
  var localFalconFn = safe('localfalcon', async function() {
    if (contact.campaign_type === 'national') {
      warnings.push('LocalFalcon: skipped (national campaign)');
      return null;
    }
    if (!lfKey) {
      warnings.push('LocalFalcon: skipped (no API key)');
      return null;
    }
    if (!config.localfalcon_place_id) {
      warnings.push('LocalFalcon: skipped (no localfalcon_place_id on report_config)');
      return null;
    }

    var placeId = config.localfalcon_place_id;
    var campaignKeys = config.lf_campaign_keys || {};

    // Step 1: Get location details (rating, reviews, name, address) from saved locations
    var locResp = await fetchT('https://api.localfalcon.com/v1/locations/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(placeId) + '&limit=5'
    }, 15000);
    var locData = await locResp.json();
    var location = null;
    if (locData.success && locData.data && locData.data.locations) {
      location = locData.data.locations.find(function(l) { return l.place_id === placeId; });
    }
    if (!location) {
      warnings.push('LocalFalcon: place_id ' + placeId + ' not found in saved locations');
      return null;
    }

    // Step 2: Fetch all scan reports for this place_id within the reporting month
    // The campaigns run on the 30th, so reports will be dated within the report month
    var lfStartDate = toLfDate(range.start);
    var lfEndDate = toLfDate(range.end);

    var allReports = [];
    var nextToken = null;
    var fetchCount = 0;
    var MAX_PAGES = 5;

    do {
      var listBody = 'api_key=' + lfKey
        + '&place_id=' + encodeURIComponent(placeId)
        + '&start_date=' + encodeURIComponent(lfStartDate)
        + '&end_date=' + encodeURIComponent(lfEndDate)
        + '&limit=100';
      if (nextToken) listBody += '&next_token=' + encodeURIComponent(nextToken);

      var listResp = await fetchT('https://api.localfalcon.com/v1/reports/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: listBody
      }, 15000);
      var listData = await listResp.json();

      if (!listData.success) {
        warnings.push('LocalFalcon: report listing failed - ' + (listData.message || 'code ' + listData.code));
        break;
      }

      var reports = (listData.data && listData.data.reports) || [];
      allReports = allReports.concat(reports);
      nextToken = (listData.data && listData.data.next_token) || null;
      fetchCount++;
    } while (nextToken && fetchCount < MAX_PAGES);

    if (allReports.length === 0) {
      warnings.push('LocalFalcon: no scan reports found for ' + placeId + ' between ' + lfStartDate + ' and ' + lfEndDate + '. Campaigns may not have run yet.');
      // Still return location data even without scan results
      return {
        location: {
          rating: parseFloat(location.rating) || 0,
          reviews: parseInt(location.reviews) || 0,
          name: location.name,
          address: location.address,
          phone: location.phone || null
        },
        maps: { platforms: {}, grids: [], grid_count: 0, avg_arp: 0, avg_solv: 0 },
        ai: { engines: [], engines_checked: 0, engines_citing: 0, citation_trend: [] },
        scans_run: 0,
        scans_requested: 0
      };
    }

    // Step 3: Organize reports by platform
    var MAPS_PLATFORMS = ['google', 'apple'];
    var AI_PLATFORMS = ['chatgpt', 'gemini', 'gaio', 'aimode'];

    var mapsResults = {};
    var aiResults = {};
    MAPS_PLATFORMS.forEach(function(p) { mapsResults[p] = []; });
    AI_PLATFORMS.forEach(function(p) { aiResults[p] = []; });

    // Match each report to a keyword label from tracked_keywords
    var keywordLabelMap = {};
    scanKeywords.forEach(function(kw) {
      keywordLabelMap[kw.keyword.toLowerCase()] = kw.label;
    });

    allReports.forEach(function(r) {
      var platform = r.platform || 'google';
      var isAi = AI_PLATFORMS.indexOf(platform) !== -1;
      var keyword = r.keyword || '';
      var label = keywordLabelMap[keyword.toLowerCase()] || keyword;

      var entry = {
        keyword: keyword,
        label: label,
        arp: parseFloat(r.arp) || 0,
        atrp: parseFloat(r.atrp) || 0,
        solv: parseFloat(r.solv) || 0,
        found_in: parseInt(r.found_in) || 0,
        data_points: parseInt(r.data_points) || 0,
        grid_size: r.grid_size,
        report_key: r.report_key,
        image_url: r.image || null,
        heatmap_url: r.heatmap || null,
        public_url: r.public_url || null,
        pdf_url: r.pdf || null
      };

      if (isAi) {
        if (aiResults[platform]) aiResults[platform].push(entry);
      } else {
        if (mapsResults[platform]) mapsResults[platform].push(entry);
      }
    });

    // Step 3b: Filter map grids to only include tracked keywords
    var trackedKeywordSet = {};
    scanKeywords.forEach(function(kw) { trackedKeywordSet[kw.keyword.toLowerCase()] = true; });
    MAPS_PLATFORMS.forEach(function(p) {
      mapsResults[p] = mapsResults[p].filter(function(g) {
        return trackedKeywordSet[g.keyword.toLowerCase()];
      });
    });
    // Also filter AI results to tracked keywords
    AI_PLATFORMS.forEach(function(p) {
      aiResults[p] = aiResults[p].filter(function(g) {
        return trackedKeywordSet[g.keyword.toLowerCase()];
      });
    });

    // Step 4: Compute summaries (identical logic to before)
    var allMapGrids = [];
    Object.keys(mapsResults).forEach(function(p) {
      mapsResults[p].forEach(function(g) { allMapGrids.push(g); });
    });
    var mapsAvgArp = allMapGrids.length > 0 ? allMapGrids.reduce(function(s, g) { return s + g.arp; }, 0) / allMapGrids.length : 0;
    var mapsAvgSolv = allMapGrids.length > 0 ? allMapGrids.reduce(function(s, g) { return s + g.solv; }, 0) / allMapGrids.length : 0;

    var platformNames = {
      chatgpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok',
      gaio: 'Google AI Overviews', aimode: 'Google AI Mode'
    };

    var aiEngines = AI_PLATFORMS.map(function(platform) {
      var scans = aiResults[platform] || [];

      // Deduplicate by keyword: keep best SoLV per keyword
      var byKeyword = {};
      scans.forEach(function(s) {
        var key = s.keyword.toLowerCase();
        if (!byKeyword[key] || s.solv > byKeyword[key].solv) {
          byKeyword[key] = s;
        }
      });
      var uniqueScans = Object.values(byKeyword);

      var cited = uniqueScans.some(function(s) { return s.found_in > 0 || s.solv > 0; });
      var citedKeywords = uniqueScans.filter(function(s) { return s.found_in > 0 || s.solv > 0; }).map(function(s) { return s.label; });
      var bestSolv = uniqueScans.length > 0 ? Math.max.apply(null, uniqueScans.map(function(s) { return s.solv; })) : 0;
      var avgSolv = uniqueScans.length > 0 ? uniqueScans.reduce(function(s, g) { return s + g.solv; }, 0) / uniqueScans.length : 0;

      var context = null;
      if (cited) {
        context = 'Visible in ' + platformNames[platform] + ' for: ' + citedKeywords.join(', ') + ' (best SoLV: ' + Math.round(bestSolv * 10) / 10 + '%)';
      }

      return {
        name: platformNames[platform] || platform,
        platform: platform,
        cited: cited,
        context: context,
        queries_checked: uniqueScans.length,
        queries_cited: citedKeywords.length,
        avg_solv: Math.round(avgSolv * 100) / 100,
        best_solv: Math.round(bestSolv * 100) / 100,
        scans: uniqueScans
      };
    });

    var enginesCiting = aiEngines.filter(function(e) { return e.cited; }).length;

    var gbpBasics = {
      rating: parseFloat(location.rating) || 0,
      reviews: parseInt(location.reviews) || 0,
      name: location.name,
      address: location.address,
      phone: location.phone || null
    };

    return {
      location: gbpBasics,
      maps: {
        platforms: mapsResults,
        grids: allMapGrids,
        grid_count: allMapGrids.length,
        avg_arp: Math.round(mapsAvgArp * 100) / 100,
        avg_solv: Math.round(mapsAvgSolv * 100) / 100
      },
      ai: {
        engines: aiEngines,
        engines_checked: AI_PLATFORMS.length,
        engines_citing: enginesCiting,
        citation_trend: []
      },
      scans_run: allReports.length,
      scans_requested: allReports.length
    };
  });

  // --- 5. Tasks (unchanged) ---
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

  // Fire all data sources concurrently
  var parallel = await Promise.all([gscFn, gbpPerfFn, localFalconFn, taskFn]);
  var gscData = parallel[0];
  var gbpPerfData = parallel[1];
  var lfData = parallel[2];
  var taskData = parallel[3];

  // Extract sub-sections from LocalFalcon data
  var lfLocation = lfData ? lfData.location : null;
  var geogridData = lfData ? lfData.maps : null;
  var aiData = lfData ? lfData.ai : null;

  // Fetch CORE scores from audit_scores (fallback when prevSnap has none)
  var auditScores = await safe('audit_scores', async function() {
    var resp = await fetch(sbUrl + '/rest/v1/audit_scores?client_slug=eq.' + clientSlug + '&order=audit_date.desc&limit=1&select=score_credibility,score_optimization,score_reputation,score_engagement', { headers: sbHeaders() });
    var rows = await resp.json();
    return (Array.isArray(rows) && rows.length > 0) ? rows[0] : null;
  });

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
    campaign_type: contact.campaign_type || 'local',
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

    // GBP - performance metrics from Business Profile Performance API
    gbp_calls: gbpPerfData ? gbpPerfData.calls : null,
    gbp_direction_requests: gbpPerfData ? gbpPerfData.direction_requests : null,
    gbp_website_clicks: gbpPerfData ? gbpPerfData.website_clicks : null,
    gbp_photo_views: null,
    gbp_calls_prev: prevSnap ? prevSnap.gbp_calls : null,
    gbp_direction_requests_prev: prevSnap ? prevSnap.gbp_direction_requests : null,
    gbp_website_clicks_prev: prevSnap ? prevSnap.gbp_website_clicks : null,
    gbp_photo_views_prev: prevSnap ? prevSnap.gbp_photo_views : null,

    // CORE scores (carry forward from prevSnap, fallback to audit_scores)
    score_credibility: (prevSnap && prevSnap.score_credibility != null) ? prevSnap.score_credibility : (auditScores ? auditScores.score_credibility : null),
    score_optimization: (prevSnap && prevSnap.score_optimization != null) ? prevSnap.score_optimization : (auditScores ? auditScores.score_optimization : null),
    score_reputation: (prevSnap && prevSnap.score_reputation != null) ? prevSnap.score_reputation : (auditScores ? auditScores.score_reputation : null),
    score_engagement: (prevSnap && prevSnap.score_engagement != null) ? prevSnap.score_engagement : (auditScores ? auditScores.score_engagement : null),

    // Tasks
    tasks_total: taskData ? taskData.total : 0,
    tasks_complete: taskData ? taskData.complete : 0,
    tasks_in_progress: taskData ? taskData.in_progress : 0,
    tasks_not_started: taskData ? taskData.not_started : 0,

    // Detail JSON blobs
    gsc_detail: gscData ? { date_range: range, pages: gscData.pages, queries: gscData.queries } : {},
    gbp_detail: Object.assign({},
      lfLocation ? { rating: lfLocation.rating, reviews: lfLocation.reviews, name: lfLocation.name, address: lfLocation.address, phone: lfLocation.phone } : {},
      gbpPerfData ? { impressions_total: gbpPerfData.impressions_total, impressions_breakdown: gbpPerfData.impressions_breakdown } : {}
    ),

    // AI visibility
    ai_visibility: aiData ? {
      engines: aiData.engines.map(function(e) {
        return { name: e.name, platform: e.platform, cited: e.cited, context: e.context, queries_checked: e.queries_checked, queries_cited: e.queries_cited, avg_solv: e.avg_solv, best_solv: e.best_solv };
      }),
      engines_checked: aiData.engines_checked,
      engines_citing: aiData.engines_citing,
      citation_trend: aiData.citation_trend,
      keyword_breakdown: buildAiKeywordBreakdown(aiData.engines)
    } : {},

    // Geo-grid / Maps data
    neo_data: geogridData ? {
      grids: geogridData.grids.map(function(g) {
        return {
          search_term: g.keyword,
          label: g.label,
          agr: g.arp,
          atgr: g.atrp,
          arp: g.arp,
          atrp: g.atrp,
          solv: g.solv,
          grid_size: g.grid_size,
          image_url: g.image_url,
          heatmap_url: g.heatmap_url,
          public_url: g.public_url,
          pdf_url: g.pdf_url,
          report_key: g.report_key
        };
      }),
      platforms: geogridData.platforms,
      grid_count: geogridData.grid_count,
      avg_agr: geogridData.avg_arp,
      avg_arp: geogridData.avg_arp,
      avg_solv: geogridData.avg_solv
    } : {},

    deliverables: [],
    notes: ''
  };

  // ─── STEP 9: Upsert snapshot to Supabase ──────────────────────
  var snapshotId = null;
  try {
    var existResp = await fetch(sbUrl + '/rest/v1/report_snapshots?client_slug=eq.' + clientSlug + '&report_month=eq.' + reportMonth + '&limit=1', { headers: sbHeaders() });
    var existing = await existResp.json();

    if (existing && existing.length > 0) {
      snapshotId = existing[0].id;
      snapshot.updated_at = new Date().toISOString();
      var updateResp = await fetch(sbUrl + '/rest/v1/report_snapshots?id=eq.' + snapshotId, {
        method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(snapshot)
      });
      if (!updateResp.ok) throw new Error('PATCH failed: ' + (await updateResp.text()));
    } else {
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
      var reviewUrl = 'https://clients.moonraker.ai/' + clientSlug + '/reports';
      var gscSummary = gscData ? (gscData.clicks + ' clicks, ' + gscData.impressions + ' impressions') : null;
      var aiSummary = aiData ? (aiData.engines_citing + '/' + aiData.engines_checked + ' platforms citing') : null;
      var mapsSummary = geogridData && geogridData.grid_count > 0
        ? (geogridData.grid_count + ' grids | Avg ARP ' + geogridData.avg_arp + ' | SoLV ' + geogridData.avg_solv + '%')
        : null;

      var emailBody = '<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">'
        + '<div style="text-align:center"><img src="https://clients.moonraker.ai/assets/logo.png" height="32" alt="Moonraker" style="margin-bottom:16px"/></div>'
        + '<div style="background:#F8FAFC;border-radius:10px;padding:24px">'
        + '<h2 style="margin:0 0 4px;color:#1E2A5E;font-size:18px">' + practiceName + '</h2>'
        + '<p style="margin:0 0 16px;color:#6B7599;font-size:14px">Month ' + campaignMonth + ' report ready for review</p>'
        + '<table style="width:100%;font-size:14px;border-collapse:collapse">'
        + (gscSummary ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">GSC</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + gscSummary + '</td></tr>' : '')
        + (gbpPerfData ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">GBP Engagement</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + gbpPerfData.calls + ' calls, ' + gbpPerfData.website_clicks + ' web clicks, ' + gbpPerfData.direction_requests + ' directions</td></tr>' : '')
        + (lfLocation ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">GBP Rating</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + lfLocation.rating + ' stars (' + lfLocation.reviews + ' reviews)</td></tr>' : '')
        + (aiSummary ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">AI Visibility</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + aiSummary + '</td></tr>' : '')
        + (mapsSummary ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">Maps (LocalFalcon)</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + mapsSummary + '</td></tr>' : '')
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
      gbp_performance: gbpPerfData ? { calls: gbpPerfData.calls, website_clicks: gbpPerfData.website_clicks, direction_requests: gbpPerfData.direction_requests, impressions: gbpPerfData.impressions_total } : 'skipped',
      gbp_location: lfLocation ? { rating: lfLocation.rating, reviews: lfLocation.reviews } : 'skipped',
      ai_visibility: aiData ? {
        engines_citing: aiData.engines_citing,
        engines_checked: aiData.engines_checked,
        platforms: aiData.engines.map(function(e) { return { name: e.name, cited: e.cited, avg_solv: e.avg_solv }; })
      } : 'skipped',
      maps: geogridData ? {
        grid_count: geogridData.grid_count,
        avg_arp: geogridData.avg_arp,
        avg_solv: geogridData.avg_solv,
        platforms: Object.keys(geogridData.platforms).map(function(p) { return { platform: p, keywords: geogridData.platforms[p].length }; })
      } : 'skipped',
      tasks: taskData ? 'ok' : 'skipped'
    },
    localfalcon_stats: lfData ? { scans_read: lfData.scans_run, reports_found: lfData.scans_requested } : null,
    highlights_count: highlights.length,
    notification_sent: notificationSent,
    errors: errors,
    warnings: warnings
  });
};


// ═══════════════════════════════════════════════════════════════════
// Helper: Build per-keyword AI breakdown from engine results
// Pivots from per-engine -> per-keyword for the report template
// ═══════════════════════════════════════════════════════════════════
function buildAiKeywordBreakdown(engines) {
  var keywordMap = {};
  engines.forEach(function(engine) {
    (engine.scans || []).forEach(function(scan) {
      if (!keywordMap[scan.keyword]) {
        keywordMap[scan.keyword] = { keyword: scan.keyword, label: scan.label, platforms: {} };
      }
      keywordMap[scan.keyword].platforms[engine.platform] = {
        cited: scan.found_in > 0 || scan.solv > 0,
        solv: scan.solv,
        arp: scan.arp,
        found_in: scan.found_in,
        data_points: scan.data_points
      };
    });
  });
  return Object.values(keywordMap);
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Google Service Account JWT -> Access Token
// ═══════════════════════════════════════════════════════════════════
async function getGoogleAccessToken(saJson, scope) {
  scope = scope || 'https://www.googleapis.com/auth/webmasters.readonly';
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
      scope: scope,
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
    return { error: e.message || String(e) };
  }
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Get access token via domain-wide delegation
// ═══════════════════════════════════════════════════════════════════
async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) {
      throw new Error('SA JSON missing private_key or client_email');
    }
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: impersonateEmail,
      scope: scope,
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
      throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    }
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
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

  var gbpD = snapshot.gbp_detail || {};
  if (gbpD.rating) {
    metricsContext += 'GBP: ' + gbpD.rating + ' rating (' + gbpD.reviews + ' reviews)';
  }
  if (snapshot.gbp_calls !== null) {
    metricsContext += (gbpD.rating ? ', ' : 'GBP: ') + snapshot.gbp_calls + ' calls, ' + snapshot.gbp_website_clicks + ' website clicks, ' + snapshot.gbp_direction_requests + ' direction requests';
    if (snapshot.gbp_calls_prev !== null) metricsContext += ' (prev: ' + snapshot.gbp_calls_prev + ' calls)';
    if (gbpD.impressions_total) metricsContext += ', ' + gbpD.impressions_total + ' total impressions';
  }
  if (gbpD.rating || snapshot.gbp_calls !== null) metricsContext += '\n';

  var ai = snapshot.ai_visibility || {};
  if (ai.engines_checked) {
    metricsContext += '\nAI Visibility: ' + ai.engines_citing + ' of ' + ai.engines_checked + ' AI platforms citing\n';
    var engines = ai.engines || [];
    for (var i = 0; i < engines.length; i++) {
      metricsContext += '  ' + engines[i].name + ': ' + (engines[i].cited ? 'VISIBLE' : 'not visible');
      if (engines[i].avg_solv) metricsContext += ' (avg SoLV: ' + engines[i].avg_solv + '%)';
      if (engines[i].context) metricsContext += ' - ' + engines[i].context;
      metricsContext += '\n';
    }
    var kwBreakdown = ai.keyword_breakdown || [];
    if (kwBreakdown.length > 0) {
      metricsContext += '\nPer-keyword AI coverage:\n';
      kwBreakdown.forEach(function(kw) {
        var platforms = Object.keys(kw.platforms || {});
        var citedIn = platforms.filter(function(p) { return kw.platforms[p].cited; });
        metricsContext += '  "' + kw.label + '": cited in ' + citedIn.length + '/' + platforms.length + ' platforms';
        if (citedIn.length > 0) metricsContext += ' (' + citedIn.join(', ') + ')';
        metricsContext += '\n';
      });
    }
  }

  metricsContext += '\nTasks: ' + snapshot.tasks_complete + '/' + snapshot.tasks_total + ' complete, ' + snapshot.tasks_in_progress + ' in progress\n';

  var neo = snapshot.neo_data || {};
  if (neo.grids && neo.grids.length > 0) {
    metricsContext += '\nMaps/Geogrid Performance (Google + Apple Maps, ' + neo.grid_count + ' grids, avg ARP ' + neo.avg_arp + ', avg SoLV ' + neo.avg_solv + '%):\n';
    for (var gi = 0; gi < neo.grids.length; gi++) {
      var grid = neo.grids[gi];
      metricsContext += '  "' + grid.search_term + '": ARP ' + grid.arp + ', ATRP ' + grid.atrp + ', SoLV ' + Math.round((grid.solv || 0) * 100) / 100 + '%, ' + grid.grid_size + 'x' + grid.grid_size + ' grid\n';
    }
  }

  var claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Generate exactly 3 report highlights for a client\'s monthly campaign report. Each highlight should be a win or milestone.\n\nMetrics:\n' + metricsContext + '\n\nReturn ONLY a JSON array (no markdown, no backticks) with 3 objects, each having:\n- icon: one of "chart-up", "phone", "bot", "target", "globe", "users", "check", "map-pin"\n- headline: short punchy headline (max 8 words, no em dashes)\n- body: 1-2 sentence explanation with specific numbers. ARP = Average Rank Position (lower is better, 1 is top). ATRP = Average Top Rank Position. SoLV = Share of Local Voice (higher is better, 100% means top position everywhere in the grid).\n- metric_ref: the primary metric referenced (e.g. "gsc_clicks", "gbp_rating", "ai_visibility", "maps_geogrid")\n- highlight_type: "win" or "milestone"\n\nPrioritize AI visibility data and geogrid/maps performance when available. Always include concrete numbers.' }]
    })
  });

  var claudeData = await claudeResp.json();
  var text = '';
  if (claudeData.content) {
    for (var i = 0; i < claudeData.content.length; i++) {
      if (claudeData.content[i].type === 'text') text += claudeData.content[i].text;
    }
  }

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



