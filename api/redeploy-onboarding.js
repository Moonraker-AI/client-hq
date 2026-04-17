// /api/redeploy-onboarding.js
// Admin-authed endpoint to redeploy a single client's onboarding page.
// Used for existing prospect/onboarding clients whose deployed HTML predates
// the Phase 4 Session 2 PAGE_TOKEN injection — running this on each of them
// re-signs a scope=onboarding token, fills the template, and pushes the HTML.
//
// POST { contact_id }
// Requires admin JWT.
//
// Why this exists instead of reusing /api/generate-proposal for onboarding
// clients: generate-proposal would regenerate the whole proposal and re-seed
// onboarding steps etc., which is wrong for clients already in onboarding.
// This endpoint only touches /{slug}/onboarding/index.html.

var auth = require('./_lib/auth');
var sb = require('./_lib/supabase');
var gh = require('./_lib/github');
var pageToken = require('./_lib/page-token');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'Supabase not configured' });
  if (!gh.isConfigured()) return res.status(500).json({ error: 'GitHub not configured' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'PAGE_TOKEN_SECRET not configured' });

  var contactId = (req.body || {}).contact_id;
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  // Look up the contact; only prospects and onboarding clients are valid targets.
  // Active and lead contacts don't have an onboarding page that would be useful
  // to update (active is past onboarding; lead has no proposal yet).
  var contacts;
  try {
    contacts = await sb.query('contacts?id=eq.' + encodeURIComponent(contactId) + '&select=id,slug,status,lost&limit=1');
  } catch (e) {
    return res.status(500).json({ error: 'Contact lookup failed: ' + e.message });
  }
  if (!contacts || contacts.length === 0) {
    return res.status(404).json({ error: 'Contact not found' });
  }
  var contact = contacts[0];
  if (contact.lost) {
    return res.status(400).json({ error: 'Contact is marked lost — not redeploying' });
  }
  if (contact.status !== 'prospect' && contact.status !== 'onboarding') {
    return res.status(400).json({ error: 'Contact status must be prospect or onboarding (got ' + contact.status + ')' });
  }
  if (!contact.slug) {
    return res.status(400).json({ error: 'Contact has no slug' });
  }

  // Sign a scope=onboarding token. Uses the default 90-day TTL from page-token module.
  var signedToken;
  try {
    signedToken = pageToken.sign({ scope: 'onboarding', contact_id: contact.id });
  } catch (e) {
    return res.status(500).json({ error: 'Token sign failed: ' + e.message });
  }

  // Read the onboarding template and substitute {{PAGE_TOKEN}}.
  var template;
  try {
    template = await gh.readTemplate('onboarding.html');
  } catch (e) {
    return res.status(500).json({ error: 'Template read failed: ' + e.message });
  }
  var filled = template.split('{{PAGE_TOKEN}}').join(signedToken);

  // Push to {slug}/onboarding/index.html. gh.pushFile handles both new-file
  // and existing-file cases (fetches current sha if present).
  var destPath = contact.slug + '/onboarding/index.html';
  try {
    await gh.pushFile(destPath, filled, 'Redeploy onboarding page for ' + contact.slug + ' (Phase 4 token injection)');
  } catch (e) {
    return res.status(500).json({ error: 'Push failed: ' + e.message });
  }

  return res.status(200).json({
    ok: true,
    slug: contact.slug,
    path: destPath,
    status: contact.status
  });
};
