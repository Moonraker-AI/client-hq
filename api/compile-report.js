// /api/compile-report.js
// Core reporting engine. Pulls data from multiple sources, writes a report snapshot,
// generates highlights via Claude, and sends team notification via Resend.
//
// Sources:
//   1. Google Search Console  (via Google API + service account)
//   2. LocalFalcon            (geogrids on Google Maps + AI visibility across 5 AI platforms)
//   3. Supabase               (task progress from checklist_items)
//   4. Supabase               (previous month snapshot for deltas)
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
  var trackedKeywords = [];
  try {
    var kwResp = await fetch(sbUrl + '/rest/v1/tracked_keywords?client_slug=eq.' + clientSlug + '&active=eq.true&order=priority.asc,keyword.asc', { headers: sbHeaders() });
    var kwRows = await kwResp.json();
    if (Array.isArray(kwRows) && kwRows.length > 0) {
      trackedKeywords = kwRows;
    }
  } catch (e) { /* non-fatal */ }

  // Build unified query list (from tracked_keywords or report_configs fallback)
  var scanKeywords = [];
  if (trackedKeywords.length > 0) {
    trackedKeywords.forEach(function(kw) {
      if (kw.track_geogrid || kw.track_ai_visibility) {
        scanKeywords.push({
          keyword: kw.keyword,
          label: kw.label || kw.keyword,
          track_geogrid: kw.track_geogrid,
          track_ai_visibility: kw.track_ai_visibility,
          grid_size: kw.geogrid_grid_size || 7
        });
      }
    });
  } else if (config.tracked_queries && config.tracked_queries.length > 0) {
    config.tracked_queries.forEach(function(q) {
      scanKeywords.push({
        keyword: q.query,
        label: q.label || q.query,
        track_geogrid: true,
        track_ai_visibility: true,
        grid_size: 7
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

  // ─── STEPS 3-6: Pull all data sources IN PARALLEL ──────────────

  // ── GSC (unchanged) ────────────────────────────────────────────
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

  // ── LocalFalcon: Geogrids + AI Visibility (replaces LBM + DataForSEO) ──
  var localFalconFn = safe('localfalcon', async function() {
    if (!lfKey) {
      warnings.push('LocalFalcon: skipped (no API key)');
      return null;
    }

    var placeId = config.localfalcon_place_id;
    if (!placeId) {
      warnings.push('LocalFalcon: skipped (no localfalcon_place_id configured in report_configs)');
      return null;
    }

    if (scanKeywords.length === 0) {
      warnings.push('LocalFalcon: no tracked keywords configured');
      return null;
    }

    // Step 1: Look up saved location for coordinates + GBP snapshot
    var locResp = await fetchT('https://api.localfalcon.com/v1/locations/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(placeId) + '&limit=5'
    }, 15000);
    var locData = await locResp.json();
    var locations = (locData.data && locData.data.locations) || [];
    var location = locations.find(function(l) { return l.place_id === placeId; });

    if (!location) {
      warnings.push('LocalFalcon: place_id ' + placeId + ' not found in saved locations');
      return null;
    }

    var lat = location.lat;
    var lng = location.lng;

    // GBP snapshot from location data (rating + reviews - engagement metrics not available from LF)
    var gbpSnapshot = {
      rating: parseFloat(location.rating) || 0,
      reviews: parseInt(location.reviews) || 0,
      name: location.name,
      address: location.address,
      phone: location.phone || null,
      categories: location.categories || {},
      note: 'GBP engagement metrics (calls, directions, website clicks) require a separate GBP Performance API integration'
    };

    // Step 2: Build scan tasks
    // Google Maps: 7x7 grid, 5mi radius (49 data points per scan)
    // AI platforms: 3x3 grid, 5mi radius (9 data points per scan - AI answers less geographically granular)
    var GEO_PLATFORMS = ['google'];
    var AI_PLATFORMS = ['chatgpt', 'gemini', 'grok', 'gaio', 'aimode'];
    var GEO_GRID_SIZE = '7';
    var AI_GRID_SIZE = '3';
    var SCAN_RADIUS = '5';

    var scanTasks = [];
    scanKeywords.forEach(function(kw) {
      if (kw.track_geogrid) {
        GEO_PLATFORMS.forEach(function(platform) {
          scanTasks.push({
            keyword: kw.keyword,
            label: kw.label,
            platform: platform,
            type: 'geo',
            grid_size: String(kw.grid_size || GEO_GRID_SIZE)
          });
        });
      }
      if (kw.track_ai_visibility) {
        AI_PLATFORMS.forEach(function(platform) {
          scanTasks.push({
            keyword: kw.keyword,
            label: kw.label,
            platform: platform,
            type: 'ai',
            grid_size: AI_GRID_SIZE
          });
        });
      }
    });

    // Step 3: Fire all scans with eager=true (returns within 20s with report_key)
    var SCAN_TIMEOUT = 25000;
    var scanPromises = scanTasks.map(function(task) {
      return fetchT('https://api.localfalcon.com/v2/run-scan/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'api_key=' + lfKey
          + '&place_id=' + encodeURIComponent(placeId)
          + '&keyword=' + encodeURIComponent(task.keyword)
          + '&lat=' + lat
          + '&lng=' + lng
          + '&grid_size=' + task.grid_size
          + '&radius=' + SCAN_RADIUS
          + '&measurement=mi'
          + '&platform=' + task.platform
          + '&eager=true'
      }, SCAN_TIMEOUT).then(function(r) { return r.json(); }).then(function(data) {
        return { task: task, data: data };
      });
    });

    var scanResults = await Promise.allSettled(scanPromises);

    // Step 4: Collect report_keys that need polling (202 = still processing)
    var completed = [];
    var pendingPolls = [];

    scanResults.forEach(function(result, idx) {
      if (result.status === 'rejected') {
        warnings.push('LocalFalcon scan failed (' + scanTasks[idx].platform + '/"' + scanTasks[idx].keyword + '"): ' + (result.reason ? result.reason.message : 'unknown'));
        return;
      }
      var r = result.value;
      if (r.data.success && r.data.data && r.data.data.report_key) {
        // Completed immediately
        completed.push({ task: r.task, report: r.data.data });
      } else if (r.data.code === 202 && r.data.data && r.data.data.report_key) {
        // Still processing, need to poll
        pendingPolls.push({ task: r.task, report_key: r.data.data.report_key });
      } else if (r.data.success === false) {
        warnings.push('LocalFalcon scan error (' + r.task.platform + '/"' + r.task.keyword + '"): ' + (r.data.message || JSON.stringify(r.data).substring(0, 200)));
      }
    });

    // Step 5: Poll pending scans (batch poll every 5s, max 90s total)
    if (pendingPolls.length > 0) {
      var POLL_INTERVAL = 5000;
      var MAX_POLL_TIME = 90000;
      var waited = 0;
      var remaining = pendingPolls.slice();

      while (remaining.length > 0 && waited < MAX_POLL_TIME) {
        await new Promise(function(resolve) { setTimeout(resolve, POLL_INTERVAL); });
        waited += POLL_INTERVAL;

        var pollBatch = remaining.slice();
        remaining = [];

        var pollResults = await Promise.allSettled(pollBatch.map(function(item) {
          return fetchT('https://api.localfalcon.com/v1/reports/' + item.report_key + '/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&report_key=' + item.report_key
          }, 15000).then(function(r) { return r.json(); }).then(function(data) {
            return { task: item.task, report_key: item.report_key, data: data };
          });
        }));

        pollResults.forEach(function(pr) {
          if (pr.status === 'rejected') {
            warnings.push('LocalFalcon poll failed: ' + (pr.reason ? pr.reason.message : 'unknown'));
            return;
          }
          var r = pr.value;
          if (r.data.code === 202) {
            // Still processing, keep polling
            remaining.push({ task: r.task, report_key: r.report_key });
          } else if (r.data.success && r.data.data) {
            completed.push({ task: r.task, report: r.data.data });
          } else {
            warnings.push('LocalFalcon poll error (' + r.task.platform + '/"' + r.task.keyword + '"): ' + (r.data.message || 'unknown'));
          }
        });
      }

      if (remaining.length > 0) {
        remaining.forEach(function(item) {
          warnings.push('LocalFalcon scan timeout (' + item.task.platform + '/"' + item.task.keyword + '"): still processing after ' + (MAX_POLL_TIME / 1000) + 's');
        });
      }
    }

    // Step 6: Split results into geo grids and AI scans
    var geoGrids = [];
    var aiScans = [];

    completed.forEach(function(item) {
      var report = item.report;
      var entry = {
        keyword: item.task.keyword,
        label: item.task.label,
        platform: item.task.platform,
        report_key: report.report_key || null,
        arp: parseFloat(report.arp) || 0,
        atrp: parseFloat(report.atrp) || 0,
        solv: parseFloat(report.solv) || 0,
        grid_size: report.grid_size || item.task.grid_size,
        data_points_total: parseInt(report.points || report.data_points) || 0,
        found_in: parseInt(report.found_in) || 0,
        image_url: report.image || null,
        heatmap_url: report.heatmap || null,
        pdf_url: report.pdf || null,
        public_url: report.public_url || null
      };

      if (item.task.type === 'geo') {
        geoGrids.push(entry);
      } else {
        aiScans.push(entry);
      }
    });

    // Sort geo grids by SoLV descending (best performing first)
    geoGrids.sort(function(a, b) { return b.solv - a.solv; });

    // Compute geo grid averages
    var geoAvgArp = geoGrids.length > 0 ? geoGrids.reduce(function(s, g) { return s + g.arp; }, 0) / geoGrids.length : 0;
    var geoAvgAtrp = geoGrids.length > 0 ? geoGrids.reduce(function(s, g) { return s + g.atrp; }, 0) / geoGrids.length : 0;
    var geoAvgSolv = geoGrids.length > 0 ? geoGrids.reduce(function(s, g) { return s + g.solv; }, 0) / geoGrids.length : 0;

    // Build AI visibility summary per platform
    var aiPlatformSummary = {};
    AI_PLATFORMS.forEach(function(p) { aiPlatformSummary[p] = { platform: p, scans: 0, keywords_found: 0, keywords_checked: 0, avg_solv: 0, keywords: [] }; });

    aiScans.forEach(function(scan) {
      var ps = aiPlatformSummary[scan.platform];
      if (!ps) return;
      ps.scans++;
      ps.keywords_checked++;
      if (scan.found_in > 0) {
        ps.keywords_found++;
        ps.keywords.push(scan.label);
      }
    });

    // Compute per-platform avg SoLV
    Object.keys(aiPlatformSummary).forEach(function(p) {
      var platformScans = aiScans.filter(function(s) { return s.platform === p; });
      if (platformScans.length > 0) {
        aiPlatformSummary[p].avg_solv = Math.round(platformScans.reduce(function(s, sc) { return s + sc.solv; }, 0) / platformScans.length * 100) / 100;
      }
    });

    var aiPlatforms = Object.values(aiPlatformSummary);
    var aiPlatformsCiting = aiPlatforms.filter(function(p) { return p.keywords_found > 0; }).length;

    // Credit usage estimate
    var totalDataPoints = completed.reduce(function(s, c) { return s + (c.report ? (parseInt(c.report.points || c.report.data_points) || 0) : 0); }, 0);

    return {
      gbp: gbpSnapshot,
      geo: {
        grids: geoGrids,
        grid_count: geoGrids.length,
        avg_arp: Math.round(geoAvgArp * 100) / 100,
        avg_atrp: Math.round(geoAvgAtrp * 100) / 100,
        avg_solv: Math.round(geoAvgSolv * 100) / 100
      },
      ai: {
        platforms: aiPlatforms,
        scans: aiScans,
        platforms_checked: AI_PLATFORMS.length,
        platforms_citing: aiPlatformsCiting,
        total_keywords: scanKeywords.length,
        total_scans: scanTasks.length,
        completed_scans: completed.length
      },
      credits_used_estimate: totalDataPoints,
      scan_summary: {
        total_requested: scanTasks.length,
        total_completed: completed.length,
        total_failed: scanTasks.length - completed.length
      }
    };
  });

  // ── Tasks (unchanged) ──────────────────────────────────────────
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
  var parallel = await Promise.all([gscFn, localFalconFn, taskFn]);
  var gscData = parallel[0];
  var lfData = parallel[1];
  var taskData = parallel[2];

  // Extract sub-objects from LocalFalcon results
  var gbpData = lfData ? lfData.gbp : null;
  var geogridData = lfData ? lfData.geo : null;
  var aiData = lfData ? lfData.ai : null;

  // Build citation_trend from historical snapshots
  if (aiData) {
    try {
      var histResp = await fetch(sbUrl + '/rest/v1/report_snapshots?client_slug=eq.' + clientSlug + '&select=report_month,ai_visibility&order=report_month.asc&limit=12', { headers: sbHeaders() });
      var histRows = await histResp.json();
      aiData.citation_trend = [];
      if (Array.isArray(histRows)) {
        aiData.citation_trend = histRows.map(function(r) {
          var av = r.ai_visibility || {};
          return { month: r.report_month.substring(0, 7), count: av.platforms_citing || av.engines_citing || 0 };
        });
      }
      aiData.citation_trend.push({ month: reportMonth.substring(0, 7), count: aiData.platforms_citing });
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

    // GBP (engagement metrics not available from LocalFalcon - require GBP Performance API)
    gbp_calls: null,
    gbp_direction_requests: null,
    gbp_website_clicks: null,
    gbp_photo_views: null,
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

    // Detail JSON blobs
    gsc_detail: gscData ? { date_range: range, pages: gscData.pages, queries: gscData.queries } : {},
    gbp_detail: gbpData ? { rating: gbpData.rating, reviews: gbpData.reviews, name: gbpData.name, address: gbpData.address } : {},
    ai_visibility: aiData || {},
    neo_data: geogridData || {},
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
      highlights = await generateHighlights(snapshot, prevSnap, practiceName, anthropicKey, geogridData, aiData);
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

      // Build AI visibility summary line
      var aiSummary = '';
      if (aiData) {
        aiSummary = aiData.platforms_citing + ' of ' + aiData.platforms_checked + ' AI platforms citing';
        var citingNames = aiData.platforms.filter(function(p) { return p.keywords_found > 0; }).map(function(p) { return p.platform; });
        if (citingNames.length > 0) aiSummary += ' (' + citingNames.join(', ') + ')';
      }

      // Build geo summary line
      var geoSummary = '';
      if (geogridData && geogridData.grid_count > 0) {
        geoSummary = geogridData.grid_count + ' terms | Avg ARP ' + geogridData.avg_arp + ' | SoLV ' + geogridData.avg_solv + '%';
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
        + (geoSummary ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">Maps (Geogrids)</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + geoSummary + '</td></tr>' : '')
        + (aiSummary ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">AI Visibility</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + aiSummary + '</td></tr>' : '')
        + (gbpData ? '<tr><td style="padding:8px 0;color:#6B7599;border-bottom:1px solid #E2E8F0">GBP Rating</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;border-bottom:1px solid #E2E8F0">' + gbpData.rating + ' (' + gbpData.reviews + ' reviews)</td></tr>' : '')
        + '</table>'
        + (lfData ? '<p style="color:#6B7599;font-size:12px;margin:12px 0 0">LocalFalcon: ' + lfData.scan_summary.total_completed + '/' + lfData.scan_summary.total_requested + ' scans completed | ~' + lfData.credits_used_estimate + ' credits used</p>' : '')
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
      localfalcon: lfData ? {
        geo_grids: geogridData ? geogridData.grid_count + ' grids, avg ARP ' + geogridData.avg_arp + ', SoLV ' + geogridData.avg_solv + '%' : 'none',
        ai_platforms_citing: aiData ? aiData.platforms_citing + '/' + aiData.platforms_checked : 'none',
        scans: lfData.scan_summary,
        credits_estimate: lfData.credits_used_estimate
      } : 'skipped',
      gbp: gbpData ? { rating: gbpData.rating, reviews: gbpData.reviews, note: 'engagement metrics require GBP Performance API' } : 'skipped',
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
    return { error: e.message || String(e) };
  }
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Generate highlights via Claude
// ═══════════════════════════════════════════════════════════════════
async function generateHighlights(snapshot, prevSnap, practiceName, apiKey, geogridData, aiData) {
  var metricsContext = 'Practice: ' + practiceName + '\nCampaign Month: ' + snapshot.campaign_month + '\n\n';

  if (snapshot.gsc_clicks !== null) {
    metricsContext += 'GSC: ' + snapshot.gsc_clicks + ' clicks, ' + snapshot.gsc_impressions + ' impressions, ' + snapshot.gsc_ctr + '% CTR, pos ' + snapshot.gsc_avg_position;
    if (snapshot.gsc_clicks_prev !== null) metricsContext += ' (prev: ' + snapshot.gsc_clicks_prev + ' clicks)';
    metricsContext += '\n';
  }

  var gbpDetail = snapshot.gbp_detail || {};
  if (gbpDetail.rating) {
    metricsContext += 'GBP: ' + gbpDetail.rating + ' rating, ' + gbpDetail.reviews + ' reviews\n';
  }

  if (aiData && aiData.platforms_checked) {
    metricsContext += '\nAI Visibility (via LocalFalcon - checks if the practice is cited by each AI platform):\n';
    metricsContext += 'Summary: ' + aiData.platforms_citing + ' of ' + aiData.platforms_checked + ' AI platforms citing the practice\n';
    var platforms = aiData.platforms || [];
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      metricsContext += '  ' + p.platform + ': ' + p.keywords_found + '/' + p.keywords_checked + ' keywords found';
      if (p.avg_solv > 0) metricsContext += ', SoLV ' + p.avg_solv + '%';
      if (p.keywords.length > 0) metricsContext += ' (found for: ' + p.keywords.join(', ') + ')';
      metricsContext += '\n';
    }
  }

  metricsContext += '\nTasks: ' + snapshot.tasks_complete + '/' + snapshot.tasks_total + ' complete, ' + snapshot.tasks_in_progress + ' in progress\n';

  if (geogridData && geogridData.grids && geogridData.grids.length > 0) {
    metricsContext += '\nGoogle Maps Geogrid Performance (' + geogridData.grid_count + ' terms, avg ARP ' + geogridData.avg_arp + ', avg SoLV ' + geogridData.avg_solv + '%):\n';
    for (var gi = 0; gi < geogridData.grids.length; gi++) {
      var grid = geogridData.grids[gi];
      metricsContext += '  "' + grid.keyword + '": ARP ' + grid.arp + ', ATRP ' + grid.atrp + ', SoLV ' + grid.solv + '%, found in ' + grid.found_in + '/' + grid.data_points_total + ' grid cells\n';
    }
  }

  var claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Generate exactly 3 report highlights for a client\'s monthly campaign report. Each highlight should be a win or milestone.\n\nMetrics:\n' + metricsContext + '\n\nReturn ONLY a JSON array (no markdown, no backticks) with 3 objects, each having:\n- icon: one of "chart-up", "phone", "bot", "target", "globe", "users", "check", "map-pin"\n- headline: short punchy headline (max 8 words, no em dashes)\n- body: 1-2 sentence explanation with specific numbers. ARP = Average Rank Position (lower is better, 1 is top). ATRP = Avg Top Rank Position. SoLV = Share of Local Voice (higher is better, 100% = appearing everywhere in the grid). For AI platforms, "found in X/Y grid cells" means the practice was cited at that many geographic check points.\n- metric_ref: the primary metric referenced (e.g. "gsc_clicks", "ai_visibility", "geogrids", "gbp_rating")\n- highlight_type: "win" or "milestone"\n\nPrioritize AI visibility and geogrid performance when available. Always include concrete numbers.' }]
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
