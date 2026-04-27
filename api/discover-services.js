// /api/discover-services.js
// Auto-discovers GSC properties and LocalFalcon locations for a client
// Called from admin UI when Intro Call steps are marked complete
//
// POST { client_slug, service: "gsc" | "localfalcon" }
// Returns discovered properties/locations and saves to contact + report_configs

var sb = require('./_lib/supabase');
var monitor = require('./_lib/monitor');
var auth = require('./_lib/auth');
var google = require('./_lib/google-delegated');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;


  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var lfKey = process.env.LOCALFALCON_API_KEY;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var clientSlug = body.client_slug;
  var service = body.service; // "gsc" or "localfalcon"

  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });
  if (!service || !['gsc', 'gbp', 'localfalcon'].includes(service)) return res.status(400).json({ error: 'service must be "gsc", "gbp", or "localfalcon"' });

  // Supabase calls via sb helper

  try {
    // Fetch contact
    var contact = await sb.one('contacts?slug=eq.' + clientSlug + '&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found: ' + clientSlug });

    // ─── GSC DISCOVERY ───
    if (service === 'gsc') {
      if (!googleSA) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

      // Get access token via domain-wide delegation. The direct SA
      // (reporting@moonraker-client-hq.iam.gserviceaccount.com) only sees
      // GSC properties where someone has explicitly granted that SA email
      // user access — which is rarely done in practice. DWD impersonating
      // support@moonraker.ai sees every GSC property our team has been
      // added to via the normal GSC user-management flow, which is what
      // the SEO techs actually do during onboarding. Same scope works for
      // both auth modes; the difference is which identity the call runs as.
      // (Mirrors the auth used in _lib/gsc.js for the daily warehouse cron.)
      var token;
      try {
        token = await google.getDelegatedAccessToken(
          'support@moonraker.ai',
          'https://www.googleapis.com/auth/webmasters.readonly'
        );
      } catch (tokenErr) {
        return res.status(500).json({ error: 'Google auth failed: ' + (tokenErr.message || String(tokenErr)) });
      }

      // List all sites the impersonated user has access to
      var sitesResp = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var sitesData = await sitesResp.json();
      var allSites = (sitesData.siteEntry || []).map(function(s) {
        return { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel };
      });

      if (allSites.length === 0) {
        return res.status(200).json({ success: true, service: 'gsc', found: false, message: 'No GSC sites visible to support@moonraker.ai', all_sites: [] });
      }

      // Match the contact's website domain against the site list.
      // Strategy:
      //   1. Normalize both sides to a bare host (lowercase, strip protocol,
      //      strip www., strip trailing slash, strip sc-domain: prefix).
      //   2. Exact-match the normalized host first — strongest signal.
      //   3. Fall back to "registrable domain" overlap (domain.tld) so we
      //      catch sc-domain:audreylmft.com when the site is www.audreylmft.com.
      // The previous substring search produced false matches when one
      // domain happened to be a substring of another (e.g. "obrien.com"
      // matching "markfarrellobrien.com").
      function normalizeHost(s) {
        return (s || '')
          .replace(/^sc-domain:/, '')
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/\/+$/, '')
          .toLowerCase()
          .trim();
      }
      function registrable(host) {
        // Crude: take the last two labels. Good enough for .com/.ca/.net
        // therapy domains; punts on .co.uk-style multi-part TLDs.
        var parts = host.split('.');
        return parts.slice(-2).join('.');
      }

      var websiteHost = normalizeHost(contact.website_url || '');
      var websiteRegistrable = registrable(websiteHost);
      var matches = [];

      for (var i = 0; i < allSites.length; i++) {
        var siteUrl = allSites[i].siteUrl;
        var siteHost = normalizeHost(siteUrl);
        if (!websiteHost) continue;
        if (siteHost === websiteHost) {
          matches.push({ siteUrl: siteUrl, score: 100 });
        } else if (registrable(siteHost) === websiteRegistrable) {
          matches.push({ siteUrl: siteUrl, score: 50 });
        }
      }

      // Rank: exact host match > registrable match. Within ties, prefer
      // sc-domain (broadest) > https://www. > https:// > http://.
      matches.sort(function(a, b) {
        if (a.score !== b.score) return b.score - a.score;
        function rank(url) {
          if (url.startsWith('sc-domain:')) return 0;
          if (url.startsWith('https://www.')) return 1;
          if (url.startsWith('https://')) return 2;
          if (url.startsWith('http://www.')) return 3;
          return 4;
        }
        return rank(a.siteUrl) - rank(b.siteUrl);
      });

      var matched = matches.length > 0 ? matches[0].siteUrl : null;

      if (matched) {
        // Save to contact record
        await sb.mutate('contacts?slug=eq.' + clientSlug, 'PATCH', { gsc_property: matched });

        // Upsert report_configs
        await upsertReportConfig(clientSlug, { gsc_property: matched });

        return res.status(200).json({
          success: true,
          service: 'gsc',
          found: true,
          property: matched,
          alternatives: matches,
          saved: true,
          message: 'Matched and saved GSC property: ' + matched + (matches.length > 1 ? ' (picked from ' + matches.length + ' matches)' : ''),
          all_sites: allSites.map(function(s) { return s.siteUrl; })
        });
      } else {
        return res.status(200).json({
          success: true,
          service: 'gsc',
          found: false,
          message: 'No matching site found for domain "' + websiteUrl + '". Service account has access to ' + allSites.length + ' sites.',
          all_sites: allSites.map(function(s) { return s.siteUrl; }),
          client_domain: websiteUrl
        });
      }
    }

    // ─── GBP DISCOVERY ───
    // Mirrors GSC: enumerate every location our SA can see via DWD, score
    // matches against the contact's practice profile, auto-pick if confident.
    // Removes the Places API dependency — we never need an authoritative
    // listing search; the only locations we can actually report on are
    // the ones our SA can manage, so that's the universe we search.
    if (service === 'gbp') {
      if (!googleSA) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

      var gbpAccounts = require('./_lib/gbp-accounts');
      var profile = {
        practice_name: contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim(),
        city: contact.city || '',
        state: contact.state || contact.province || ''
      };

      var discovery;
      try {
        discovery = await gbpAccounts.discoverByPracticeProfile(profile);
      } catch (e) {
        monitor.logError('discover-services/gbp', e, { client_slug: clientSlug });
        return res.status(502).json({
          error: 'GBP discovery failed',
          detail: e.message || String(e)
        });
      }

      if (discovery.matched) {
        var pick = discovery.matched;
        // Save numeric location ID to report_configs (what compile-report uses)
        // and mirror the Place ID to contacts for backwards compat.
        await upsertReportConfig(clientSlug, { gbp_location_id: pick.location_id });
        await sb.mutate('contacts?slug=eq.' + clientSlug, 'PATCH', { gbp_place_id: pick.place_id });
        return res.status(200).json({
          success: true,
          service: 'gbp',
          found: true,
          location_id: pick.location_id,
          place_id: pick.place_id,
          location_name: pick.display_name,
          address: pick.address,
          score: pick.score,
          message: 'Auto-matched: ' + pick.display_name + ' (score ' + pick.score + ')',
          // Full candidate list so UI can offer a "wrong match? pick another" picker.
          all_locations: discovery.candidates.map(function(c) {
            return { name: c.display_name, address: c.address, location_id: c.location_id, place_id: c.place_id, score: c.score };
          }),
          total_managed: discovery.total_managed
        });
      } else {
        return res.status(200).json({
          success: true,
          service: 'gbp',
          found: false,
          message: discovery.total_managed === 0
            ? 'Service account has no manageable GBP locations. Practice still needs to grant access.'
            : 'No confident match for "' + profile.practice_name + '" among ' + discovery.total_managed + ' manageable locations.',
          all_locations: discovery.candidates.map(function(c) {
            return { name: c.display_name, address: c.address, location_id: c.location_id, place_id: c.place_id, score: c.score };
          }),
          total_managed: discovery.total_managed
        });
      }
    }

    // ─── LOCALFALCON DISCOVERY ───
    if (service === 'localfalcon') {
      if (!lfKey) return res.status(500).json({ error: 'LOCALFALCON_API_KEY not configured' });

      var practiceName = (contact.practice_name || '').trim();
      var city = (contact.city || '').trim();
      var state = (contact.state || contact.province || '').trim();
      var proximity = [city, state].filter(Boolean).join(', ');

      if (!practiceName) {
        return res.status(400).json({ error: 'Contact has no practice_name set - needed for LocalFalcon search' });
      }

      // Step 1: Check if already in saved locations (by GBP place_id if we have one)
      var gbpPlaceId = contact.google_place_id || null;
      var existingLocation = null;

      if (gbpPlaceId) {
        var checkResp = await fetch('https://api.localfalcon.com/v1/locations/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(gbpPlaceId) + '&limit=5'
        });
        var checkData = await checkResp.json();
        var saved = (checkData.data && checkData.data.locations) || [];
        existingLocation = saved.find(function(l) { return l.place_id === gbpPlaceId; });
      }

      if (existingLocation) {
        // Already saved - just store the place_id on report_configs
        await upsertReportConfig(clientSlug, { localfalcon_place_id: existingLocation.place_id });
        return res.status(200).json({
          success: true,
          service: 'localfalcon',
          found: true,
          place_id: existingLocation.place_id,
          location_name: existingLocation.name,
          already_saved: true,
          saved: true,
          message: 'Location already in LocalFalcon: ' + existingLocation.name
        });
      }

      // Step 2: Search LocalFalcon by name + proximity
      var searchResp = await fetch('https://api.localfalcon.com/v2/locations/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'api_key=' + lfKey + '&name=' + encodeURIComponent(practiceName) + (proximity ? '&proximity=' + encodeURIComponent(proximity) : '')
      });
      var searchData = await searchResp.json();
      var results = (searchData.data && searchData.data.results) || [];

      if (results.length === 0 && searchData.data && searchData.data.true_count > 0) {
        // Location exists but is already saved (LF filters saved locations from search results)
        // Re-check saved locations by name
        var savedResp = await fetch('https://api.localfalcon.com/v1/locations/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(practiceName) + '&limit=10'
        });
        var savedData = await savedResp.json();
        var savedLocs = (savedData.data && savedData.data.locations) || [];
        var nameMatch = savedLocs.find(function(l) {
          return (l.name || '').toLowerCase().indexOf(practiceName.toLowerCase()) >= 0;
        });
        if (nameMatch) {
          await upsertReportConfig(clientSlug, { localfalcon_place_id: nameMatch.place_id });
          return res.status(200).json({
            success: true,
            service: 'localfalcon',
            found: true,
            place_id: nameMatch.place_id,
            location_name: nameMatch.name,
            already_saved: true,
            saved: true,
            message: 'Location already saved in LocalFalcon: ' + nameMatch.name
          });
        }
      }

      if (results.length === 0) {
        return res.status(200).json({
          success: true,
          service: 'localfalcon',
          found: false,
          message: 'No LocalFalcon search results for "' + practiceName + '"' + (proximity ? ' near ' + proximity : ''),
          search_name: practiceName,
          search_proximity: proximity
        });
      }

      // Step 3: Take the best match and add it to the account
      var best = results[0]; // LF returns best match first
      var addResp = await fetch('https://api.localfalcon.com/v2/locations/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'api_key=' + lfKey + '&platform=google&place_id=' + encodeURIComponent(best.place_id)
      });
      var addData = await addResp.json();

      if (!addData.success) {
        return res.status(200).json({
          success: true,
          service: 'localfalcon',
          found: true,
          added: false,
          place_id: best.place_id,
          location_name: best.name,
          message: 'Found but failed to add: ' + (addData.message || 'unknown error'),
          search_results: results.slice(0, 5).map(function(r) { return { place_id: r.place_id, name: r.name, address: r.address }; })
        });
      }

      // Step 4: Save place_id to report_configs
      await upsertReportConfig(clientSlug, { localfalcon_place_id: best.place_id });

      return res.status(200).json({
        success: true,
        service: 'localfalcon',
        found: true,
        added: true,
        saved: true,
        place_id: best.place_id,
        location_name: best.name,
        address: best.address,
        message: 'Added to LocalFalcon and saved: ' + best.name,
        search_results: results.slice(0, 5).map(function(r) { return { place_id: r.place_id, name: r.name, address: r.address }; })
      });
    }

  } catch (err) {
    monitor.logError('discover-services', err, {
      client_slug: clientSlug,
      detail: { stage: 'discover_handler' }
    });
    return res.status(500).json({ error: 'Failed to discover services' });
  }
};


// ─── Helpers ───

async function upsertReportConfig(clientSlug, data) {
  // Check if config exists
  var existing = await sb.query('report_configs?client_slug=eq.' + clientSlug + '&limit=1');

  data.active = true;
  if (existing && existing.length > 0) {
    // Update
    await sb.mutate('report_configs?client_slug=eq.' + clientSlug, 'PATCH', data);
  } else {
    // Create
    data.client_slug = clientSlug;
    await sb.mutate('report_configs', 'POST', data);
  }
}




