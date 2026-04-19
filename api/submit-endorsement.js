// /api/submit-endorsement.js
// Public-facing endpoint for endorsement submissions from the per-client
// endorsement collection page ({slug}/endorsements/).
//
// Security model (C9 close-out, Phase 4 Session 7):
//   1. Every submission MUST carry a page_token that verifies under
//      scope='endorsement'. The token is baked into the deployed page at
//      deploy time by api/deploy-endorsement-page.js.
//   2. The token's contact_id is the sole source of truth for which client
//      the endorsement is attached to. contact_id/client_slug in the body
//      are ignored — looked up server-side from the verified contact_id.
//   3. Rate limit: 10 submissions / hour / IP. Generous for legitimate
//      multi-submission sessions (endorsers may add 3–5 in a row), tight
//      enough to cap spammers.
//   4. Every text field is passed through sanitizeText() — strips all HTML
//      tags and decodes entities. Endorsement content is plain text only.
//   5. Only certain fields are writable; everything else is ignored. This
//      prevents submitters from setting e.g. status='processed' to skip
//      admin review, or planting arbitrary JSON in endorser_links.
//
// POST body: {
//   page_token: string (required)
//   endorser_name, endorser_title, endorser_org, relationship,
//   source_platform, source_url, content, endorsement_type,
//   bio_material_id (optional), endorser_links (optional)
// }

var sb          = require('./_lib/supabase');
var pageToken   = require('./_lib/page-token');
var rateLimit   = require('./_lib/rate-limit');
var sanitizer   = require('./_lib/html-sanitizer');

// Maximum field lengths — generous, but capped to avoid DB bloat and email
// render pathologies. `content` is the full endorsement text.
var LIMITS = {
  endorser_name:    200,
  endorser_title:   200,
  endorser_org:     200,
  relationship:     200,
  source_platform:  50,
  source_url:       1000,
  content:          10000,
  endorsement_type: 50
};

// Allowlist of source_platform values — rejects anything else. The form's
// <select> offers these; anyone sending a different value is bypassing the UI.
var ALLOWED_PLATFORMS = [
  'google','psychology_today','therapy_den','linkedin','facebook',
  'website','email','referral','other',''
];

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', 'https://clients.moonraker.ai');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Origin check — endorsement page is served from clients.moonraker.ai.
  var origin = req.headers.origin || '';
  if (origin && origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!sb.isConfigured())          return res.status(500).json({ error: 'Service not configured' });
  if (!pageToken.isConfigured())   return res.status(500).json({ error: 'PAGE_TOKEN_SECRET not configured' });

  var body = req.body || {};

  // ── 1. Verify page token ─────────────────────────────────────────
  var submittedToken = pageToken.getTokenFromRequest(req, 'endorsement');
  if (!submittedToken) {
    return res.status(403).json({ error: 'Page token required' });
  }
  var tokenData;
  try {
    tokenData = pageToken.verify(submittedToken, 'endorsement');
  } catch (e) {
    console.error('[submit-endorsement] page-token verify error:', e.message);
    return res.status(500).json({ error: 'Token verification unavailable' });
  }
  if (!tokenData) {
    return res.status(403).json({ error: 'Invalid or expired page token' });
  }
  var contactId = tokenData.contact_id;

  // ── 2. Rate limit: 10/hour per IP ────────────────────────────────
  // Fail-closed: if the rate-limit store is unreachable, we'd rather deny
  // legitimate submitters for a few seconds than let a spammer through.
  var ip = rateLimit.getIp(req);
  var rl = await rateLimit.check('ip:' + ip + ':submit-endorsement', 10, 3600);
  rateLimit.setHeaders(res, rl, 10);
  if (!rl.allowed) {
    if (rl.reset_at) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rl.reset_at - new Date()) / 1000))));
    }
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  // ── 3. Look up contact (proves token's contact_id is real + gets slug) ──
  // We never trust client_slug from the body — derive it from contact_id.
  var contactRows;
  try {
    contactRows = await sb.query(
      'contacts?id=eq.' + encodeURIComponent(contactId) +
      '&select=id,slug,status&limit=1'
    );
  } catch (e) {
    return res.status(500).json({ error: 'Lookup failed' });
  }
  if (!contactRows || contactRows.length === 0) {
    return res.status(403).json({ error: 'Contact not found' });
  }
  var contact = contactRows[0];

  // The prior anon RLS only allowed inserts for prospect/onboarding/active
  // contacts. Preserve that — there's no reason to collect endorsements for
  // leads (no campaign yet) or lost clients.
  if (['prospect','onboarding','active'].indexOf(contact.status) === -1) {
    return res.status(403).json({ error: 'Endorsements not enabled for this account' });
  }

  // ── 4. Validate + sanitize text fields ──────────────────────────
  var clean = {};
  clean.endorser_name    = sanitizer.sanitizeText(body.endorser_name,    LIMITS.endorser_name);
  clean.endorser_title   = sanitizer.sanitizeText(body.endorser_title,   LIMITS.endorser_title);
  clean.endorser_org     = sanitizer.sanitizeText(body.endorser_org,     LIMITS.endorser_org);
  clean.relationship     = sanitizer.sanitizeText(body.relationship,     LIMITS.relationship);
  clean.content          = sanitizer.sanitizeText(body.content,          LIMITS.content);
  clean.source_url       = sanitizer.sanitizeText(body.source_url,       LIMITS.source_url);
  clean.source_platform  = sanitizer.sanitizeText(body.source_platform,  LIMITS.source_platform).toLowerCase();
  clean.endorsement_type = sanitizer.sanitizeText(body.endorsement_type, LIMITS.endorsement_type).toLowerCase();

  // Required fields
  if (!clean.endorser_name) {
    return res.status(400).json({ error: 'Endorser name is required.' });
  }
  if (!clean.content) {
    return res.status(400).json({ error: 'Endorsement text is required.' });
  }
  if (clean.content.length < 10) {
    return res.status(400).json({ error: 'Endorsement text is too short.' });
  }

  // Source platform allowlist
  if (clean.source_platform && ALLOWED_PLATFORMS.indexOf(clean.source_platform) === -1) {
    clean.source_platform = 'other';
  }

  // source_url — if present, must look like a URL (http/https only).
  if (clean.source_url) {
    if (!/^https?:\/\/[^\s]{3,}$/.test(clean.source_url)) {
      clean.source_url = null;  // silently drop malformed URLs rather than 400
    }
  } else {
    clean.source_url = null;
  }

  // endorser_links — structured object, one URL per platform. Validate each.
  var safeLinks = null;
  if (body.endorser_links && typeof body.endorser_links === 'object') {
    safeLinks = {};
    var keys = ['website','psychology_today','linkedin','other'];
    keys.forEach(function(k) {
      var v = body.endorser_links[k];
      if (!v) return;
      v = sanitizer.sanitizeText(v, 1000);
      if (/^https?:\/\/[^\s]{3,}$/.test(v)) safeLinks[k] = v;
    });
    if (Object.keys(safeLinks).length === 0) safeLinks = null;
  }

  // bio_material_id — optional UUID, must belong to this contact if provided.
  var bioMaterialId = null;
  if (body.bio_material_id) {
    var candidate = String(body.bio_material_id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
      return res.status(400).json({ error: 'Invalid bio_material_id' });
    }
    try {
      var bmRows = await sb.query(
        'bio_materials?id=eq.' + encodeURIComponent(candidate) +
        '&contact_id=eq.' + encodeURIComponent(contactId) +
        '&select=id&limit=1'
      );
      if (bmRows && bmRows.length > 0) {
        bioMaterialId = candidate;
      } else {
        // Silently drop — a bio-material-id mismatch usually means stale UI;
        // the endorsement still has value without the clinician attribution.
        bioMaterialId = null;
      }
    } catch (e) { bioMaterialId = null; }
  }

  // ── 5. Insert ────────────────────────────────────────────────────
  var insertData = {
    contact_id:        contactId,                 // from token, not body
    client_slug:       contact.slug,              // from DB, not body
    bio_material_id:   bioMaterialId,
    endorser_name:     clean.endorser_name,
    endorser_title:    clean.endorser_title   || null,
    endorser_org:      clean.endorser_org     || null,
    relationship:      clean.relationship     || null,
    source_platform:   clean.source_platform  || null,
    source_url:        clean.source_url,
    content:           clean.content,
    endorsement_type:  clean.endorsement_type || 'other',
    endorser_links:    safeLinks,
    status:            'submitted'               // always starts submitted; admin flips
  };

  try {
    var rows = await sb.mutate('endorsements', 'POST', insertData);
    var row = Array.isArray(rows) ? rows[0] : rows;
    return res.status(201).json({
      success: true,
      id: row ? row.id : null
    });
  } catch (e) {
    console.error('[submit-endorsement] insert failed:', e.message);
    return res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
};
