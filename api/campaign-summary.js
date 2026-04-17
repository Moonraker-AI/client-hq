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
var google = require('./_lib/google-delegated');

// ── Helpers ────────────────────────────────────────────────────────

function ymKey(d) {
  return d.toISOString().slice(0, 7);            // "2025-10"
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
    console.error('[campaign-summary] bookings error:', e);
    return { available: false, error: e.message || String(e) };
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
      position_first: firstMonth ? firstMonth.position : null,
      position_last: lastMonth ? lastMonth.position : null,
      recent_window: { start: startForRecent, end: windowEnd }
    };
  } catch (e) {
    console.error('[campaign-summary] GSC error:', e);
    return { available: false, error: e.message || String(e) };
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

// ── Handler ────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Allow public read of the campaign summary (per-slug page is public-link;
  // matches how /[slug]/reports works). If we later want to gate it, add auth here.
  var slug = (req.query && req.query.client) || (req.body && req.body.client);
  if (!slug) {
    res.status(400).json({ error: 'client slug required' });
    return;
  }

  var t0 = Date.now();

  try {
    // 1. Load client
    var clients = await sb.query('contacts?slug=eq.' + encodeURIComponent(slug)
      + '&select=slug,first_name,last_name,practice_name,city,state_province,website_url,campaign_start&limit=1');
    if (!clients || clients.length === 0) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    var client = clients[0];

    // 2. Load report_config
    var configs = await sb.query('report_configs?client_slug=eq.' + encodeURIComponent(slug)
      + '&select=*&limit=1');
    var reportConfig = (configs && configs[0]) || null;

    // 3. Build window: campaign_start → today
    var todayISO = new Date().toISOString().slice(0, 10);
    var startISO = client.campaign_start || todayISO;
    if (startISO > todayISO) startISO = todayISO;
    var monthBuckets = buildMonthBuckets(startISO, todayISO);

    // 4. Pull all sources in parallel
    var [bookings, gsc, localfalcon] = await Promise.all([
      pullBookings(client, monthBuckets),
      pullGsc(reportConfig && reportConfig.gsc_property, monthBuckets, startISO, todayISO),
      pullLocalFalcon(reportConfig)
    ]);

    var location = [client.city, client.state_province].filter(Boolean).join(', ');

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
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
        start: startISO,
        end: todayISO,
        days: Math.floor((new Date(todayISO) - new Date(startISO)) / 86400000),
        months: monthBuckets.length
      },
      bookings: bookings,
      gsc: gsc,
      localfalcon: localfalcon,
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - t0
    });
  } catch (e) {
    console.error('[campaign-summary] fatal:', e);
    res.status(500).json({ error: e.message || 'Internal error', duration_ms: Date.now() - t0 });
  }
};
