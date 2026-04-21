// /api/public-proposal.js
//
// Public read endpoint for the dynamically-rendered proposal page.
//
// Replaces the per-client baked `<slug>/proposal/index.html` files with a
// single dynamic shell (_templates/proposal.html) that calls this endpoint
// on load to hydrate. See `migrations/2026-04-21-proposal-versioning.sql`
// for schema.
//
// Anon request (default):
//   GET /api/public-proposal?slug=<slug>
//   -> 200 { contact, proposal, version, rendered }
//
//   Returns whichever version is currently active (proposals.active_version_id).
//   Retired versions are never returned through the anon path, even if
//   explicitly requested — `?v=N` is silently ignored for non-admins.
//
// Admin request (JWT cookie `mr_admin_sess` or Bearer header):
//   GET /api/public-proposal?slug=<slug>&v=<version_number>
//   -> 200 { contact, proposal, version, rendered }
//
//   Lets admin UI surface historical versions. Returns 404 if the
//   version_number doesn't exist.
//
// The `rendered` block contains server-built HTML strings for the three
// placeholders that aren't AI-generated content: investment_cards_html,
// guarantee_box_html, results_section_html. Building these server-side
// (rather than baking into proposal_content at generate time) keeps:
//
//   - pricing always reflective of /admin/pricing edits (no refresh script)
//   - historical versions replayable against current pricing_tiers
//   - render logic in one place; template JS stays a pure hydrator
//
// Security posture:
//   - proposal_versions has no anon RLS policy; only service_role reads.
//   - `proposal_content` HTML blobs ARE trusted (admin-authored / AI-
//     authored with post-processing). The trust boundary lives at
//     generate-proposal.js, not here.
//   - All anon response bodies cached 30s. Admin ?v=N responses are NOT
//     cached (per-user view history).

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

var SAFE_CONTACT_COLUMNS = [
  'id',
  'slug',
  'first_name',
  'last_name',
  'credentials',
  'practice_name',
  'city',
  'state_province'
].join(',');

var SAFE_PROPOSAL_COLUMNS = [
  'status',
  'campaign_lengths',
  'billing_options',
  'custom_pricing',
  'active_version_id',
  'version_count',
  'proposal_url',
  'checkout_url'
].join(',');

var SAFE_VERSION_COLUMNS = [
  'version_number',
  'generated_at',
  'retired_at',
  'proposal_content'
].join(',');

// ─── render helpers (ported from generate-proposal.js) ─────────────
//
// These used to run once at generate time. They now run on every proposal
// view, behind a 30s cache.

var CAMPAIGN_DISPLAY = {
  annual:    '12-Month CORE Campaign',
  quarterly: '3-Month Growth Engagement',
  monthly:   'Monthly CORE Engagement'
};

var TIMELINE_LABEL = {
  annual:    '12-Month',
  quarterly: '3-Month',
  monthly:   'Monthly'
};

var STANDARD_FEATURES = (
  '<li><span class="check">&#10003;</span> Comprehensive digital audit using our proprietary Surge platform</li>' +
  '<li><span class="check">&#10003;</span> 5 dedicated service pages with custom HTML, schema markup, and targeted FAQs</li>' +
  '<li><span class="check">&#10003;</span> Professional bio pages for each therapist at your practice</li>' +
  '<li><span class="check">&#10003;</span> 1 location page to clearly establish where you serve</li>' +
  '<li><span class="check">&#10003;</span> General FAQ page covering logistics, policies, and common client questions</li>' +
  '<li><span class="check">&#10003;</span> Citation audit and listings via BrightLocal (15 citations + data aggregators)</li>' +
  '<li><span class="check">&#10003;</span> Social profile buildout and optimization across 9 platforms</li>' +
  '<li><span class="check">&#10003;</span> Entity Veracity Hub launch to verify and ground your practice online</li>' +
  '<li><span class="check">&#10003;</span> YouTube channel setup with optimized playlist for your main specialty</li>' +
  '<li><span class="check">&#10003;</span> Press release syndication across 500+ national and international news sites</li>' +
  '<li><span class="check">&#10003;</span> NEO image creation and distribution to build authority across high-traffic platforms</li>' +
  '<li><span class="check">&#10003;</span> Ongoing social posting across 4 platforms to reinforce your digital presence</li>' +
  '<li><span class="check">&#10003;</span> Professional endorsement collection for clinician bio pages</li>' +
  '<li><span class="check">&#10003;</span> Hero section and CTA optimization to convert visitors into consultation bookings</li>' +
  '<li><span class="check">&#10003;</span> Monthly progress reports with visibility and engagement metrics</li>'
);

var GUARANTEE_FEATURE = '<li><span class="check">&#10003;</span> <strong>12-month performance guarantee: if we don\'t hit our shared goal in 12 months, we continue working for free until you get there</strong></li>';

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTierPrice(cents) {
  if (typeof cents !== 'number') return '$—';
  var d = cents / 100;
  if (Number.isInteger(d)) return '$' + d.toLocaleString('en-US');
  return '$' + d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchTierPrices() {
  var prices = { annual: '$20,000', quarterly: '$5,000', monthly: '$2,000' };
  try {
    var rows = await sb.query(
      'pricing_tiers?product_key=eq.core_marketing' +
      '&tier_key=in.(annual_upfront_ach,quarterly_upfront_ach,monthly_ach)' +
      '&active=eq.true&select=tier_key,amount_cents'
    );
    var byKey = {};
    (rows || []).forEach(function(r) { byKey[r.tier_key] = r; });
    if (byKey.annual_upfront_ach)    prices.annual    = formatTierPrice(byKey.annual_upfront_ach.amount_cents);
    if (byKey.quarterly_upfront_ach) prices.quarterly = formatTierPrice(byKey.quarterly_upfront_ach.amount_cents);
    if (byKey.monthly_ach)           prices.monthly   = formatTierPrice(byKey.monthly_ach.amount_cents);
  } catch (e) {
    console.error('[public-proposal] pricing_tiers fetch failed:', e.message);
  }
  return prices;
}

function buildInvestmentCardsHtml(slug, campaigns, customPricing, tierPrices) {
  var cardInfo = {
    annual:    { badge: '12-Month CORE Campaign',    price: tierPrices.annual,    period: '12-month campaign' },
    quarterly: { badge: '3-Month Growth Engagement', price: tierPrices.quarterly, period: '3-month campaign'  },
    monthly:   { badge: 'Monthly CORE Engagement',   price: tierPrices.monthly,   period: 'per month'         }
  };

  var html = '<div class="investment-grid">';
  campaigns.forEach(function(c) {
    var info = cardInfo[c];
    if (!info) return;
    var isRecommended = campaigns.length > 1 && c === 'annual';
    html += '<div class="investment-card' + (isRecommended ? ' recommended' : '') + '">';
    html += '<span class="badge">' + info.badge + '</span>';
    html += '<div class="investment-price">' + info.price + '</div>';
    html += '<div class="investment-period">' + info.period + '</div>';
    var features = (c === 'annual' ? GUARANTEE_FEATURE : '') + STANDARD_FEATURES;
    html += '<ul class="investment-features">' + features + '</ul>';
    html += '<a href="/' + esc(slug) + '/checkout?plan=' + encodeURIComponent(c) + '" class="cta-btn" target="_blank">Choose Your Plan &#8594;</a>';
    html += '</div>';
  });

  if (customPricing) {
    var amt = Number(customPricing.amount_cents);
    var priceHtml = (Number.isFinite(amt) && amt >= 0)
      ? '$' + (amt / 100).toLocaleString()
      : '&mdash;';
    html += '<div class="investment-card">';
    html += '<span class="badge">Custom Arrangement</span>';
    html += '<div class="investment-price">' + priceHtml + '</div>';
    html += '<div class="investment-period">' + esc(customPricing.label || customPricing.period || '') + '</div>';
    html += '<ul class="investment-features">' + STANDARD_FEATURES + '</ul>';
    html += '<a href="/' + esc(slug) + '/checkout" class="cta-btn" target="_blank">Choose Your Plan &#8594;</a>';
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function buildGuaranteeBoxHtml(campaigns) {
  if (campaigns.includes('annual')) {
    return '<div class="guarantee-box"><h3>Performance Guarantee</h3><p>Our annual program includes a <a href="https://clients.moonraker.ai/guarantee" target="_blank" rel="noopener">performance guarantee</a> - we set a measurable consultation benchmark together using your historical data, and we continue working for free until you hit it. No other agency in this space offers this.</p></div>';
  }
  if (campaigns.includes('quarterly')) {
    return '<div class="guarantee-box"><h3>Looking Ahead</h3><p>Our annual program includes a <a href="https://clients.moonraker.ai/guarantee" target="_blank" rel="noopener">performance guarantee</a> - we set a measurable consultation benchmark together and continue working for free until you hit it. While the 3-month engagement builds the foundation, many clients see enough momentum to transition to an annual program where the guarantee kicks in.</p><p>Everything we build in these 3 months is yours to keep, regardless of what you decide next.</p></div>';
  }
  return '';
}

// Returns the HTML for the results section (stats bar + mini grid + CTA +
// lightbox container). Does NOT include the lightbox JS — the template owns
// the click wiring, reading hires URL + meta from each card's data-* attrs.
function buildResultsSectionHtml(practiceType) {
  // Normalize: practice_details.practice_type has historically been set as
  // 'solo', 'group', 'Group practice', 'Both', or NULL. The stats bar only
  // branches two ways (solo vs everything-else), so we case-fold and match
  // on substring for resilience against future data-entry drift.
  var isSolo = typeof practiceType === 'string' && practiceType.toLowerCase().indexOf('solo') !== -1;

  var groupResults = [
    { pct: 213, time: '6 months', id: '1uVfNKUBxYy3KCEJEmJU92QE3DN9khHWA', label: 'Group Practice' },
    { pct: 170, time: '6 months', id: '1spFbq2k8QOqwWbLuvz1JxLgWpM7VFfaa', label: 'Group Practice' },
    { pct: 156, time: '3 months', id: '1jNjoiNtFgIINAyUpWyvH426qq1HTHG7X', label: 'Group Practice' }
  ];
  var soloResults = [
    { pct: 308, time: '3 months', id: '1ClS6rM1HrdGKr1qXKF7J9Yo32HaiFZOE', label: 'Solo Therapist' },
    { pct: 202, time: '6 months', id: '1fdthfPuD2hn4g-yR1yaEd3VYJTYdFN5l', label: 'Solo Therapist' },
    { pct: 168, time: '6 months', id: '1zTy0yzf_cZFPRiQNCykjxTLQfjoRDKVT', label: 'Solo Therapist' }
  ];

  var featured = isSolo ? soloResults : groupResults;
  var typeLabel = isSolo ? 'Solo Therapists' : 'Group Practices';
  var topPct = isSolo ? '308%' : '213%';
  var topLabel = isSolo ? 'Solo' : 'Group';

  var html = '';
  html += '<div class="results-stats-bar">';
  html += '<div class="stat"><div class="stat-value">22</div><div class="stat-label">Client Results</div></div>';
  html += '<div class="stat"><div class="stat-value">115%</div><div class="stat-label">Average Increase</div></div>';
  html += '<div class="stat"><div class="stat-value">' + topPct + '</div><div class="stat-label">Top ' + topLabel + ' Result</div></div>';
  html += '</div>';

  html += '<p style="text-align:center;font-size:.8125rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--color-muted);margin-bottom:1rem;">Featuring results from ' + typeLabel + '</p>';

  html += '<div class="results-mini-grid">';
  featured.forEach(function(r, i) {
    var imgUrl   = 'https://lh3.googleusercontent.com/d/' + r.id + '=w800';
    var hiResUrl = 'https://lh3.googleusercontent.com/d/' + r.id + '=w1400';
    html += '<div class="results-mini-card" data-result-index="' + i + '" data-hires="' + hiResUrl + '" data-label="' + esc(r.label) + '" data-pct="' + r.pct + '" data-time="' + esc(r.time) + '">';
    html += '<div class="card-image-wrap"><img src="' + imgUrl + '" alt="' + esc(r.label) + ' result: +' + r.pct + '% in ' + esc(r.time) + '" loading="lazy"><div class="card-badge">+' + r.pct + '%</div></div>';
    html += '<div class="card-body"><div class="card-meta"><span class="card-type-tag">' + esc(r.label) + '</span> ' + esc(r.time) + '</div></div>';
    html += '</div>';
  });
  html += '</div>';

  html += '<div class="results-see-all">';
  html += '<a href="https://clients.moonraker.ai/results" class="cta-btn-outline" target="_blank" rel="noopener">See All 22 Client Results &#8594;</a>';
  html += '</div>';

  // Lightbox container — static, script wiring lives in the template.
  html += '<div class="results-lightbox" id="resultsLightbox">';
  html += '<button class="results-lightbox-close" type="button">&times;</button>';
  html += '<div class="results-lightbox-inner">';
  html += '<img id="resultsLightboxImg" src="" alt="">';
  html += '<div class="results-lightbox-caption" id="resultsLightboxCaption"></div>';
  html += '</div></div>';

  return html;
}

// Pick the campaign key used for page-level labels (badge, timeline title).
// Matches generate-proposal.js:141.
function primaryCampaign(campaigns) {
  if (!campaigns || !campaigns.length) return 'annual';
  if (campaigns.indexOf('annual') !== -1) return 'annual';
  if (campaigns.indexOf('quarterly') !== -1) return 'quarterly';
  return 'monthly';
}

function formatDateForProposal(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch (_) {
    return '';
  }
}

// ─── Finding classification + sort ────────────────────────────────
//
// Each *_findings blob in proposal_content is a flat string of sibling
// <div class="finding"><span class="finding-icon">ICON</span><div>...</div></div>
// blocks. Two icon conventions are in the wild (checked across Margot,
// Edward, Ray, Steve): emoji-based (current) and class-based (older).
// The classifier accepts either signal. When neither is present we fall
// back to 'warning' — the middle severity is the least-surprising default.
//
// Splitting uses a lookahead on the opening tag so each piece is a complete
// <div class="finding">...</div>. Only works because findings are strictly
// flat (no nesting). generate-proposal.js has always emitted them that way;
// if that convention ever changes, update the split strategy here.

var SEV_ORDER = { critical: 0, warning: 1, good: 2 };

function classifyFinding(html) {
  if (!html) return 'warning';
  // Class-based (older conventions) — check first, more specific.
  if (/finding-icon[^"]*(?:danger|critical)/i.test(html)) return 'critical';
  if (/finding-icon[^"]*warning/i.test(html))             return 'warning';
  if (/finding-icon[^"]*success/i.test(html))             return 'good';
  // Emoji-based (current conventions).
  //   \u274c ❌  |  \ud83d\udd34 🔴   → critical
  //   \u26a0  ⚠   (with or without \ufe0f variation selector) → warning
  //   \u2705 ✅  |  \u2714 ✔  |  \u2713 ✓   → good
  if (html.indexOf('\u274c') !== -1 || html.indexOf('\ud83d\udd34') !== -1) return 'critical';
  if (html.indexOf('\u26a0') !== -1)                                         return 'warning';
  if (html.indexOf('\u2705') !== -1 || html.indexOf('\u2714') !== -1 || html.indexOf('\u2713') !== -1) return 'good';
  return 'warning';
}

function analyzeAndSortFindings(blob) {
  var empty = { html: '', critical: 0, warning: 0, good: 0 };
  if (!blob || typeof blob !== 'string') return empty;
  var parts = blob.split(/(?=<div class="finding"[^>]*>)/);
  var findings = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].trim().length === 0) continue;
    findings.push({ html: parts[i], sev: classifyFinding(parts[i]) });
  }
  findings.sort(function(a, b) { return SEV_ORDER[a.sev] - SEV_ORDER[b.sev]; });
  var counts = { critical: 0, warning: 0, good: 0 };
  var sortedHtml = '';
  for (var j = 0; j < findings.length; j++) {
    counts[findings[j].sev]++;
    sortedHtml += findings[j].html;
  }
  return { html: sortedHtml, critical: counts.critical, warning: counts.warning, good: counts.good };
}

// ─── handler ───────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  var slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'valid slug required' });
  }

  var requestedVersion = null;
  if (req.query.v !== undefined && req.query.v !== '') {
    var parsedV = parseInt(String(req.query.v), 10);
    if (!Number.isInteger(parsedV) || parsedV < 1) {
      return res.status(400).json({ error: 'invalid version number' });
    }
    requestedVersion = parsedV;
  }

  // Non-blocking admin check for ?v=N. Silently downgrades to active on failure.
  if (requestedVersion !== null) {
    var token = auth.extractToken(req);
    var isAdmin = false;
    if (token) {
      try {
        var payload = await auth.verifyJwt(token);
        if (payload && payload.sub) {
          var profile = await sb.one(
            'admin_profiles?id=eq.' + encodeURIComponent(payload.sub) + '&select=id&limit=1'
          );
          if (profile) isAdmin = true;
        }
      } catch (_) { /* silent */ }
    }
    if (!isAdmin) requestedVersion = null;
  }

  // Contact lookup
  var contact;
  try {
    contact = await sb.one(
      'contacts?slug=eq.' + encodeURIComponent(slug) +
      '&select=' + SAFE_CONTACT_COLUMNS + '&limit=1'
    );
  } catch (e) {
    monitor.logError('public-proposal', e, {
      client_slug: slug, detail: { stage: 'contact_lookup' }
    });
    return res.status(500).json({ error: 'lookup failed' });
  }
  if (!contact) return res.status(404).json({ error: 'not found' });

  // Proposal lookup
  var proposal;
  try {
    proposal = await sb.one(
      'proposals?contact_id=eq.' + encodeURIComponent(contact.id) +
      '&select=' + SAFE_PROPOSAL_COLUMNS + '&limit=1'
    );
  } catch (e) {
    monitor.logError('public-proposal', e, {
      client_slug: slug, detail: { stage: 'proposal_lookup', contact_id: contact.id }
    });
    return res.status(500).json({ error: 'lookup failed' });
  }
  if (!proposal) return res.status(404).json({ error: 'not found' });

  // Version lookup
  var version = null;
  try {
    if (requestedVersion !== null) {
      version = await sb.one(
        'proposal_versions?contact_id=eq.' + encodeURIComponent(contact.id) +
        '&version_number=eq.' + requestedVersion +
        '&select=' + SAFE_VERSION_COLUMNS + '&limit=1'
      );
    } else if (proposal.active_version_id) {
      version = await sb.one(
        'proposal_versions?id=eq.' + encodeURIComponent(proposal.active_version_id) +
        '&select=' + SAFE_VERSION_COLUMNS + '&limit=1'
      );
    }
  } catch (e) {
    monitor.logError('public-proposal', e, {
      client_slug: slug, detail: { stage: 'version_lookup', requested: requestedVersion }
    });
    return res.status(500).json({ error: 'lookup failed' });
  }
  if (!version) return res.status(404).json({ error: 'not found' });

  // Practice type for results section. NULL is common — default to 'group'.
  var practiceType = 'group';
  try {
    var pd = await sb.one(
      'practice_details?contact_id=eq.' + encodeURIComponent(contact.id) +
      '&select=practice_type&limit=1'
    );
    if (pd && pd.practice_type) practiceType = pd.practice_type;
  } catch (_) { /* non-fatal */ }

  // Render server-side helpers. Pricing fetched fresh each view so
  // /admin/pricing edits propagate without regenerating proposals.
  var campaigns = Array.isArray(proposal.campaign_lengths) && proposal.campaign_lengths.length
    ? proposal.campaign_lengths
    : ['annual'];
  var tierPrices = await fetchTierPrices();
  var pCampaign  = primaryCampaign(campaigns);

  // Sort findings by severity (critical → warning → good) and tally counts
  // per pillar. The sorted HTML is mutated back into version.proposal_content
  // in memory — the template's data-hydrate-html paths then serve sorted
  // content without needing a new path. Counts go into rendered.pillar_counts
  // for the collapsible-toggle badges.
  var pillar_counts = {};
  ['credibility','optimization','reputation','engagement'].forEach(function(p) {
    var key = p + '_findings';
    var result = analyzeAndSortFindings(version.proposal_content && version.proposal_content[key]);
    if (version.proposal_content) version.proposal_content[key] = result.html;
    pillar_counts[p] = { critical: result.critical, warning: result.warning, good: result.good };
  });

  var rendered = {
    badge_text:            CAMPAIGN_DISPLAY[pCampaign] || CAMPAIGN_DISPLAY.annual,
    timeline_title:        'Your ' + (TIMELINE_LABEL[pCampaign] || TIMELINE_LABEL.annual) + ' Roadmap',
    timeline_intro:        'Here is exactly what happens from the moment you say go. We handle the heavy lifting - your time commitment is roughly 6-8 hours in month one (mostly the onboarding call and content review), then significantly less after that.',
    date:                  formatDateForProposal(version.generated_at),
    investment_cards_html: buildInvestmentCardsHtml(slug, campaigns, proposal.custom_pricing, tierPrices),
    guarantee_box_html:    buildGuaranteeBoxHtml(campaigns),
    results_section_html:  buildResultsSectionHtml(practiceType),
    pillar_counts:         pillar_counts
  };

  var safeContact = {
    slug: contact.slug,
    first_name: contact.first_name,
    last_name: contact.last_name,
    credentials: contact.credentials,
    practice_name: contact.practice_name,
    city: contact.city,
    state_province: contact.state_province
  };

  if (requestedVersion === null) {
    res.setHeader('Cache-Control', 'public, max-age=30');
  } else {
    res.setHeader('Cache-Control', 'private, no-store');
  }

  return res.status(200).json({
    contact: safeContact,
    proposal: {
      status: proposal.status,
      campaign_lengths: campaigns,
      billing_options: proposal.billing_options || [],
      custom_pricing: proposal.custom_pricing || null,
      checkout_url: proposal.checkout_url || ('/' + slug + '/checkout'),
      version_count: proposal.version_count
    },
    version: {
      version_number: version.version_number,
      generated_at: version.generated_at,
      retired_at: version.retired_at,
      content: version.proposal_content
    },
    rendered: rendered
  });
};
