// /api/delete-proposal.js
// Deletes a proposal record and optionally removes deployed pages from GitHub.
//
// POST { proposal_id, delete_pages?: true }
//   - delete_pages: if true, removes /proposal, /checkout, /onboarding, and router pages
//
// ENV VARS: SUPABASE_SERVICE_ROLE_KEY, GITHUB_PAT

var sb = require('./_lib/supabase');
var gh = require('./_lib/github');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body || {};
  var proposalId = body.proposal_id;
  var deletePages = body.delete_pages !== false; // default true

  if (!proposalId) return res.status(400).json({ error: 'proposal_id required' });

  var results = { supabase: null, github: [] };

  // Load proposal + contact
  var proposal, contact;
  try {
    proposal = await sb.one('proposals?id=eq.' + proposalId + '&select=*,contacts(id,slug,status)&limit=1');
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    contact = proposal.contacts;
  } catch (e) {
    monitor.logError('delete-proposal', e, { detail: { stage: 'load_proposal', proposal_id: proposalId } });
    return res.status(500).json({ error: 'Failed to load proposal' });
  }

  var slug = contact.slug;

  // Delete deployed pages from GitHub
  if (deletePages && gh.isConfigured() && slug) {
    var pagesToDelete = [
      slug + '/proposal/index.html',
      slug + '/checkout/index.html',
      slug + '/onboarding/index.html',
      slug + '/index.html'
    ];

    for (var i = 0; i < pagesToDelete.length; i++) {
      var path = pagesToDelete[i];
      try {
        var deleted = await gh.deleteFile(path, null, 'Delete ' + path + ' (proposal deleted)');
        results.github.push({ path: path, ok: !!deleted });
      } catch (e) {
        monitor.logError('delete-proposal', e, {
          client_slug: slug,
          detail: { stage: 'delete_file', path: path }
        });
        results.github.push({ path: path, ok: false, error: 'Delete failed' });
      }
    }
  }

  // Delete proposal from Supabase
  try {
    await sb.mutate('proposals?id=eq.' + proposalId, 'DELETE', null, 'return=minimal');
    results.supabase = 'deleted';
  } catch (e) {
    monitor.logError('delete-proposal', e, {
      client_slug: slug,
      detail: { stage: 'delete_proposal_row', proposal_id: proposalId }
    });
    results.supabase = 'error: delete failed';
  }

  // Reset contact status back to lead if they were only a prospect because of this proposal
  try {
    var others = await sb.query('proposals?contact_id=eq.' + contact.id + '&select=id&limit=1');
    if ((!others || others.length === 0) && contact.status === 'prospect') {
      var resetResult = await sb.mutate('contacts?id=eq.' + contact.id, 'PATCH', { status: 'lead' });
      if (resetResult && resetResult.length > 0) {
        results.contact_reset = 'lead';
      } else {
        results.contact_reset = 'failed — status transition blocked';
      }
    }
  } catch (e) { /* optional */ }

  return res.status(200).json({ ok: true, results: results });
};
