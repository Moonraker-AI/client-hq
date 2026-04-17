// /api/discover-services.js
// Auto-discovers GSC properties and LocalFalcon locations for a client
// Called from admin UI when Intro Call steps are marked complete
//
// POST { client_slug, service: "gsc" | "localfalcon" }
// Returns discovered properties/locations and saves to contact + report_configs

var sb = require('./_lib/supabase');
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
  if (!service || !['gsc', 'localfalcon'].includes(service)) return res.status(400).json({ error: 'service must be "gsc" or "localfalcon"' });

  // Supabase calls via sb helper

  try {
    // Fetch contact
    var contactResp = await fetch(sb.url() + '/rest/v1/contacts?slug=eq.' + clientSlug + '&limit=1', {
      headers: sb.headers()
    });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found: ' + clientSlug });
    var contact = contacts[0];

    // ─── GSC DISCOVERY ───
    if (service === 'gsc') {
      if (!googleSA) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

      // Get access token
      var token;
      try {
        token = await google.getServiceAccountToken('https://www.googleapis.com/auth/webmasters.readonly');
      } catch (tokenErr) {
        return res.status(500).json({ error: 'Google auth failed: ' + (tokenErr.message || String(tokenErr)) });
      }

      // List all sites the service account has access to
      var sitesResp = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var sitesData = await sitesResp.json();
      var allSites = (sitesData.siteEntry || []).map(function(s) {
        return { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel };
      });

      if (allSites.length === 0) {
        return res.status(200).json({ success: true, service: 'gsc', found: false, message: 'Service account has no GSC sites', all_sites: [] });
      }

      // Try to match against client's website domain
      var websiteUrl = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
      var matches = [];

      for (var i = 0; i < allSites.length; i++) {
        var siteUrl = allSites[i].siteUrl;
        var normalizedSite = siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
        if (normalizedSite === websiteUrl || websiteUrl.indexOf(normalizedSite) >= 0 || normalizedSite.indexOf(websiteUrl) >= 0) {
          matches.push(siteUrl);
        }
      }

      // Rank by preference: sc-domain (broadest) > https://www. > https:// > http://
      matches.sort(function(a, b) {
        function rank(url) {
          if (url.startsWith('sc-domain:')) return 0;
          if (url.startsWith('https://www.')) return 1;
          if (url.startsWith('https://')) return 2;
          if (url.startsWith('http://www.')) return 3;
          return 4;
        }
        return rank(a) - rank(b);
      });

      var matched = matches.length > 0 ? matches[0] : null;

      if (matched) {
        // Save to contact record
        await fetch(sb.url() + '/rest/v1/contacts?slug=eq.' + clientSlug, {
          method: 'PATCH',
          headers: sb.headers(),
          body: JSON.stringify({ gsc_property: matched })
        });

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
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


// ─── Helpers ───

async function upsertReportConfig(clientSlug, data) {
  // Check if config exists
  var checkResp = await fetch(sb.url() + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&limit=1', {
    headers: sb.headers()
  });
  var existing = await checkResp.json();

  data.active = true;
  if (existing && existing.length > 0) {
    // Update
    await fetch(sb.url() + '/rest/v1/report_configs?client_slug=eq.' + clientSlug, {
      method: 'PATCH', headers: headers, body: JSON.stringify(data)
    });
  } else {
    // Create
    data.client_slug = clientSlug;
    await fetch(sb.url() + '/rest/v1/report_configs', {
      method: 'POST', headers: headers, body: JSON.stringify(data)
    });
  }
}




