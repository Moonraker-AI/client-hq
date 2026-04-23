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
var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var google = require('./_lib/google-delegated');
var sanitizer = require('./_lib/html-sanitizer');
var fetchT = require('./_lib/fetch-with-timeout');
var jsonParser = require('./_lib/json-parser');
var gbp = require('./_lib/gbp');


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;


  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var lfKey = process.env.LOCALFALCON_API_KEY;
  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

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

  // ─── STEP 1: Load report config + contact ─────────────────────
  try {
    var configs = await sb.query('report_configs?client_slug=eq.' + clientSlug + '&active=eq.true&limit=1');
    if (!configs || configs.length === 0) return res.status(404).json({ error: 'No active report_config for ' + clientSlug });
    var config = configs[0];

    var contacts = await sb.query('contacts?slug=eq.' + clientSlug + '&select=id,slug,first_name,last_name,practice_name,email,campaign_start,status,campaign_type');
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found for ' + clientSlug });
    var contact = contacts[0];
  } catch (e) {
    monitor.logError('compile-report', e, { client_slug: clientSlug, detail: { stage: 'load_config_contact' } });
    return res.status(500).json({ error: 'Failed to load config/contact' });
  }

  var range = monthRange(reportMonth);
  var practiceName = sanitizer.sanitizeText(
    contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim(),
    200
  );

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
    var kwRows = await sb.query('tracked_keywords?client_slug=eq.' + clientSlug + '&active=eq.true&order=priority.asc,keyword.asc');
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
    return await sb.one('report_snapshots?client_slug=eq.' + clientSlug + '&report_month=eq.' + pm + '&limit=1');
  });

  // ─── STEPS 3-5: Pull all data sources IN PARALLEL ─────────────

  // --- 3. GSC (with self-healing property resolution) ---
  var gscFn = safe('gsc', async function() {
    if (!googleSA || !config.gsc_property) {
      warnings.push('GSC: skipped (no credentials or property configured)');
      return null;
    }
    var token;
    try {
      token = await google.getDelegatedAccessToken('support@moonraker.ai', 'https://www.googleapis.com/auth/webmasters.readonly');
    } catch (tokenErr) {
      warnings.push('GSC: token failed - ' + (tokenErr.message || String(tokenErr)));
      return null;
    }

    var gscHeaders = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    function buildGscQueries(property) {
      var base = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(property) + '/searchAnalytics/query';
      return Promise.all([
        fetchT(base, { method: 'POST', headers: gscHeaders, body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: [], rowLimit: 1 }) }, 15000),
        fetchT(base, { method: 'POST', headers: gscHeaders, body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: ['page'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }) }, 15000),
        fetchT(base, { method: 'POST', headers: gscHeaders, body: JSON.stringify({ startDate: range.start, endDate: range.end, dimensions: ['query'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] }) }, 15000)
      ]);
    }

    var results = await buildGscQueries(config.gsc_property);

    // Self-healing: on 403/404, resolve the correct property and retry.
    //
    // M24 (2026-04-18): cool-off check — retry BEFORE PATCHing report_configs.
    // The previous shape PATCHed the candidate property into the DB and only
    // then retried; if both the old and new properties returned 403 (e.g.
    // Google rate-limit or transient token issue rather than a real
    // property mismatch), the DB ended up with an arbitrary alternative
    // property overwriting the original. Now we retry first and only PATCH
    // when the retry succeeds, leaving report_configs untouched on
    // transient errors. Corrections that do land are also written to
    // activity_log so admins can audit and revert.
    if (!results[0].ok && (results[0].status === 403 || results[0].status === 404)) {
      var oldProp = config.gsc_property;
      var corrected = await resolveGscProperty(token, config.gsc_property);
      if (corrected && corrected !== config.gsc_property) {
        var retryResults = await buildGscQueries(corrected);
        if (retryResults[0].ok) {
          // Retry succeeded -- the correction is genuine. PATCH + log.
          await sb.mutate('report_configs?client_slug=eq.' + clientSlug, 'PATCH', {
            gsc_property: corrected,
            updated_at: new Date().toISOString()
          });
          try {
            await sb.mutate('activity_log', 'POST', {
              client_slug: clientSlug,
              table_name: 'report_configs',
              record_id: clientSlug,
              field_name: 'gsc_property',
              old_value: oldProp,
              new_value: corrected,
              changed_by: 'compile-report:auto-heal'
            }, 'return=minimal');
          } catch (alErr) {
            // activity_log write is observability-only; don't surface as
            // a report error if it fails.
            console.error('compile-report: activity_log write failed:', alErr.message);
          }
          config.gsc_property = corrected;
          warnings.push('GSC: auto-corrected property from ' + oldProp + ' to ' + corrected);
          results = retryResults;
        } else {
          // Both old and new properties errored -- likely a transient
          // Google-side issue, not a real property mismatch. Leave
          // report_configs unchanged and fall through to the final-error
          // branch below with the ORIGINAL error surfaced.
          warnings.push('GSC: candidate property ' + corrected + ' also failed (' + retryResults[0].status + '); leaving ' + oldProp + ' unchanged');
        }
      }
    }

    // Final error check after potential self-heal
    if (!results[0].ok) {
      var errBody = await results[0].text().catch(function() { return ''; });
      var errMsg = 'GSC API ' + results[0].status;
      if (results[0].status === 403) errMsg += ' - no accessible property found for ' + config.gsc_property;
      else if (results[0].status === 404) errMsg += ' - property ' + config.gsc_property + ' not found in GSC';
      if (errBody) errMsg += ' (' + errBody.substring(0, 200) + ')';
      warnings.push(errMsg);
      return null;
    }

    var data = await Promise.all(results.map(function(r) { return r.json(); }));

    var totals = (data[0].rows && data[0].rows[0]) || {};
    return {
      clicks: Math.round(totals.clicks || 0),
      impressions: Math.round(totals.impressions || 0),
      ctr: Math.round((totals.ctr || 0) * 10000) / 100,
      position: Math.round((totals.position || 0) * 10) / 10,
      pages: (data[1].rows || []).slice(0, 5).map(function(r) {
        return { page: r.keys[0].replace(/https?:\/\/[^/]+/, ''), clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 10000) / 100, position: Math.round(r.position * 10) / 10 };
      }),
      queries: (data[2].rows || []).slice(0, 5).map(function(r) {
        return { query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: Math.round(r.ctr * 10000) / 100, position: Math.round(r.position * 10) / 10 };
      })
    };
  });

  // --- 3b. GBP Performance API (calls, clicks, directions, impressions) ---
  // Quota confirmed open April 2026 (case 8-326800040416). Parser previously
  // had a flat-vs-nested shape bug that silently returned zeros; helper now
  // handles both shapes defensively.
  var gbpPerfFn = safe('gbp_performance', async function() {
    if (!googleSA || !config.gbp_location_id) {
      warnings.push('GBP Performance: skipped (no service account or gbp_location_id configured)');
      return null;
    }
    var result = await gbp.fetchPerformance(config.gbp_location_id, range.start, range.end);
    if (!result.available) {
      warnings.push('GBP Performance: ' + (result.error || 'unavailable'));
      return null;
    }
    return {
      calls:              result.calls,
      website_clicks:     result.website_clicks,
      direction_requests: result.direction_requests,
      impressions_total:  result.impressions_total,
      impressions_breakdown: result.impressions_breakdown
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
    var tasks = await sb.query('checklist_items?client_slug=eq.' + clientSlug + '&select=status');
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

  // Fetch CORE scores from entity_audits (fallback when prevSnap has none)
  var auditScores = await safe('entity_audits', async function() {
    return await sb.one('entity_audits?client_slug=eq.' + clientSlug + '&order=audit_date.desc&limit=1&select=score_credibility,score_optimization,score_reputation,score_engagement,variance_score,cres_score');
  });

  // Build citation_trend from historical snapshots
  if (aiData) {
    try {
      var histRows = await sb.query('report_snapshots?client_slug=eq.' + clientSlug + '&select=report_month,ai_visibility&order=report_month.asc&limit=12');
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

    // CORE scores (carry forward from prevSnap, fallback to entity_audits)
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
    var existing = await sb.query('report_snapshots?client_slug=eq.' + clientSlug + '&report_month=eq.' + reportMonth + '&limit=1');

    if (existing && existing.length > 0) {
      snapshotId = existing[0].id;
      snapshot.updated_at = new Date().toISOString();
      await sb.mutate('report_snapshots?id=eq.' + snapshotId, 'PATCH', snapshot);
    } else {
      var inserted = await sb.mutate('report_snapshots', 'POST', snapshot);
      snapshotId = Array.isArray(inserted) ? inserted[0].id : inserted.id;
    }
  } catch (e) {
    monitor.logError('compile-report', e, { client_slug: clientSlug, detail: { stage: 'write_snapshot', report_month: reportMonth } });
    return res.status(500).json({ error: 'Failed to write snapshot', errors: errors });
  }

  // ─── STEP 10: Generate highlights via Claude ──────────────────
  var highlights = [];
  if (anthropicKey) {
    try {
      highlights = await generateHighlights(snapshot, prevSnap, practiceName, anthropicKey);
      if (highlights.length > 0) {
        // H27: upsert on UNIQUE(client_slug, report_month, sort_order).
        // Replaces the non-transactional DELETE+POST pair that could leave
        // zero highlights if the invocation died between the two writes.
        try {
          await sb.mutate('report_highlights', 'POST', highlights, 'resolution=merge-duplicates,return=minimal');
        } catch (e) { warnings.push('Highlights upsert: ' + e.message); }
      }
    } catch (e) {
      warnings.push('Highlight generation: ' + e.message);
      // Fallback: generate basic highlights from data
      highlights = buildFallbackHighlights(snapshot, practiceName);
      if (highlights.length > 0) {
        try { await sb.mutate('report_highlights', 'POST', highlights, 'resolution=merge-duplicates,return=minimal'); } catch (_e) {}
      }
    }
  }

  // ─── STEP 11: Flip status to internal_review ──────────────────
  try {
    await sb.mutate('report_snapshots?id=eq.' + snapshotId, 'PATCH', { report_status: 'internal_review', updated_at: new Date().toISOString() });
  } catch (e) { warnings.push('Status flip: ' + e.message); }

  // ─── STEP 12: Update report_configs compile timestamp ─────────
  try {
    await sb.mutate('report_configs?id=eq.' + config.id, 'PATCH', {
      last_compiled_at: new Date().toISOString(),
      last_compiled_status: errors.length > 0 ? 'partial' : 'success',
      last_compiled_errors: errors.concat(warnings.length > 0 ? warnings.map(function(w) { return 'WARN: ' + w; }) : []),
      updated_at: new Date().toISOString()
    });
  } catch (e) { /* non-fatal */ }

  // ─── STEP 13: Send team notification via Resend ───────────────
  var notificationSent = false;
  if (resendKey) {
    try {
      var reviewUrl = 'https://clients.moonraker.ai/' + clientSlug + '/reports?preview=admin';
      var gscSummary = gscData ? (gscData.clicks + ' clicks, ' + gscData.impressions + ' impressions') : null;
      var aiSummary = aiData ? (aiData.engines_citing + '/' + aiData.engines_checked + ' platforms citing') : null;
      var mapsSummary = geogridData && geogridData.grid_count > 0
        ? (geogridData.grid_count + ' grids | Avg ARP ' + geogridData.avg_arp + ' | SoLV ' + geogridData.avg_solv + '%')
        : null;

      // Build data rows as HTML table
      var dataRows = '';
      function dataRow(label, value) {
        if (!value) return '';
        return '<tr>' +
          '<td style="padding:8px 0;color:#6B7599;font-family:Inter,sans-serif;font-size:14px;border-bottom:1px solid #E2E8F0">' + email.esc(label) + '</td>' +
          '<td style="padding:8px 0;text-align:right;font-weight:600;color:#1E2A5E;font-family:Inter,sans-serif;font-size:14px;border-bottom:1px solid #E2E8F0">' + email.esc(value) + '</td>' +
          '</tr>';
      }
      dataRows += dataRow('GSC', gscSummary);
      if (gbpPerfData) dataRows += dataRow('GBP Engagement', gbpPerfData.calls + ' calls, ' + gbpPerfData.website_clicks + ' web clicks, ' + gbpPerfData.direction_requests + ' directions');
      if (lfLocation) dataRows += dataRow('GBP Rating', lfLocation.rating + ' stars (' + lfLocation.reviews + ' reviews)');
      dataRows += dataRow('AI Visibility', aiSummary);
      dataRows += dataRow('Maps (LocalFalcon)', mapsSummary);

      var warningHtml = '';
      if (errors.length > 0) {
        warningHtml = email.pRaw('<span style="color:#EF4444">Warnings: ' + email.esc(errors.join('; ')) + '</span>');
      }

      var content =
        email.sectionHeading(practiceName) +
        email.pRaw('Month ' + campaignMonth + ' report is ready for review.') +
        (dataRows ? '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px">' + dataRows + '</table>' : '') +
        warningHtml +
        email.cta(reviewUrl, 'Review Report');

      var emailHtml = email.wrap({
        headerLabel: 'Team Notification',
        content: content,
        footerNote: 'This is an internal notification for the Moonraker team.'
      });

      var emailResp = await fetchT('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: email.FROM.notifications,
          to: ['chris@moonraker.ai', 'scott@moonraker.ai'],
          subject: 'Report Ready: ' + practiceName + ' - Month ' + campaignMonth,
          html: emailHtml
        })
      }, 15000);
      notificationSent = emailResp.ok;
      if (!notificationSent) {
        var resendErr = await emailResp.text();
        warnings.push('Resend failed: ' + emailResp.status + ' ' + resendErr);
      }
      if (notificationSent) {
        await sb.mutate('report_configs?id=eq.' + config.id, 'PATCH', { last_notified_at: new Date().toISOString() });
      }
    } catch (e) { warnings.push('Resend notification: ' + e.message); }
  }

  // Log warnings and errors for Vercel runtime visibility
  if (warnings.length > 0) console.log('[' + clientSlug + '] Warnings:', warnings.join('; '));
  if (errors.length > 0) console.log('[' + clientSlug + '] Errors:', errors.join('; '));

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
// Helper: Resolve correct GSC property when configured value fails
// Lists all accessible sites, matches domain, returns best property
// Preference: sc-domain > https://www. > https:// > http://
// ═══════════════════════════════════════════════════════════════════
async function resolveGscProperty(token, currentProp) {
  try {
    // Extract domain from current property (works for both sc-domain: and URL-prefix)
    var domain = currentProp
      .replace(/^sc-domain:/, '')
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .toLowerCase();

    if (!domain) return null;

    // List all sites accessible to the service account
    var sitesResp = await fetchT('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { 'Authorization': 'Bearer ' + token }
    }, 15000);
    if (!sitesResp.ok) return null;
    var sitesData = await sitesResp.json();
    var allSites = (sitesData.siteEntry || []).map(function(s) { return s.siteUrl; });

    // Find all properties matching this domain
    var matches = allSites.filter(function(siteUrl) {
      var siteDomain = siteUrl
        .replace(/^sc-domain:/, '')
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/+$/, '')
        .toLowerCase();
      return siteDomain === domain;
    });

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    // Rank by preference: sc-domain (broadest) > https://www. > https:// > http://
    matches.sort(function(a, b) {
      function rank(url) {
        if (url.startsWith('sc-domain:')) return 0;
        if (url.startsWith('https://www.')) return 1;
        if (url.startsWith('https://')) return 2;
        if (url.startsWith('http://www.')) return 3;
        return 4;
      }
      return rank(a) - rank(b);
    });

    return matches[0];
  } catch (e) {
    return null;
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

  var claudeResp = null;
  for (var _attempt = 0; _attempt <= 2; _attempt++) {
    claudeResp = await fetchT('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'Generate exactly 3 report highlights for a client\'s monthly campaign report. Each highlight should be a win or milestone.\n\nIMPORTANT CONTEXT:\n- This is Month ' + snapshot.campaign_month + ' of an ongoing SEO campaign. Do NOT describe it as a new launch, first month, or initial setup unless campaign_month is 1.\n- The practice name is "' + practiceName + '". Use the practice name in highlights, not the owner\'s personal name.\n- Focus on concrete data points and month-over-month trends when previous data is available.\n\nMetrics:\n' + metricsContext + '\n\nReturn ONLY a JSON array (no markdown, no backticks) with 3 objects, each having:\n- icon: one of "chart-up", "phone", "bot", "target", "globe", "users", "check", "map-pin"\n- headline: short punchy headline (max 8 words, no em dashes)\n- body: 1-2 sentence explanation with specific numbers. ARP = Average Rank Position (lower is better, 1 is top). ATRP = Average Top Rank Position. SoLV = Share of Local Voice (higher is better, 100% means top position everywhere in the grid).\n- metric_ref: the primary metric referenced (e.g. "gsc_clicks", "gbp_rating", "ai_visibility", "maps_geogrid")\n- highlight_type: "win" or "milestone"\n\nPrioritize AI visibility data and geogrid/maps performance when available. Always include concrete numbers.' }]
      })
    }, 60000);
    if (claudeResp.status !== 529) break;
    if (_attempt < 2) await new Promise(function(r) { setTimeout(r, Math.pow(2, _attempt) * 1000 + Math.random() * 500); });
  }

  if (!claudeResp.ok) {
    throw new Error('Claude API returned ' + claudeResp.status);
  }

  var claudeData = await claudeResp.json();
  var text = '';
  if (claudeData.content) {
    for (var i = 0; i < claudeData.content.length; i++) {
      if (claudeData.content[i].type === 'text') text += claudeData.content[i].text;
    }
  }

  // M25: use jsonParser.parseFenced which handles adversarial Claude output
  // (backticks or braces inside string values) without corrupting the parse.
  var parsed = jsonParser.parseFenced(text);

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


function buildFallbackHighlights(snapshot, practiceName) {
  var highlights = [];
  var slug = snapshot.client_slug;
  var month = snapshot.report_month;

  // Highlight 1: Campaign progress
  if (snapshot.tasks_total) {
    var pct = Math.round((snapshot.tasks_complete || 0) / snapshot.tasks_total * 100);
    highlights.push({
      client_slug: slug, report_month: month, sort_order: 1,
      icon: 'check', headline: 'Campaign Progress at ' + pct + '%',
      body: snapshot.tasks_complete + ' of ' + snapshot.tasks_total + ' campaign tasks complete, with ' + (snapshot.tasks_in_progress || 0) + ' currently in progress.',
      metric_ref: 'tasks', highlight_type: 'milestone'
    });
  }

  // Highlight 2: GSC performance
  if (snapshot.gsc_clicks !== null) {
    var body = practiceName + ' received ' + snapshot.gsc_clicks + ' clicks from ' + snapshot.gsc_impressions + ' search impressions.';
    if (snapshot.gsc_clicks_prev !== null && snapshot.gsc_clicks_prev > 0) {
      var delta = Math.round(((snapshot.gsc_clicks - snapshot.gsc_clicks_prev) / snapshot.gsc_clicks_prev) * 100);
      body += ' That is ' + (delta >= 0 ? 'up' : 'down') + ' ' + Math.abs(delta) + '% from the previous month.';
    }
    highlights.push({
      client_slug: slug, report_month: month, sort_order: 2,
      icon: 'chart-up', headline: snapshot.gsc_clicks + ' Search Clicks This Month',
      body: body, metric_ref: 'gsc_clicks', highlight_type: 'win'
    });
  }

  // Highlight 3: AI visibility or Maps or CORE scores
  var ai = snapshot.ai_visibility || {};
  var neo = snapshot.neo_data || {};
  if (ai.engines_citing > 0) {
    highlights.push({
      client_slug: slug, report_month: month, sort_order: highlights.length + 1,
      icon: 'bot', headline: 'Visible on ' + ai.engines_citing + ' AI Platforms',
      body: practiceName + ' is being recommended by ' + ai.engines_citing + ' of ' + ai.engines_checked + ' AI search platforms monitored.',
      metric_ref: 'ai_visibility', highlight_type: 'win'
    });
  } else if (neo.avg_arp) {
    highlights.push({
      client_slug: slug, report_month: month, sort_order: highlights.length + 1,
      icon: 'map-pin', headline: 'Maps Rank Position: ' + neo.avg_arp,
      body: 'Across ' + neo.grid_count + ' tracked keywords, ' + practiceName + ' averages position ' + neo.avg_arp + ' on local maps with a ' + neo.avg_solv + '% Share of Local Voice.',
      metric_ref: 'maps_geogrid', highlight_type: 'win'
    });
  } else if (snapshot.score_credibility !== null) {
    var avg = ((snapshot.score_credibility || 0) + (snapshot.score_optimization || 0) + (snapshot.score_reputation || 0) + (snapshot.score_engagement || 0)) / 4;
    highlights.push({
      client_slug: slug, report_month: month, sort_order: highlights.length + 1,
      icon: 'target', headline: 'CORE Score: ' + avg.toFixed(1) + '/10',
      body: 'Baseline CORE assessment: Credibility ' + (snapshot.score_credibility || 0) + ', Optimization ' + (snapshot.score_optimization || 0) + ', Reputation ' + (snapshot.score_reputation || 0) + ', Engagement ' + (snapshot.score_engagement || 0) + '.',
      metric_ref: 'core_scores', highlight_type: 'milestone'
    });
  }

  // If we only got 1-2, pad with a generic campaign milestone
  if (highlights.length > 0 && highlights.length < 3) {
    highlights.push({
      client_slug: slug, report_month: month, sort_order: highlights.length + 1,
      icon: 'globe', headline: 'Month ' + snapshot.campaign_month + ' Underway',
      body: 'Your Moonraker campaign is in its ' + ordinal(snapshot.campaign_month) + ' month. The team is actively building your practice\'s online visibility across search, maps, and AI platforms.',
      metric_ref: 'campaign', highlight_type: 'milestone'
    });
  }

  return highlights.slice(0, 3);
}

function ordinal(n) {
  var s = ['th', 'st', 'nd', 'rd'];
  var v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}




