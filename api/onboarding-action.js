// /api/onboarding-action.js
// Client-facing action route for onboarding pages.
// Authenticates via page_token (not admin JWT); service role key is the
// write identity but the page_token gate and verified contact_id below
// constrain what any given request can touch. See security model below.
//
// Security model (post-Phase-4-session-2):
//   1. Every request MUST carry a page_token that verifies under scope='onboarding'.
//   2. The token's contact_id is the sole source of truth for which rows may be
//      touched. Any contact_id in filters or data from the request body is
//      overridden with the verified value — a prospect cannot modify another
//      prospect's data by swapping the UUID in their request body.
//   3. The contact's status must be 'onboarding' or 'active'. Active clients
//      retain write access to their profile fields via this surface after
//      auto-promotion. Prospects/leads are blocked (page is locked until they
//      pay). lost=true is rejected in all cases.

var sb = require('./_lib/supabase');
var pageToken = require('./_lib/page-token');
var pgFilter = require('./_lib/postgrest-filter');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Service not configured' });

  try {
    var body = req.body || {};
    var action = body.action;
    var table = body.table;
    var filters = body.filters;
    var data = body.data;
    var submittedToken = pageToken.getTokenFromRequest(req, 'onboarding');

    if (!action || !table) return res.status(400).json({ error: 'action and table required' });

    // ── 1. Verify page token ────────────────────────────────────
    if (!submittedToken) {
      return res.status(403).json({ error: 'Page token required' });
    }
    var tokenData;
    try {
      tokenData = pageToken.verify(submittedToken, 'onboarding');
    } catch (e) {
      // Thrown only when PAGE_TOKEN_SECRET is not configured — surface as 500
      // so it's visible in logs, not as an auth error the client could mistake
      // for a token problem.
      console.error('[onboarding-action] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) {
      return res.status(403).json({ error: 'Invalid or expired page token' });
    }
    var verifiedContactId = tokenData.contact_id;

    // ── 2. Enforce action/table allowlists ──────────────────────
    var allowedTables = ['practice_details', 'bio_materials', 'social_platforms', 'directory_listings', 'contacts', 'signed_agreements', 'onboarding_steps'];
    if (allowedTables.indexOf(table) === -1) return res.status(400).json({ error: 'Table not allowed' });

    // Contacts updates are restricted to a narrow field set so the onboarding
    // page can save form fields but cannot flip status, change slug, or touch
    // any server-internal column. create/delete are blocked entirely for contacts.
    var CONTACT_WRITE_ALLOWLIST = [
      'first_name', 'last_name', 'credentials', 'email', 'phone',
      'practice_name', 'legal_business_name', 'website_url', 'team_size',
      'service_delivery', 'practice_address_line1', 'practice_address_line2',
      'city', 'state_province', 'postal_code', 'country', 'time_zone',
      'npi_number', 'platforms_to_omit', 'gbp_url',
      'agreement_signed', 'agreement_signed_at'
    ];
    if (table === 'contacts') {
      if (action !== 'update_record') return res.status(400).json({ error: 'Only update_record allowed on contacts' });
      if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data required' });
      var stray = Object.keys(data).filter(function(k) { return CONTACT_WRITE_ALLOWLIST.indexOf(k) === -1; });
      if (stray.length > 0) return res.status(400).json({ error: 'Disallowed contacts fields: ' + stray.join(',') });
    }

    // onboarding_steps is update-only through this surface. The client-facing
    // flow flips individual step rows to 'complete'/'in_progress'/'skipped'
    // with an optional notes string. Rows are seeded server-side (convert-to-
    // prospect, bulk seed) so create is never needed here; delete is never
    // legitimate from a client. contact_id is forced below from the verified
    // page-token so cross-client writes are impossible even if filters lied.
    // The DB has its own CHECK constraint on status ('pending','in_progress',
    // 'complete','skipped') so a rogue value returns 4xx from PostgREST.
    var ONBOARDING_STEPS_WRITE_ALLOWLIST = ['status', 'completed_at', 'notes'];
    if (table === 'onboarding_steps') {
      if (action !== 'update_record') return res.status(400).json({ error: 'Only update_record allowed on onboarding_steps' });
      if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data required' });
      var strayOs = Object.keys(data).filter(function(k) { return ONBOARDING_STEPS_WRITE_ALLOWLIST.indexOf(k) === -1; });
      if (strayOs.length > 0) return res.status(400).json({ error: 'Disallowed onboarding_steps fields: ' + strayOs.join(',') });
    }

    // signed_agreements is create-only through this surface. The onboarding
    // page writes one CSA row when the client signs; everything else (read,
    // update, delete) goes through admin paths. contact_id is forced below
    // from the verified page-token; ip_address and user_agent are populated
    // server-side from request headers and cannot be set by the client.
    var SIGNED_AGREEMENTS_WRITE_ALLOWLIST = [
      'agreement_type', 'agreement_version', 'document_html',
      'signer_name', 'signer_email', 'signer_title', 'signed_at',
      'signature_image', 'plan_details'
    ];
    if (table === 'signed_agreements') {
      if (action !== 'create_record') return res.status(400).json({ error: 'Only create_record allowed on signed_agreements' });
      if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data required' });
      var strayAgr = Object.keys(data).filter(function(k) { return SIGNED_AGREEMENTS_WRITE_ALLOWLIST.indexOf(k) === -1; });
      if (strayAgr.length > 0) return res.status(400).json({ error: 'Disallowed signed_agreements fields: ' + strayAgr.join(',') });
    }

    var allowedActions = ['create_record', 'update_record', 'delete_record'];
    if (allowedActions.indexOf(action) === -1) return res.status(400).json({ error: 'Action not allowed' });

    // ── 3. Defense-in-depth: contact must be onboarding or active, not lost ─
    var contactCheck = await sb.query('contacts?select=id,slug,status,lost&id=eq.' + encodeURIComponent(verifiedContactId) + '&limit=1');
    if (!contactCheck || contactCheck.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    // 3a. Slug binding: if the request provided a slug (body.slug), it must
    // match the verified contact's slug. The cookie is now Path=/ so delivery
    // is not path-scoped; slug enforcement happens here.
    if (body.slug && !pageToken.assertSlugBinding(body.slug, contactCheck[0].slug)) {
      return res.status(403).json({ error: 'Page token not valid for this client' });
    }
    if (contactCheck[0].lost) {
      return res.status(403).json({ error: 'Contact is no longer active' });
    }
    if (['onboarding', 'active'].indexOf(contactCheck[0].status) === -1) {
      return res.status(403).json({ error: 'Contact not in a valid state for edits' });
    }

    // ── 4. Override contact_id with verified value ──────────────
    // Never trust contact_id from the request body. On updates/deletes we
    // force a WHERE contact_id=verified clause; on creates we force the row's
    // contact_id column. If the client's row lookup (id=X) points to another
    // contact's data, the extra contact_id filter ensures 0 rows are touched.
    if (action === 'create_record') {
      data = data || {};
      data.contact_id = verifiedContactId;
      // signed_agreements: populate audit fields server-side so the client
      // cannot forge them. ip_address comes from x-forwarded-for (trusted
      // via Vercel edge); user_agent comes from the request header.
      if (table === 'signed_agreements') {
        var xff = (req.headers['x-forwarded-for'] || '').toString();
        var ip = xff.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || null;
        data.ip_address = ip;
        data.user_agent = (req.headers['user-agent'] || '').toString().slice(0, 1024) || null;
      }
    } else {
      // update_record or delete_record
      filters = filters || {};
      if (table === 'contacts') {
        // contacts has no contact_id column; its PK is `id`. Force the
        // filter to target the verified contact's own row regardless of
        // what the client sent (prevents patching another contact's row).
        filters.id = verifiedContactId;
        delete filters.contact_id;
      } else {
        filters.contact_id = verifiedContactId;
      }
    }

    var baseUrl = sb.url() + '/rest/v1/' + table;
    var headers = sb.headers('return=representation');

    if (action === 'create_record') {
      var r = await fetch(baseUrl, { method: 'POST', headers: headers, body: JSON.stringify(data) });
      var result = await r.json();
      if (!r.ok) { console.error('onboarding create error:', JSON.stringify(result)); return res.status(r.status).json({ error: 'Database write failed' }); }
      return res.status(201).json({ success: true, action: 'created', data: result });
    }

    if (action === 'update_record') {
      if (!data) return res.status(400).json({ error: 'data required' });
      var fp;
      try { fp = pgFilter.buildFilter(filters); }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }
      var r2 = await fetch(baseUrl + '?' + fp, { method: 'PATCH', headers: headers, body: JSON.stringify(data) });
      var result2 = await r2.json();
      if (!r2.ok) { console.error('onboarding update error:', JSON.stringify(result2)); return res.status(r2.status).json({ error: 'Database update failed' }); }
      return res.status(200).json({ success: true, action: 'updated', data: result2 });
    }

    if (action === 'delete_record') {
      var fp2;
      try { fp2 = pgFilter.buildFilter(filters); }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }
      var r3 = await fetch(baseUrl + '?' + fp2, { method: 'DELETE', headers: headers });
      if (!r3.ok) return res.status(r3.status).json({ error: 'Database error' });
      return res.status(200).json({ success: true, action: 'deleted' });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Onboarding action error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
