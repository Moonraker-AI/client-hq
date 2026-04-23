// api/campaign-summary.js
// Aggregate campaign performance data for a single client over their
// engagement window. Pulls from:
//   - Gmail (calls@moonraker.ai) via DWD: GReminders booking notifications
//   - Google Search Console: clicks, impressions, position, top queries/pages
//   - LocalFalcon: latest geogrid scans (when configured)
//
// Each data source returns { available: bool, data?: ..., error?: string }
// so the template can hide sections gracefully when a source is unavailable.
//
// Query params:
//   ?client=<slug>            — required, contacts.slug
//   ?refresh=1                — bypass any cached result (no cache yet)
//
// Response shape:
//   {
//     client:    { slug, name, practice, location, campaign_start, ... },
//     window:    { start, end, days, months },
//     bookings:  { available, total_booked, total_canceled, net, by_month, top_subjects, error },
//     gsc:       { available, totals, by_month, top_queries, top_pages, error },
//     localfalcon: { available, error },
//     generated_at: ISO timestamp,
//     duration_ms
//   }

var auth = require('./_lib/auth');
var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var google = require('./_lib/google-delegated');
var contract = require('./_lib/contract');
var gbp = require('./_lib/gbp');
var pageToken = require('./_lib/page-token');

// ── Helpers ────────────────────────────────────────────────────────

function ymKey(d) {
  return d.toISOString().slice(0, 7);            // "2025-10"
}

// ── Date helpers used in window calculation ──────────────────────────
//
// addMonthsISO adds N months to a YYYY-MM-DD string and returns YYYY-MM-DD.
// Handles month rollover correctly (e.g. Mar 31 + 1 month = Apr 30).

function addMonthsISO(iso, months) {
  var d = new Date(iso + 'T00:00:00Z');
  var targetMonth = d.getUTCMonth() + months;
  var targetYear = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  var normalizedMonth = ((targetMonth % 12) + 12) % 12;
  var endOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  var day = Math.min(d.getUTCDate(), endOfTargetMonth);
  var out = new Date(Date.UTC(targetYear, normalizedMonth, day));
  return out.toISOString().slice(0, 10);
}

// startOfMonthISO and endOfMonthISO snap a date to its calendar-month
// boundaries. Used to extend the chart's display window so we don't show
// stunted partial-month bars at engagement boundaries — the contract
// window stays the source of truth for cost and guarantee math.

function startOfMonthISO(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function endOfMonthISO(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

// monthsBetween returns the rounded number of whole months between two
// YYYY-MM-DD dates. Used for display-month count and cost calc so a
// Mar 12 - Mar 12 contract reads as 12 months instead of 13.

function monthsBetween(startISO, endISO) {
  var s = new Date(startISO + 'T00:00:00Z');
  var e = new Date(endISO + 'T00:00:00Z');
  return Math.max(1, Math.round((e - s) / (30.44 * 24 * 60 * 60 * 1000)));
}

function buildMonthBuckets(startISO, endISO) {
  // Return ordered array of { ym, start, end, label }
  var start = new Date(startISO + 'T00:00:00Z');
  var end = new Date(endISO + 'T23:59:59Z');
  var out = [];
  var cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    var nextMonth = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    var bucketStart = cur < start ? start : cur;
    var bucketEnd = new Date(Math.min(nextMonth.getTime() - 1, end.getTime()));
    out.push({
      ym: ymKey(cur),
      start: bucketStart.toISOString().slice(0, 10),
      end: bucketEnd.toISOString().slice(0, 10),
    });
    cur = nextMonth;
  }
  return out;
}

// ── Bookings (Gmail via DWD) ───────────────────────────────────────
//
// Uses calls@moonraker.ai mailbox, derives a search query from
// practice_name. Counts subjects matching "Appointment Scheduled" as
// bookings, "Canceled event:" as cancellations.

function deriveBookingSearchQuery(practiceName) {
  // GReminders booking notifications come from greminders.com.
  // Cancellations are calendar invites from Google Calendar (calendar-notification@google.com),
  // so a from:greminders filter would miss them entirely. Anchor on the two
  // subject prefixes we actually classify, scoped to mentions of the practice.
  if (!practiceName) return null;
  return '"' + practiceName + '" subject:("Appointment Scheduled" OR "Canceled event")';
}

function classifyBookingSubject(subject) {
  if (!subject) return null;
  var s = subject.trim();
  if (/^Appointment Scheduled/i.test(s)) return 'booked';
  if (/^Canceled event/i.test(s)) return 'canceled';
  return null;
}

async function gmailListAll(token, query, cap) {
  var collected = [];
  var pageToken = null;
  for (var safety = 0; safety < 30 && collected.length < cap; safety++) {
    var pageSize = Math.min(500, cap - collected.length);
    var url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
      + '?q=' + encodeURIComponent(query) + '&maxResults=' + pageSize;
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    var data = await resp.json();
    if (!resp.ok) throw new Error('Gmail list failed: ' + (data.error && data.error.message || resp.status));
    if (data.messages) collected = collected.concat(data.messages);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return collected.slice(0, cap);
}

async function gmailGetMetadata(token, id) {
  var url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id
    + '?format=metadata&metadataHeaders=Subject&metadataHeaders=Date';
  var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!resp.ok) return null;
  var data = await resp.json();
  var subject = '';
  if (data.payload && data.payload.headers) {
    for (var i = 0; i < data.payload.headers.length; i++) {
      if (data.payload.headers[i].name === 'Subject') {
        subject = data.payload.headers[i].value;
        break;
      }
    }
  }
  return {
    subject: subject,
    internalDate: data.internalDate ? Number(data.internalDate) : 0
  };
}

async function fetchAllMetadataConcurrent(token, ids, concurrency) {
  var results = new Array(ids.length);
  var idx = 0;
  async function worker() {
    while (true) {
      var i = idx++;
      if (i >= ids.length) return;
      results[i] = await gmailGetMetadata(token, ids[i].id);
    }
  }
  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return results.filter(function(r) { return r; });
}

async function pullBookings(client, monthBuckets) {
  var query = deriveBookingSearchQuery(client.practice_name);
  if (!query) {
    return { available: false, error: 'No practice_name to derive search query' };
  }

  try {
    var token = await google.getDelegatedAccessToken(
      'calls@moonraker.ai',
      'https://www.googleapis.com/auth/gmail.readonly'
    );

    var ids = await gmailListAll(token, query, 5000);
    if (ids.length === 0) {
      return {
        available: true,
        query: query,
        total_booked: 0,
        total_canceled: 0,
        net: 0,
        by_month: monthBuckets.map(function(b) { return { ym: b.ym, booked: 0, canceled: 0 }; })
      };
    }

    var messages = await fetchAllMetadataConcurrent(token, ids, 12);

    // Index buckets by ym for O(1) lookup
    var byMonth = {};
    monthBuckets.forEach(function(b) { byMonth[b.ym] = { ym: b.ym, booked: 0, canceled: 0 }; });

    var totalBooked = 0;
    var totalCanceled = 0;
    var subjectCounts = {};

    messages.forEach(function(m) {
      var bucket = classifyBookingSubject(m.subject);
      if (!bucket) return;
      var ym = ymKey(new Date(m.internalDate));
      if (!byMonth[ym]) return;   // outside engagement window
      byMonth[ym][bucket]++;
      if (bucket === 'booked') totalBooked++;
      else totalCanceled++;
      // Track normalized subjects (strip variable parts) for the histogram
      var normSubject = m.subject.replace(/\s+@\s+\w.*/, '').replace(/:.*$/, '').trim();
      subjectCounts[normSubject] = (subjectCounts[normSubject] || 0) + 1;
    });

    var topSubjects = Object.keys(subjectCounts)
      .map(function(k) { return { subject: k, count: subjectCounts[k] }; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 6);

    return {
      available: true,
      query: query,
      messages_scanned: messages.length,
      total_booked: totalBooked,
      total_canceled: totalCanceled,
      net: totalBooked - totalCanceled,
      by_month: monthBuckets.map(function(b) { return byMonth[b.ym]; }),
      top_subjects: topSubjects
    };
  } catch (e) {
    monitor.logError('campaign-summary', e, {
      client_slug: (client && client.slug) || null,
      detail: { stage: 'pull_bookings' }
    });
    return { available: false, error: 'Failed to pull bookings' };
  }
}

// ── GSC ────────────────────────────────────────────────────────────
//
// Tries to use the SA directly first (cleanest). If that fails (403),
// falls back to impersonating a list of Workspace owners.

var GSC_IMPERSONATION_ORDER = [
  'chris@moonraker.ai',
  'support@moonraker.ai',
  'scott@moonraker.ai'
];

async function gscQuery(token, siteUrl, body) {
  var url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/'
    + encodeURIComponent(siteUrl) + '/searchAnalytics/query';
  var resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  var data = await resp.json();
  if (!resp.ok) {
    var err = new Error('GSC query failed: ' + (data.error && data.error.message || resp.status));
    err.status = resp.status;
    throw err;
  }
  return data;
}

async function getGscToken(siteUrl) {
  var scope = 'https://www.googleapis.com/auth/webmasters.readonly';

  // Try SA directly first
  try {
    var saToken = await google.getServiceAccountToken(scope);
    // Quick probe: list sites
    var probe = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites/'
      + encodeURIComponent(siteUrl), {
      headers: { Authorization: 'Bearer ' + saToken }
    });
    if (probe.ok) return saToken;
  } catch (e) { /* fall through */ }

  // Fall back to impersonation
  for (var i = 0; i < GSC_IMPERSONATION_ORDER.length; i++) {
    try {
      var token = await google.getDelegatedAccessToken(GSC_IMPERSONATION_ORDER[i], scope);
      var probe = await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites/'
        + encodeURIComponent(siteUrl), {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (probe.ok) return token;
    } catch (e) { /* try next */ }
  }
  throw new Error('No account has GSC access to ' + siteUrl);
}

async function pullGsc(siteUrl, monthBuckets, windowStart, windowEnd) {
  if (!siteUrl) return { available: false, error: 'No gsc_property configured' };

  try {
    var token = await getGscToken(siteUrl);

    // Per-month totals (one query each — small enough)
    var monthlyRows = [];
    for (var i = 0; i < monthBuckets.length; i++) {
      var b = monthBuckets[i];
      var data = await gscQuery(token, siteUrl, {
        startDate: b.start, endDate: b.end, dimensions: []
      });
      var row = (data.rows && data.rows[0]) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      monthlyRows.push({
        ym: b.ym,
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        ctr: row.ctr || 0,
        position: row.position || 0
      });
    }

    // Window totals
    var totalsResp = await gscQuery(token, siteUrl, {
      startDate: windowStart, endDate: windowEnd, dimensions: []
    });
    var totalsRow = (totalsResp.rows && totalsResp.rows[0]) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };

    // Top queries (last 90 days for relevance)
    var ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    var startForRecent = ninetyDaysAgo > windowStart ? ninetyDaysAgo : windowStart;

    var topQueriesResp = await gscQuery(token, siteUrl, {
      startDate: startForRecent, endDate: windowEnd,
      dimensions: ['query'], rowLimit: 15
    });
    var topQueries = (topQueriesResp.rows || []).map(function(r) {
      return {
        query: r.keys[0],
        clicks: Math.round(r.clicks || 0),
        impressions: Math.round(r.impressions || 0),
        position: r.position || 0,
        ctr: r.ctr || 0
      };
    });

    var topPagesResp = await gscQuery(token, siteUrl, {
      startDate: startForRecent, endDate: windowEnd,
      dimensions: ['page'], rowLimit: 10
    });
    var topPages = (topPagesResp.rows || []).map(function(r) {
      return {
        page: r.keys[0],
        clicks: Math.round(r.clicks || 0),
        impressions: Math.round(r.impressions || 0),
        position: r.position || 0
      };
    });

    // Position trend: first month avg vs last month avg
    var firstMonth = monthlyRows.find(function(r) { return r.impressions > 0; });
    var lastMonth = monthlyRows.slice().reverse().find(function(r) { return r.impressions > 0; });

    // Striking-distance queries (position 11-20 with meaningful impressions)
    var strikingDistance = await pullStrikingDistance(token, siteUrl, startForRecent, windowEnd);

    return {
      available: true,
      site_url: siteUrl,
      totals: {
        clicks: Math.round(totalsRow.clicks || 0),
        impressions: Math.round(totalsRow.impressions || 0),
        ctr: totalsRow.ctr || 0,
        position: totalsRow.position || 0
      },
      by_month: monthlyRows,
      top_queries: topQueries,
      top_pages: topPages,
      striking_distance: strikingDistance,
      position_first: firstMonth ? firstMonth.position : null,
      position_last: lastMonth ? lastMonth.position : null,
      recent_window: { start: startForRecent, end: windowEnd }
    };
  } catch (e) {
    monitor.logError('campaign-summary', e, {
      detail: { stage: 'pull_gsc', site_url: siteUrl }
    });
    return { available: false, error: 'Failed to pull GSC data' };
  }
}

// ── LocalFalcon (placeholder for now) ──────────────────────────────

async function pullLocalFalcon(reportConfig) {
  // For v1, just check whether the client has LF configured.
  // Fuller integration can pull recent grid scans when historical data exists.
  if (!reportConfig || !reportConfig.lf_campaign_keys) {
    return { available: false, error: 'No LocalFalcon campaigns configured' };
  }
  // The "place_id not found in saved locations" warning means historical
  // data isn't available yet — hide section until it is.
  return { available: false, error: 'No historical LocalFalcon data available yet' };
}

// ── Google Business Profile Performance ─────────────────────────────
//
// Pulls total engagement metrics for the full display window. Requires
// report_configs.gbp_location_id, set per-client via admin tooling.
// Delegates to _lib/gbp.js which is shared with compile-report.js.

async function pullGbp(reportConfig, windowStart, windowEnd) {
  if (!reportConfig || !reportConfig.gbp_location_id) {
    return { available: false, error: 'No gbp_location_id configured' };
  }
  var result = await gbp.fetchPerformance(
    reportConfig.gbp_location_id, windowStart, windowEnd
  );
  return result;
}

// ── Cost / unit economics ──────────────────────────────────────────
//
// Computes total spend across the engagement window. Uses contacts.plan_amount_cents
// as the monthly retainer. Caller passes the billed-month count derived from
// the contract window (decoupled from chart bucket count, which may extend
// past the contract for visualization purposes).

function pullCost(client, billedMonths) {
  if (!client.plan_amount_cents) {
    return { available: false, error: 'No plan_amount_cents set on contact' };
  }
  var monthlyCents = Number(client.plan_amount_cents);
  var totalCents = monthlyCents * billedMonths;
  return {
    available: true,
    monthly_cents: monthlyCents,
    monthly_dollars: monthlyCents / 100,
    total_cents: totalCents,
    total_dollars: totalCents / 100,
    billed_months: billedMonths
  };
}

// ── Striking distance (GSC queries close to page 1) ────────────────
//
// Pulls top queries by impressions for the recent window, filters those
// at position 11-20 (page 2, "striking distance" of page 1). These are
// the next quarter's wins — already ranking, just need a nudge.

async function pullStrikingDistance(token, siteUrl, startDate, endDate) {
  if (!token || !siteUrl) return [];
  try {
    var resp = await gscQuery(token, siteUrl, {
      startDate: startDate,
      endDate: endDate,
      dimensions: ['query'],
      rowLimit: 250
    });
    var rows = resp.rows || [];
    return rows
      .filter(function(r) {
        var pos = r.position || 0;
        return pos >= 11 && pos <= 20 && (r.impressions || 0) >= 50;
      })
      .map(function(r) {
        var imps = Math.round(r.impressions || 0);
        var pos = r.position || 0;
        // Estimated lift if moved into top 10: assume ~5% CTR at top of page 1
        // (conservative — actual top-10 CTR in healthcare averages 8-10%).
        var estTop10Ctr = 0.05;
        var currentClicks = Math.round(r.clicks || 0);
        var estimatedTop10Clicks = Math.round(imps * estTop10Ctr);
        var lift = Math.max(0, estimatedTop10Clicks - currentClicks);
        return {
          query: r.keys[0],
          position: pos,
          impressions: imps,
          clicks: currentClicks,
          ctr: r.ctr || 0,
          estimated_lift_clicks: lift
        };
      })
      .sort(function(a, b) { return b.impressions - a.impressions; })
      .slice(0, 12);
  } catch (e) {
    monitor.logError('campaign-summary', e, {
      detail: { stage: 'pull_striking_distance', site_url: siteUrl }
    });
    return [];
  }
}

// ── Deliverables ───────────────────────────────────────────────────
//
// Pulls deliverables for the client, grouped by category. Categories
// roll up the raw deliverable_type into a smaller set of meaningful buckets
// for client-facing display.

var DELIVERABLE_CATEGORIES = {
  'Setup & Foundation': ['report_config', 'gsc_setup', 'ga4_setup', 'gtm_setup', 'gbp_setup', 'gbp_optimization', 'livedrive'],
  'Content & SEO Pages': ['target_page', 'surge_page', 'faq_page', 'location_page', 'instant_page', 'bio_page', 'surge_entity', 'surge_sitewide', 'blog_post'],
  'Authority & Trust Signals': ['social_profiles', 'social_posts', 'press_release', 'citations', 'neo_distribution', 'neo_images', 'entity_veracity_hub', 'endorsement'],
  'Strategy & Audits': ['proposal', 'audit_diagnosis', 'audit_action_plan', 'audit_progress', 'youtube_video']
};

function categorize(type) {
  for (var cat in DELIVERABLE_CATEGORIES) {
    if (DELIVERABLE_CATEGORIES[cat].indexOf(type) !== -1) return cat;
  }
  return 'Other';
}

async function pullDeliverables(contactId) {
  if (!contactId) return { available: false, error: 'No contact ID' };
  try {
    var rows = await sb.query('deliverables?contact_id=eq.' + encodeURIComponent(contactId)
      + '&select=deliverable_type,title,status,delivered_at,created_at&order=created_at.asc');
    if (!rows || rows.length === 0) {
      return { available: true, total: 0, by_category: [], items: [] };
    }
    // Group by category
    var catCounts = {};
    rows.forEach(function(r) {
      var cat = categorize(r.deliverable_type);
      if (!catCounts[cat]) catCounts[cat] = { category: cat, count: 0, items: [] };
      catCounts[cat].count++;
      catCounts[cat].items.push({
        type: r.deliverable_type,
        title: r.title,
        status: r.status,
        delivered_at: r.delivered_at,
        created_at: r.created_at
      });
    });
    var byCategory = Object.keys(catCounts).map(function(k) { return catCounts[k]; });
    // Order: Setup first, then Content, Authority, Strategy, Other
    var order = ['Setup & Foundation', 'Content & SEO Pages', 'Authority & Trust Signals', 'Strategy & Audits', 'Other'];
    byCategory.sort(function(a, b) { return order.indexOf(a.category) - order.indexOf(b.category); });
    return {
      available: true,
      total: rows.length,
      by_category: byCategory,
      items: rows
    };
  } catch (e) {
    monitor.logError('campaign-summary', e, {
      detail: { stage: 'pull_deliverables', contact_id: contactId }
    });
    return { available: false, error: 'Failed to pull deliverables' };
  }
}

// ── Attribution (client-reported YoY data) ────────────────────────
//
// Pulls multi-source attribution periods stored by the admin team and
// computes year-over-year deltas. Source rows live in client_attribution_sources
// keyed off period_id.

async function pullAttribution(contactId) {
  if (!contactId) return { available: false };
  try {
    var periods = await sb.query('client_attribution_periods?contact_id=eq.'
      + encodeURIComponent(contactId) + '&select=*&order=period_start.asc');
    if (!periods || periods.length === 0) {
      return { available: false, reason: 'No attribution data recorded yet' };
    }

    // Pull all sources for these periods in one query
    var periodIds = periods.map(function(p) { return p.id; }).join(',');
    var sources = await sb.query('client_attribution_sources?period_id=in.('
      + periodIds + ')&select=*');

    // Group sources by period
    var byPeriod = {};
    sources.forEach(function(s) {
      if (!byPeriod[s.period_id]) byPeriod[s.period_id] = [];
      byPeriod[s.period_id].push(s);
    });

    // Enrich periods with their sources + totals
    var enriched = periods.map(function(p) {
      var srcs = byPeriod[p.id] || [];
      var totals = srcs.reduce(function(acc, s) {
        acc.appointments += Number(s.appointment_count || 0);
        acc.revenue_cents += Number(s.revenue_cents || 0);
        return acc;
      }, { appointments: 0, revenue_cents: 0 });
      return {
        id: p.id,
        period_start: p.period_start,
        period_end: p.period_end,
        period_label: p.period_label,
        is_baseline: p.is_baseline,
        notes: p.notes,
        reported_by: p.reported_by,
        reported_at: p.reported_at,
        sources: srcs.map(function(s) {
          return {
            source_name: s.source_name,
            source_category: s.source_category,
            appointment_count: Number(s.appointment_count || 0),
            revenue_cents: Number(s.revenue_cents || 0),
            revenue_dollars: Number(s.revenue_cents || 0) / 100
          };
        }),
        totals: {
          appointments: totals.appointments,
          revenue_cents: totals.revenue_cents,
          revenue_dollars: totals.revenue_cents / 100
        }
      };
    });

    // Compute YoY for the most recent baseline + most recent non-baseline period
    var baseline = enriched.find(function(p) { return p.is_baseline; });
    var current = enriched.slice().reverse().find(function(p) { return !p.is_baseline; });

    var yoy = null;
    if (baseline && current) {
      var pickGoogle = function(p) {
        return p.sources.find(function(s) {
          return s.source_name && s.source_name.toLowerCase() === 'google';
        }) || { appointment_count: 0, revenue_cents: 0 };
      };
      var googleBase = pickGoogle(baseline);
      var googleCurrent = pickGoogle(current);

      var googleRevenueDelta = googleCurrent.revenue_cents - googleBase.revenue_cents;
      var googleRevenueGrowthPct = googleBase.revenue_cents > 0
        ? (googleRevenueDelta / googleBase.revenue_cents)
        : null;

      var totalRevenueDelta = current.totals.revenue_cents - baseline.totals.revenue_cents;
      var totalRevenueGrowthPct = baseline.totals.revenue_cents > 0
        ? (totalRevenueDelta / baseline.totals.revenue_cents)
        : null;

      yoy = {
        baseline_label: baseline.period_label,
        current_label: current.period_label,
        google: {
          appointments_baseline: googleBase.appointment_count,
          appointments_current: googleCurrent.appointment_count,
          revenue_cents_baseline: googleBase.revenue_cents,
          revenue_cents_current: googleCurrent.revenue_cents,
          revenue_dollars_baseline: googleBase.revenue_cents / 100,
          revenue_dollars_current: googleCurrent.revenue_cents / 100,
          revenue_growth_pct: googleRevenueGrowthPct,
          revenue_delta_dollars: googleRevenueDelta / 100
        },
        total_online: {
          appointments_baseline: baseline.totals.appointments,
          appointments_current: current.totals.appointments,
          revenue_cents_baseline: baseline.totals.revenue_cents,
          revenue_cents_current: current.totals.revenue_cents,
          revenue_dollars_baseline: baseline.totals.revenue_cents / 100,
          revenue_dollars_current: current.totals.revenue_cents / 100,
          revenue_growth_pct: totalRevenueGrowthPct,
          revenue_delta_dollars: totalRevenueDelta / 100
        },
        avg_revenue_per_appointment_current: current.totals.appointments > 0
          ? (current.totals.revenue_cents / 100 / current.totals.appointments)
          : null
      };
    }

    return {
      available: true,
      periods: enriched,
      yoy: yoy
    };
  } catch (e) {
    // Most likely cause: tables not yet created. Hide section gracefully.
    monitor.logError('campaign-summary', e, {
      detail: { stage: 'pull_attribution', contact_id: contactId }
    });
    return { available: false, error: 'Failed to pull attribution' };
  }
}

// ── Attribution deep-dive insights (synthesis + client commentary) ──
//
// Renders a narrative block under the YoY attribution table. Populated
// manually by the Moonraker team from client-supplied data (e.g. lead
// attribution spreadsheets). Row stored per contact; only shown when
// published=true.

async function pullAttributionInsights(contactId) {
  if (!contactId) return { available: false };
  try {
    var row = await sb.one('client_attribution_insights?contact_id=eq.'
      + encodeURIComponent(contactId) + '&limit=1');
    if (!row || !row.published) return { available: false };
    return {
      available: true,
      headline: row.headline || null,
      summary_markdown: row.summary_markdown || null,
      client_commentary_markdown: row.client_commentary_markdown || null,
      source_mix: Array.isArray(row.source_mix_json) ? row.source_mix_json : null,
      data_period_start: row.data_period_start || null,
      data_period_end: row.data_period_end || null,
      data_source_note: row.data_source_note || null,
      updated_at: row.updated_at || null
    };
  } catch (e) {
    monitor.logError('campaign-summary', e, {
      detail: { stage: 'pull_attribution_insights', contact_id: contactId }
    });
    return { available: false, error: 'Failed to pull attribution insights' };
  }
}

// ── Performance guarantee evaluation ──────────────────────────────
//
// Compares the threshold (typically 2x investment) against the most recent
// year's attributed revenue. Returns multiple "reads" (Google-only,
// total-online) so the page can frame it honestly.

function evaluateGuarantee(reportConfig, attribution) {
  if (!reportConfig || !reportConfig.performance_guarantee_cents) {
    return { available: false, reason: 'No performance guarantee configured' };
  }
  if (!attribution || !attribution.available || !attribution.yoy) {
    return {
      available: true,
      threshold_cents: Number(reportConfig.performance_guarantee_cents),
      threshold_dollars: Number(reportConfig.performance_guarantee_cents) / 100,
      met: null,
      reason: 'No attribution data to evaluate against threshold'
    };
  }
  var threshold = Number(reportConfig.performance_guarantee_cents);
  var googleOnly = attribution.yoy.google.revenue_cents_current;
  var totalOnline = attribution.yoy.total_online.revenue_cents_current;

  return {
    available: true,
    threshold_cents: threshold,
    threshold_dollars: threshold / 100,
    google_only_cents: googleOnly,
    google_only_dollars: googleOnly / 100,
    total_online_cents: totalOnline,
    total_online_dollars: totalOnline / 100,
    met_by_google: googleOnly >= threshold,
    met_by_total: totalOnline >= threshold,
    multiple_google: threshold > 0 ? googleOnly / threshold : null,
    multiple_total: threshold > 0 ? totalOnline / threshold : null,
    over_by_google_dollars: (googleOnly - threshold) / 100,
    over_by_total_dollars: (totalOnline - threshold) / 100
  };
}

// ── Handler ────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var slug = (req.query && req.query.client) || (req.body && req.body.client);
  if (!slug) {
    res.status(400).json({ error: 'client slug required' });
    return;
  }

  // Page-token gate (security audit C11).
  // The campaign-summary page is public-link but previously returned the
  // client's revenue + cost + performance to anyone who knew the slug. A
  // page-token bound to scope='campaign_summary' and the contact_id makes
  // the link itself the secret, matching the /reports / /proposal pattern.
  var submittedToken = pageToken.getTokenFromRequest(req, 'campaign_summary') || '';
  var tokenData;
  try {
    tokenData = pageToken.verify(submittedToken, 'campaign_summary');
  } catch (e) {
    // Thrown only when PAGE_TOKEN_SECRET is not configured — config error, 500.
    console.error('[campaign-summary] page-token verify threw:', e.message);
    return res.status(500).json({ error: 'Page token service unavailable' });
  }
  if (!tokenData) {
    return res.status(401).json({ error: 'Invalid or expired page token' });
  }

  var t0 = Date.now();

  try {
    // 1. Load client
    var clients = await sb.query('contacts?slug=eq.' + encodeURIComponent(slug)
      + '&select=id,slug,first_name,last_name,practice_name,city,state_province,website_url,campaign_start,campaign_end,plan_type,plan_amount_cents&limit=1');
    if (!clients || clients.length === 0) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    var client = clients[0];

    // Bind token to the resolved contact_id. Prevents a token signed for one
    // client from being replayed against another client's summary.
    if (tokenData.contact_id !== client.id) {
      return res.status(403).json({ error: 'Token does not match client' });
    }

    // 2. Load report_config
    var configs = await sb.query('report_configs?client_slug=eq.' + encodeURIComponent(slug)
      + '&select=*&limit=1');
    var reportConfig = (configs && configs[0]) || null;

    // 3. Build window dates.
    //
    // Two related windows here:
    //   contractStart/contractEnd — source of truth for cost, guarantee, and
    //     the display label. Anchored to the actual contract dates.
    //   displayStart/displayEnd   — extended to full calendar months at both
    //     boundaries so the chart renders uniform monthly bars instead of
    //     stunted partials. Capped at today on the high end so we don't
    //     fetch future-dated data. Pre-engagement portion of the first bar
    //     reflects the client's pre-campaign baseline, which gives us a
    //     useful "started here" reference.
    //
    // End date precedence for contractEnd:
    //   1. contacts.campaign_end (explicit override)
    //   2. campaign_start + plan_type interval (annual=12mo, quarterly=3mo, monthly=12mo default)
    //   3. campaign_start + 12 months (fallback when plan_type is null)
    var todayISO = new Date().toISOString().slice(0, 10);
    var contractStartISO = client.campaign_start || todayISO;
    if (contractStartISO > todayISO) contractStartISO = todayISO;

    var contractMonths = contract.deriveContractMonths(client.plan_type);
    var contractEndISO = client.campaign_end || addMonthsISO(contractStartISO, contractMonths);

    // For data pulls and cost: cap contract end at today
    var endISO = contractEndISO < todayISO ? contractEndISO : todayISO;

    // Display window for chart: full calendar months at both ends
    var displayStartISO = startOfMonthISO(contractStartISO);
    var displayEndCandidateISO = endOfMonthISO(endISO);
    var displayEndISO = displayEndCandidateISO < todayISO ? displayEndCandidateISO : todayISO;

    var monthBuckets = buildMonthBuckets(displayStartISO, displayEndISO);

    // Display-facing engagement length, calculated from the contract window
    // (start → derived end) using whole-month math so a Mar 12 - Mar 12
    // contract reads as "12 months" instead of "13" due to partial-month buckets.
    var displayMonths = monthsBetween(contractStartISO, contractEndISO);

    // Billed months: capped at elapsed (so an in-flight 12-month contract
    // 6 months in shows 6 billed, not 12)
    var elapsedMonths = monthsBetween(contractStartISO, endISO);
    var billedMonths = Math.min(elapsedMonths, displayMonths);

    // 4. Pull all sources in parallel
    var [bookings, gsc, localfalcon, deliverables, attribution, gbpPerf, attributionInsights] = await Promise.all([
      pullBookings(client, monthBuckets),
      pullGsc(reportConfig && reportConfig.gsc_property, monthBuckets, displayStartISO, displayEndISO),
      pullLocalFalcon(reportConfig),
      pullDeliverables(client.id),
      pullAttribution(client.id),
      pullGbp(reportConfig, displayStartISO, displayEndISO),
      pullAttributionInsights(client.id)
    ]);

    // Cost + derived unit economics (synchronous)
    var cost = pullCost(client, billedMonths);

    // Performance guarantee status (synchronous, depends on attribution)
    var guarantee = evaluateGuarantee(reportConfig, attribution);

    // Click-to-booking conversion (requires both bookings + gsc)
    var conversion = null;
    if (bookings.available && gsc.available && bookings.net > 0 && gsc.totals.clicks > 0) {
      var rate = bookings.net / gsc.totals.clicks;
      conversion = {
        available: true,
        rate: rate,
        rate_pct: rate * 100,
        clicks_per_booking: Math.round(gsc.totals.clicks / bookings.net)
      };
    } else {
      conversion = { available: false };
    }

    // Cost per consultation
    var costPerConsultation = null;
    if (cost.available && bookings.available && bookings.net > 0) {
      costPerConsultation = {
        available: true,
        dollars: cost.total_dollars / bookings.net,
        total_invested_dollars: cost.total_dollars,
        consultations: bookings.net
      };
    } else {
      costPerConsultation = { available: false };
    }

    var location = [client.city, client.state_province].filter(Boolean).join(', ');

    // Auth-gated response — must NOT be cached on Vercel's edge. Without a
    // Vary on the page-token cookie, `public, s-maxage=...` lets the CDN
    // serve one client's payload to any visitor who knows the slug. Verified
    // 2026-04-23: x-vercel-cache: HIT on a no-cookie request returned the
    // full client object. `private, no-store` keeps the browser from caching
    // it locally too, which matches the no-store pattern used by every other
    // page-token-gated endpoint (public-onboarding-data, campaign-summary-chat,
    // proposal-chat, sign-guarantee, save-guarantee-draft).
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json({
      client: {
        slug: client.slug,
        name: ((client.first_name || '') + ' ' + (client.last_name || '')).trim(),
        practice: client.practice_name || '',
        location: location,
        website_url: client.website_url || '',
        campaign_start: client.campaign_start
      },
      window: {
        start: contractStartISO,
        end: contractEndISO,
        days: Math.floor((new Date(contractEndISO) - new Date(contractStartISO)) / 86400000),
        months: displayMonths,
        display_start: displayStartISO,
        display_end: displayEndISO
      },
      bookings: bookings,
      gsc: gsc,
      localfalcon: localfalcon,
      gbp: gbpPerf,
      cost: cost,
      conversion: conversion,
      cost_per_consultation: costPerConsultation,
      deliverables: deliverables,
      attribution: attribution,
      attribution_deep_dive: attributionInsights,
      guarantee: guarantee,
      next_period: {
        heading: (reportConfig && reportConfig.next_period_heading) || null,
        body:    (reportConfig && reportConfig.next_period_body)    || null
      },
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - t0
    });
  } catch (e) {
    monitor.logError('campaign-summary', e, {
      client_slug: (typeof slug !== 'undefined' ? slug : null),
      detail: { stage: 'summary_handler' }
    });
    res.status(500).json({ error: 'Failed to build campaign summary', duration_ms: Date.now() - t0 });
  }
};

