// /api/page-token/request.js
// Mints a scoped HttpOnly cookie for the current client-facing page.
//
// Clean-cutover replacement for the baked-in window.__PAGE_TOKEN__ pattern.
// Flow:
//   1. Page loads — deployed HTML has no token anywhere
//   2. Page JS calls POST /api/page-token/request { slug, scope }
//   3. Server verifies the slug matches a real contact, signs a token bound to
//      that contact + scope, and sets an HttpOnly cookie path-scoped to /<slug>
//   4. Subsequent writes (onboarding-action, submit-endorsement, progress-update,
//      campaign-summary-chat, proposal-chat) read the cookie via
//      pageToken.getTokenFromRequest — never JavaScript-reachable.
//
// Security notes:
//   - This endpoint does NOT gate on existing tokens. Anyone who can reach
//     /<slug>/onboarding can already write today (the old token was embedded
//     in HTML). Moving from "baked-in token" to "cookie issued on page load"
//     is not a net regression, and it eliminates XSS-driven token theft.
//   - Rate-limited per IP+slug+scope to prevent automated enumeration / abuse.
//   - Cookie is path-scoped to /<slug> so one client's cookie cannot be sent
//     to another client's request.

var pageToken = require('../_lib/page-token');
var sb = require('../_lib/supabase');
var rateLimit = require('../_lib/rate-limit');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'PAGE_TOKEN_SECRET not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });

  var body = req.body || {};
  var slug = String(body.slug || '').trim().toLowerCase();
  var scope = String(body.scope || '').trim();

  if (!slug) return res.status(400).json({ error: 'slug required' });
  if (!scope || pageToken.SCOPES.indexOf(scope) === -1) {
    return res.status(400).json({ error: 'valid scope required', allowed: pageToken.SCOPES });
  }
  // Slug must be a safe identifier — prevents cookie-path injection and also
  // narrows the Supabase query to the expected shape.
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug format' });

  // Per-IP + slug + scope rate limit. Generous enough for legitimate users
  // (5 per 10s) but tight enough to block scripted enumeration.
  var ip = (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || 'unknown';
  try {
    var rlKey = 'pt-request:ip:' + ip + ':' + slug + ':' + scope;
    var rl = await rateLimit.check(rlKey, 5, 10, { failClosed: false });
    if (rl && rl.allowed === false) {
      res.setHeader('Retry-After', '10');
      return res.status(429).json({ error: 'Too many requests' });
    }
  } catch (_) { /* never fail-closed on rate-limiter errors */ }

  var contact;
  try {
    contact = await sb.one('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id,slug&limit=1');
  } catch (e) {
    monitor.logError('page-token-request', e, { client_slug: slug, detail: { stage: 'contact_lookup', scope: scope } });
    return res.status(500).json({ error: 'Contact lookup failed' });
  }
  if (!contact) return res.status(404).json({ error: 'unknown slug' });

  var token;
  try {
    token = pageToken.sign({ scope: scope, contact_id: contact.id });
  } catch (e) {
    monitor.logError('page-token-request', e, { client_slug: slug, detail: { stage: 'sign_token', scope: scope } });
    return res.status(500).json({ error: 'Token signing failed' });
  }

  // Emit TWO Set-Cookie headers:
  //   1. A Max-Age=0 clearer for the legacy Path=/<slug> cookie. Before
  //      bc8fd76b (2026-04-20) this endpoint issued cookies with Path=/<slug>.
  //      Per RFC 6265 §5.3, cookie storage is keyed on (name, domain, path),
  //      so the old entry persists in the browser independent of the new
  //      Path=/ cookie we're about to set. Per §5.4, when two cookies share
  //      a name the browser sends both — more-specific path first — and our
  //      readCookie() returns the first match, so the stale Path=/<slug>
  //      token wins verification and every write 401s. This header evicts it.
  //   2. The fresh Path=/ cookie carrying the current token.
  // Node/Vercel honour an array value on Set-Cookie as multiple headers.
  var legacyClear = pageToken.buildLegacyPathClearCookie(scope, slug);
  var freshSet = pageToken.buildSetCookie(scope, slug, token);
  var headers = legacyClear ? [legacyClear, freshSet] : [freshSet];
  res.setHeader('Set-Cookie', headers);
  // No-store so intermediaries can't serve another visitor's Set-Cookie header.
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({ ok: true, scope: scope });
};
