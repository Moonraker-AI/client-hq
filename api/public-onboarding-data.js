// /api/public-onboarding-data.js
// Consolidated read endpoint for the /<slug>/onboarding client page.
//
// Replaces the six direct anon /rest/v1 reads the template used to fire in a
// Promise.all (onboarding_steps, signed_agreements, practice_details,
// bio_materials, social_platforms, directory_listings) plus the separate
// /api/public-contact lookup — now one round trip, page-token gated, service
// role on the backend so no anon SELECT policies are involved at all.
//
// Precedent: api/public-contact.js (commit f783054042a2). Adds page-token
// verification + slug-binding check — the onboarding surface contains
// signer names, signature images, NPI, and business-sensitive practice
// details, so the read path gets the same defense-in-depth the writes
// (/api/onboarding-action) already have.
//
// Request:   GET /api/public-onboarding-data?slug=<slug>
//            Cookie: mr_pt_onboarding=<HMAC token, scope=onboarding>
// Response:  200 { contact, onboarding_steps, signed_agreement,
//                  practice_details, bio_materials, social_platforms,
//                  directory_listings }
//            401  page-token missing / expired
//            403  slug does not match contact_id bound to the token
//            404  contact not found
//            500  infra or DB error (logged via monitor)

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var pageToken = require('./_lib/page-token');
var publicContact = require('./public-contact');

// Contact columns returned here. Mirror public-contact.SAFE_COLUMNS so
// removing the separate /api/public-contact call from the onboarding template
// is behaviour-preserving. `lost` is now in SAFE_COLUMNS directly (was an
// onboarding-only override until 2026-04-22).
var CONTACT_COLUMNS = publicContact.SAFE_COLUMNS;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'Auth system not configured' });

  var slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'valid slug required' });
  }

  // ── 1. Page-token cookie required ────────────────────────────────
  var token = pageToken.getTokenFromRequest(req, 'onboarding');
  if (!token) return res.status(401).json({ error: 'Page token required' });

  var tokenData;
  try {
    tokenData = pageToken.verify(token, 'onboarding');
  } catch (e) {
    // PAGE_TOKEN_SECRET misconfigured — 500, not 401. Caller retrying won't help.
    await monitor.logError('public-onboarding-data', e, { client_slug: slug, detail: { stage: 'token_verify' } });
    return res.status(500).json({ error: 'Auth system unavailable' });
  }
  if (!tokenData) return res.status(401).json({ error: 'Invalid or expired page token' });

  // ── 2. Contact lookup + slug binding ─────────────────────────────
  var contact;
  try {
    contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=' + CONTACT_COLUMNS + '&limit=1');
  } catch (e) {
    await monitor.logError('public-onboarding-data', e, { client_slug: slug, detail: { stage: 'contact_lookup' } });
    return res.status(500).json({ error: 'lookup failed' });
  }
  if (!contact) return res.status(404).json({ error: 'contact not found' });

  // A token issued for client A must not be replayable on /B/onboarding.
  // The HMAC binds {contact_id, scope, exp} — not slug — so the endpoint
  // has to enforce the (slug → contact_id) match.
  if (contact.id !== tokenData.contact_id) {
    return res.status(403).json({ error: 'Page token not valid for this client' });
  }

  // ── 3. Parallel dataset reads ────────────────────────────────────
  // Service role bypasses RLS — the page-token + slug-binding above are the
  // access gate. Every query is still scoped to contact.id, so even a caller
  // that somehow bypassed the gate cannot pull another client's rows.
  var cid = encodeURIComponent(contact.id);
  var results;
  try {
    results = await Promise.all([
      sb.query('onboarding_steps?contact_id=eq.' + cid + '&select=step_key,status&order=sort_order'),
      sb.query('signed_agreements?contact_id=eq.' + cid + '&agreement_type=eq.csa&select=signer_name,signed_at,signature_image&order=signed_at.desc&limit=1'),
      sb.query('practice_details?contact_id=eq.' + cid + '&select=*&limit=1'),
      sb.query('bio_materials?contact_id=eq.' + cid + '&select=*&order=is_primary.desc,sort_order'),
      sb.query('social_platforms?contact_id=eq.' + cid + '&select=platform,profile_url,status'),
      sb.query('directory_listings?contact_id=eq.' + cid + '&select=directory,profile_url,status')
    ]);
  } catch (e) {
    await monitor.logError('public-onboarding-data', e, { client_slug: slug, detail: { stage: 'parallel_reads' } });
    return res.status(500).json({ error: 'data load failed' });
  }

  // ── 4. Response shape ────────────────────────────────────────────
  // Single-row collections are unwrapped so the frontend doesn't carry the
  // old limit=1-array-indexing pattern into the new code. Autosave writes
  // from the same session will mutate these rows mid-page, so no caching.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    contact: contact,
    onboarding_steps: results[0] || [],
    signed_agreement: (results[1] && results[1][0]) || null,
    practice_details: (results[2] && results[2][0]) || null,
    bio_materials: results[3] || [],
    social_platforms: results[4] || [],
    directory_listings: results[5] || []
  });
};
