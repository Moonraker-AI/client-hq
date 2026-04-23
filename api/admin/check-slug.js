// api/admin/check-slug.js
// Admin-gated slug-uniqueness probe for the New Client form in
// admin/clients/index.html (line 10051 pre-migration).
//
// The only remaining /rest/v1/ fetch in admin/clients used the anon key to
// probe contacts.slug for uniqueness before creating a new client. That
// surface is admin-only anyway; move it to an admin-gated endpoint so the
// anon key stops being a client-facing concern on that page.
//
// Method:   GET   (405 otherwise, with Allow header)
// Auth:     requireAdmin
// Query:    ?slug=<string>   required, trimmed; rejected if empty
// Returns:  200 [{ id, practice_name }]  (empty array if available; 1-elem
//           array if taken). Shape matches the original anon PostgREST call
//           so the page-side code change is just a URL swap.
//           400 if slug missing / malformed.
//           500 generic 'Lookup failed'.
//
// Rate limit: 30 per admin user.id per 60s (slug check runs on every keystroke
// in the new-client form; keep the ceiling generous enough not to trip legit
// typing).

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var rateLimit = require('../_lib/rate-limit');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var slug = String(req.query && req.query.slug || '').trim();
  if (!slug || !/^[a-z0-9-]{1,100}$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }

  var rl = await rateLimit.check('admin:' + user.id + ':check-slug', 30, 60, { failClosed: false });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  try {
    var rows = await sb.query('contacts?slug=eq.' + encodeURIComponent(slug) + '&select=id,practice_name&limit=1');
    return res.status(200).json(rows || []);
  } catch (err) {
    monitor.logError('admin-check-slug', err, { detail: { slug_len: slug.length } });
    return res.status(500).json({ error: 'Lookup failed' });
  }
};
