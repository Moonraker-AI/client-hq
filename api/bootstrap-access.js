// /api/bootstrap-access.js
// Automates post-Leadsie access setup for a client.
// Once support@moonraker.ai has been granted access to a client's GBP, GA4, and GTM
// via Leadsie, this endpoint uses domain-wide delegation to impersonate support@
// and add the Moonraker team + service account on each platform.
//
// Users added per service:
//   GBP: chris@ + kalyn@ as OWNER, SA as MANAGER
//   GA4: chris@ + kalyn@ as ADMIN (editor), SA as VIEWER
//   GTM: chris@ + kalyn@ as ADMIN (publish), SA as READ
//   LocalFalcon: search + add location to account
//
// POST { client_slug, services: ["gbp","ga4","gtm","localfalcon"] }
//   - Can pass a single service: { client_slug, services: ["gbp"] }
//   - If services omitted, runs all four.
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, LOCALFALCON_API_KEY

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');

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
  var services = body.services || ['gbp', 'ga4', 'gtm', 'localfalcon'];

  if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

  // ─── Team config ───────────────────────────────────────────────
  var SA_EMAIL = 'reporting@moonraker-client-hq.iam.gserviceaccount.com';
  var IMPERSONATE_USER = 'support@moonraker.ai';
  var TEAM_MEMBERS = [
    { email: 'chris@moonraker.ai', name: 'Chris Morin' },
    { email: 'kalyn@moonraker.ai', name: 'Kalyn' }
  ];


  var results = {};
  var errors = [];

  // ─── Load contact ──────────────────────────────────────────────
  var contact;
  try {
    var cResp = await fetch(sb.url() + '/rest/v1/contacts?slug=eq.' + clientSlug + '&select=*&limit=1', { headers: sb.headers() });
    var contacts = await cResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found: ' + clientSlug });
    contact = contacts[0];
  } catch (e) {
    await monitor.logError('bootstrap-access', e, { client_slug: clientSlug, detail: { stage: 'load_contact' } });
    return res.status(500).json({ error: 'Failed to load contact' });
  }

  // ─── Load or create report_configs ─────────────────────────────
  var config;
  try {
    var cfResp = await fetch(sb.url() + '/rest/v1/report_configs?client_slug=eq.' + clientSlug + '&limit=1', { headers: sb.headers() });
    var configs = await cfResp.json();
    if (configs && configs.length > 0) {
      config = configs[0];
    } else {
      var insertResp = await fetch(sb.url() + '/rest/v1/report_configs', {
        method: 'POST', headers: sb.headers(),
        body: JSON.stringify({ client_slug: clientSlug, active: true })
      });
      var inserted = await insertResp.json();
      config = Array.isArray(inserted) ? inserted[0] : inserted;
    }
  } catch (e) {
    await monitor.logError('bootstrap-access', e, { client_slug: clientSlug, detail: { stage: 'load_report_config' } });
    return res.status(500).json({ error: 'Failed to load or create report config' });
  }

  var configUpdates = {};
  var practiceName = contact.practice_name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var websiteDomain = (contact.website_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

  // Helper: add a user and swallow ALREADY_EXISTS
  async function addUserSafe(label, fetchFn) {
    try {
      var resp = await fetchFn();
      var data = await resp.json();
      if (resp.ok) return { added: true };
      if (data.error && (data.error.status === 'ALREADY_EXISTS' || (data.error.message || '').indexOf('already') >= 0)) {
        return { added: true, already_existed: true };
      }
      // Raw provider body stays in logs only; response gets a safe summary.
      console.warn('[bootstrap-access] ' + label + ' add failed', JSON.stringify({ status: resp.status, data: data }).substring(0, 1000));
      return { added: false, error: 'add_failed_http_' + resp.status };
    } catch (e) {
      console.warn('[bootstrap-access] ' + label + ' add threw:', e.message);
      return { added: false, error: 'add_failed' };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GBP: Find location, add team as Owners, SA as Manager
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('gbp')) {
    // Debug strings stay local to this block. They may contain raw Google
    // error bodies and other clients' location titles, so they must NOT be
    // interpolated into thrown error messages or response fields. They are
    // logged via monitor.logError on failure for operator debugging.
    var gbpDebugA = 'not attempted';
    var gbpDebugB = 'not attempted';
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var gbpToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/business.manage');
      if (gbpToken.error) {
        gbpDebugA = 'token error: ' + gbpToken.error;
        throw new Error('Google authentication failed');
      }

      var authH = { 'Authorization': 'Bearer ' + gbpToken, 'Content-Type': 'application/json' };

      // Step 1: Try direct location search (works when support@ has location-level access via Leaisie)
      var matchedLocation = null;
      var matchedAccount = null;

      // Approach A: Search across all accessible locations (wildcard account)
      try {
        var directLocResp = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations?readMask=name,title,websiteUri,storefrontAddress&pageSize=100', { headers: authH });
        if (directLocResp.ok) {
          var directLocData = await directLocResp.json();
          var allLocs = directLocData.locations || [];
          gbpDebugA = 'ok, ' + allLocs.length + ' locations found';

          for (var dli = 0; dli < allLocs.length; dli++) {
            var dloc = allLocs[dli];
            var dTitle = (dloc.title || '').toLowerCase();
            var dWebsite = (dloc.websiteUri || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

            if (practiceName && dTitle.indexOf(practiceName.toLowerCase()) >= 0) { matchedLocation = dloc; break; }
            if (websiteDomain && dWebsite && (dWebsite.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(dWebsite) >= 0)) { matchedLocation = dloc; break; }
          }
          if (!matchedLocation && allLocs.length > 0) {
            gbpDebugA += '. Titles checked: ' + allLocs.slice(0, 5).map(function(l) { return '"' + (l.title || 'untitled') + '"'; }).join(', ');
          }
        } else {
          var errBody = await directLocResp.text();
          gbpDebugA = 'HTTP ' + directLocResp.status + ': ' + errBody.substring(0, 200);
        }
      } catch (e) { gbpDebugA = 'exception: ' + e.message; }

      // Approach B: List accounts then locations (works when support@ has account-level access)
      if (!matchedLocation) {
        var acctResp = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: authH });
        var acctData = await acctResp.json();
        var accounts = acctData.accounts || [];
        gbpDebugB = accounts.length + ' accounts found';
        if (accounts.length > 0) gbpDebugB += ': ' + accounts.map(function(a) { return a.name + ' (' + (a.accountName || 'unnamed') + ')'; }).join(', ');

        for (var ai = 0; ai < accounts.length && !matchedLocation; ai++) {
          var acct = accounts[ai];
          var locResp = await fetch('https://mybusinessbusinessinformation.googleapis.com/v1/' + acct.name + '/locations?readMask=name,title,websiteUri,storefrontAddress', { headers: authH });
          var locData = await locResp.json();
          var locations = locData.locations || [];
          gbpDebugB += ' | ' + acct.name + ': ' + locations.length + ' locations';

          for (var li = 0; li < locations.length; li++) {
            var loc = locations[li];
            var locTitle = (loc.title || '').toLowerCase();
            var locWebsite = (loc.websiteUri || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();

            if (practiceName && locTitle.indexOf(practiceName.toLowerCase()) >= 0) { matchedLocation = loc; matchedAccount = acct; break; }
            if (websiteDomain && locWebsite && (locWebsite.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(locWebsite) >= 0)) { matchedLocation = loc; matchedAccount = acct; break; }
          }
        }
      }

      if (!matchedLocation) throw new Error('No matching GBP location found (check Leadsie access)');

      var locName = matchedLocation.name;
      var gbpLocationId = locName.split('/').pop();

      // Step 3: Add team members as OWNER + SA as MANAGER (all in parallel)
      var gbpAdds = await Promise.all([
        // Team members as OWNER
        addUserSafe('GBP chris', function() {
          return fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
            method: 'POST', headers: authH, body: JSON.stringify({ admin: TEAM_MEMBERS[0].email, role: 'OWNER' })
          });
        }),
        addUserSafe('GBP kalyn', function() {
          return fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
            method: 'POST', headers: authH, body: JSON.stringify({ admin: TEAM_MEMBERS[1].email, role: 'OWNER' })
          });
        }),
        // SA as MANAGER
        addUserSafe('GBP SA', function() {
          return fetch('https://mybusinessaccountmanagement.googleapis.com/v1/' + locName + '/admins', {
            method: 'POST', headers: authH, body: JSON.stringify({ admin: SA_EMAIL, role: 'MANAGER' })
          });
        })
      ]);

      configUpdates.gbp_location_id = gbpLocationId;
      results.gbp = {
        success: true,
        location_name: locName,
        location_title: matchedLocation.title,
        gbp_location_id: gbpLocationId,
        account: matchedAccount && matchedAccount.name,
        users_added: {
          [TEAM_MEMBERS[0].email]: gbpAdds[0],
          [TEAM_MEMBERS[1].email]: gbpAdds[1],
          [SA_EMAIL]: gbpAdds[2]
        }
      };
    } catch (e) {
      await monitor.logError('bootstrap-access', e, {
        client_slug: clientSlug,
        detail: { provider: 'gbp', approachA: gbpDebugA, approachB: gbpDebugB }
      });
      var reason = (e && e.message) || 'GBP bootstrap failed';
      errors.push('GBP: ' + reason);
      results.gbp = { success: false, error: reason };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GA4: Find property, add team as Admin, SA as Viewer
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('ga4')) {
    var ga4DebugToken = null;
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var ga4Token = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/analytics.manage.users');
      if (ga4Token.error) {
        ga4DebugToken = ga4Token.error;
        throw new Error('Google authentication failed');
      }

      var ga4AuthH = { 'Authorization': 'Bearer ' + ga4Token, 'Content-Type': 'application/json' };

      // Find matching property
      var summResp = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', { headers: ga4AuthH });
      var summData = await summResp.json();
      var accountSummaries = summData.accountSummaries || [];

      var matchedProperty = null;
      for (var si = 0; si < accountSummaries.length && !matchedProperty; si++) {
        var propSummaries = accountSummaries[si].propertySummaries || [];
        for (var pi = 0; pi < propSummaries.length; pi++) {
          var ps = propSummaries[pi];
          var propName = (ps.displayName || '').toLowerCase();
          if (practiceName && propName.indexOf(practiceName.toLowerCase()) >= 0) { matchedProperty = ps; break; }
          if (websiteDomain && propName.indexOf(websiteDomain) >= 0) { matchedProperty = ps; break; }
        }
      }

      // Fallback to existing config
      if (!matchedProperty && config.ga4_property) {
        matchedProperty = { property: config.ga4_property.replace('properties/', ''), displayName: config.ga4_property };
      }
      if (!matchedProperty) throw new Error('No matching GA4 property found (check Leadsie access)');

      var propertyResource = matchedProperty.property;
      if (!propertyResource.startsWith('properties/')) propertyResource = 'properties/' + propertyResource;

      // Add team members as ADMIN (editor) + SA as VIEWER (all in parallel)
      var ga4Adds = await Promise.all([
        addUserSafe('GA4 chris', function() {
          return fetch('https://analyticsadmin.googleapis.com/v1alpha/' + propertyResource + '/accessBindings', {
            method: 'POST', headers: ga4AuthH, body: JSON.stringify({ user: TEAM_MEMBERS[0].email, roles: ['predefinedRoles/admin'] })
          });
        }),
        addUserSafe('GA4 kalyn', function() {
          return fetch('https://analyticsadmin.googleapis.com/v1alpha/' + propertyResource + '/accessBindings', {
            method: 'POST', headers: ga4AuthH, body: JSON.stringify({ user: TEAM_MEMBERS[1].email, roles: ['predefinedRoles/admin'] })
          });
        }),
        addUserSafe('GA4 SA', function() {
          return fetch('https://analyticsadmin.googleapis.com/v1alpha/' + propertyResource + '/accessBindings', {
            method: 'POST', headers: ga4AuthH, body: JSON.stringify({ user: SA_EMAIL, roles: ['predefinedRoles/viewer'] })
          });
        })
      ]);

      configUpdates.ga4_property = propertyResource;
      results.ga4 = {
        success: true,
        property: propertyResource,
        display_name: matchedProperty.displayName,
        users_added: {
          [TEAM_MEMBERS[0].email]: ga4Adds[0],
          [TEAM_MEMBERS[1].email]: ga4Adds[1],
          [SA_EMAIL]: ga4Adds[2]
        }
      };
    } catch (e) {
      await monitor.logError('bootstrap-access', e, {
        client_slug: clientSlug,
        detail: { provider: 'ga4', token_error: ga4DebugToken }
      });
      var reason = (e && e.message) || 'GA4 bootstrap failed';
      errors.push('GA4: ' + reason);
      results.ga4 = { success: false, error: reason };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GTM: Find container, add team as Admin, SA as Read
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('gtm')) {
    var gtmDebugToken = null;
    try {
      if (!googleSA) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

      var gtmToken = await getDelegatedToken(googleSA, IMPERSONATE_USER, 'https://www.googleapis.com/auth/tagmanager.manage.users');
      if (gtmToken.error) {
        gtmDebugToken = gtmToken.error;
        throw new Error('Google authentication failed');
      }

      var gtmAuthH = { 'Authorization': 'Bearer ' + gtmToken, 'Content-Type': 'application/json' };

      // Find matching container
      var gtmAcctResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/accounts', { headers: gtmAuthH });
      var gtmAcctData = await gtmAcctResp.json();
      var gtmAccounts = gtmAcctData.account || [];

      var matchedContainer = null;
      var matchedGtmAccount = null;

      for (var gi = 0; gi < gtmAccounts.length && !matchedContainer; gi++) {
        var gtmAcct = gtmAccounts[gi];
        var contResp = await fetch('https://tagmanager.googleapis.com/tagmanager/v2/' + gtmAcct.path + '/containers', { headers: gtmAuthH });
        var contData = await contResp.json();
        var containers = contData.container || [];

        for (var ci = 0; ci < containers.length; ci++) {
          var cont = containers[ci];
          var contDomains = cont.domainName || [];
          if (typeof contDomains === 'string') contDomains = [contDomains];
          var contName = (cont.name || '').toLowerCase();

          for (var di = 0; di < contDomains.length; di++) {
            var d = contDomains[di].replace(/^www\./, '').toLowerCase();
            if (websiteDomain && (d.indexOf(websiteDomain) >= 0 || websiteDomain.indexOf(d) >= 0)) {
              matchedContainer = cont; matchedGtmAccount = gtmAcct; break;
            }
          }
          if (!matchedContainer && practiceName && contName.indexOf(practiceName.toLowerCase()) >= 0) {
            matchedContainer = cont; matchedGtmAccount = gtmAcct;
          }
          if (matchedContainer) break;
        }
      }

      if (!matchedContainer) throw new Error('No matching GTM container found');

      var gtmPermUrl = 'https://tagmanager.googleapis.com/tagmanager/v2/' + matchedGtmAccount.path + '/user_permissions';

      // Add team as PUBLISH (admin-level) + SA as READ (all in parallel)
      var gtmAdds = await Promise.all([
        addUserSafe('GTM chris', function() {
          return fetch(gtmPermUrl, {
            method: 'POST', headers: gtmAuthH,
            body: JSON.stringify({ emailAddress: TEAM_MEMBERS[0].email, accountAccess: { permission: 'ADMIN' }, containerAccess: [{ containerId: matchedContainer.containerId, permission: 'PUBLISH' }] })
          });
        }),
        addUserSafe('GTM kalyn', function() {
          return fetch(gtmPermUrl, {
            method: 'POST', headers: gtmAuthH,
            body: JSON.stringify({ emailAddress: TEAM_MEMBERS[1].email, accountAccess: { permission: 'ADMIN' }, containerAccess: [{ containerId: matchedContainer.containerId, permission: 'PUBLISH' }] })
          });
        }),
        addUserSafe('GTM SA', function() {
          return fetch(gtmPermUrl, {
            method: 'POST', headers: gtmAuthH,
            body: JSON.stringify({ emailAddress: SA_EMAIL, accountAccess: { permission: 'NO_ACCESS' }, containerAccess: [{ containerId: matchedContainer.containerId, permission: 'READ' }] })
          });
        })
      ]);

      results.gtm = {
        success: true,
        container_name: matchedContainer.name,
        container_id: matchedContainer.containerId,
        account: matchedGtmAccount.name,
        users_added: {
          [TEAM_MEMBERS[0].email]: gtmAdds[0],
          [TEAM_MEMBERS[1].email]: gtmAdds[1],
          [SA_EMAIL]: gtmAdds[2]
        }
      };
    } catch (e) {
      await monitor.logError('bootstrap-access', e, {
        client_slug: clientSlug,
        detail: { provider: 'gtm', token_error: gtmDebugToken }
      });
      var reason = (e && e.message) || 'GTM bootstrap failed';
      errors.push('GTM: ' + reason);
      results.gtm = { success: false, error: reason };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LocalFalcon: Search + add location
  // ═══════════════════════════════════════════════════════════════
  if (services.includes('localfalcon')) {
    var lfDebugAddResp = null;
    try {
      if (!lfKey) throw new Error('LOCALFALCON_API_KEY not configured');

      if (config.localfalcon_place_id) {
        results.localfalcon = { success: true, place_id: config.localfalcon_place_id, already_configured: true };
      } else {
        var city = contact.city || '';
        var state = contact.state || contact.province || '';
        var proximity = [city, state].filter(Boolean).join(', ');

        // Search
        var lfSearchResp = await fetch('https://api.localfalcon.com/v2/locations/search', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'api_key=' + lfKey + '&name=' + encodeURIComponent(practiceName) + (proximity ? '&proximity=' + encodeURIComponent(proximity) : '')
        });
        var lfSearchData = await lfSearchResp.json();
        var lfResults = (lfSearchData.data && lfSearchData.data.results) || [];

        if (lfResults.length === 0) {
          // Might be already saved (LF hides saved locations from search)
          var lfSavedResp = await fetch('https://api.localfalcon.com/v1/locations/', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&query=' + encodeURIComponent(practiceName) + '&limit=5'
          });
          var lfSavedData = await lfSavedResp.json();
          var savedLocs = (lfSavedData.data && lfSavedData.data.locations) || [];
          var nameMatch = savedLocs.find(function(l) { return (l.name || '').toLowerCase().indexOf(practiceName.toLowerCase()) >= 0; });
          if (nameMatch) {
            configUpdates.localfalcon_place_id = nameMatch.place_id;
            results.localfalcon = { success: true, place_id: nameMatch.place_id, location_name: nameMatch.name, already_saved: true };
          } else {
            throw new Error('No LocalFalcon results found for this practice');
          }
        } else {
          var best = lfResults[0];
          var lfAddResp = await fetch('https://api.localfalcon.com/v2/locations/add', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'api_key=' + lfKey + '&platform=google&place_id=' + encodeURIComponent(best.place_id)
          });
          var lfAddData = await lfAddResp.json();
          if (!lfAddData.success) {
            lfDebugAddResp = lfAddData;
            throw new Error('LocalFalcon add location failed');
          }

          configUpdates.localfalcon_place_id = best.place_id;
          results.localfalcon = { success: true, place_id: best.place_id, location_name: best.name, added: true };
        }
      }
    } catch (e) {
      await monitor.logError('bootstrap-access', e, {
        client_slug: clientSlug,
        detail: { provider: 'localfalcon', add_response: lfDebugAddResp }
      });
      var reason = (e && e.message) || 'LocalFalcon bootstrap failed';
      errors.push('LocalFalcon: ' + reason);
      results.localfalcon = { success: false, error: reason };
    }
  }

  // ─── Save config updates ───────────────────────────────────────
  if (Object.keys(configUpdates).length > 0) {
    try {
      configUpdates.updated_at = new Date().toISOString();
      await fetch(sb.url() + '/rest/v1/report_configs?id=eq.' + config.id, {
        method: 'PATCH', headers: sb.headers(), body: JSON.stringify(configUpdates)
      });
    } catch (e) {
      await monitor.logError('bootstrap-access', e, { client_slug: clientSlug, detail: { stage: 'config_save' } });
      errors.push('Config save failed');
    }
  }

  // ─── Update deliverable statuses ───────────────────────────────
  try {
    var deliverableUpdates = [];
    if (results.localfalcon && results.localfalcon.success) {
      deliverableUpdates.push({ type: 'localfalcon_setup', note: 'place_id: ' + (results.localfalcon.place_id || '') });
    }
    if (results.gbp && results.gbp.success) {
      deliverableUpdates.push({ type: 'gbp_service_account', note: 'GBP Location ID: ' + (results.gbp.gbp_location_id || '') + '. Team + SA added.' });
    }
    if (results.ga4 && results.ga4.success) {
      deliverableUpdates.push({ type: 'ga4_setup', note: 'Property: ' + (results.ga4.property || '') + '. Team + SA added.' });
    }
    if (results.gtm && results.gtm.success) {
      deliverableUpdates.push({ type: 'gtm_setup', note: 'Container: ' + (results.gtm.container_name || '') + '. Team + SA added.' });
    }
    for (var du = 0; du < deliverableUpdates.length; du++) {
      var upd = deliverableUpdates[du];
      await fetch(sb.url() + '/rest/v1/deliverables?contact_id=eq.' + contact.id + '&deliverable_type=eq.' + upd.type + '&status=neq.delivered', {
        method: 'PATCH', headers: sb.headers(),
        body: JSON.stringify({ status: 'delivered', delivered_at: new Date().toISOString(), notes: 'Auto: ' + upd.note, updated_at: new Date().toISOString() })
      });
    }
  } catch (e) {
    await monitor.logError('bootstrap-access', e, { client_slug: clientSlug, detail: { stage: 'deliverable_update' } });
    errors.push('Deliverable update failed');
  }

  // ─── Sanitize response: drop internal resource identifiers that admin UI
  // never consumes. Keep human-readable titles and IDs that the UI actively
  // uses (gbp_location_id, place_id) plus config_updates (unchanged).
  // Internal fields dropped: gbp.location_name, gbp.account, ga4.property,
  // gtm.account. See H28.
  var publicResults = {};
  ['gbp', 'ga4', 'gtm', 'localfalcon'].forEach(function(svc) {
    if (!results[svc]) return;
    var r = results[svc];
    if (svc === 'gbp') {
      publicResults.gbp = pickDefined({
        success: r.success, location_title: r.location_title,
        gbp_location_id: r.gbp_location_id, users_added: r.users_added,
        error: r.error
      });
    } else if (svc === 'ga4') {
      publicResults.ga4 = pickDefined({
        success: r.success, display_name: r.display_name,
        users_added: r.users_added, error: r.error
      });
    } else if (svc === 'gtm') {
      publicResults.gtm = pickDefined({
        success: r.success, container_name: r.container_name,
        container_id: r.container_id, users_added: r.users_added,
        error: r.error
      });
    } else if (svc === 'localfalcon') {
      publicResults.localfalcon = pickDefined({
        success: r.success, place_id: r.place_id, location_name: r.location_name,
        already_configured: r.already_configured, already_saved: r.already_saved,
        added: r.added, error: r.error
      });
    }
  });

  return res.status(200).json({
    success: errors.length === 0,
    client_slug: clientSlug,
    practice_name: practiceName,
    results: publicResults,
    config_updates: configUpdates,
    errors: errors
  });
};

// Strip undefined keys so the JSON response doesn't render "field": undefined
// as missing-but-hinted-at. Keeps shape clean for admin UI conditionals.
function pickDefined(obj) {
  var out = {};
  Object.keys(obj).forEach(function(k) { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}


// ═══════════════════════════════════════════════════════════════════
// Helper: Get access token via domain-wide delegation
// ═══════════════════════════════════════════════════════════════════
async function getDelegatedToken(saJson, impersonateEmail, scope) {
  try {
    var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
    if (!sa.private_key || !sa.client_email) throw new Error('SA JSON missing private_key or client_email');
    var crypto = require('crypto');

    var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    var now = Math.floor(Date.now() / 1000);
    var claims = Buffer.from(JSON.stringify({
      iss: sa.client_email,
      sub: impersonateEmail,
      scope: scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })).toString('base64url');

    var signable = header + '.' + claims;
    var signer = crypto.createSign('RSA-SHA256');
    signer.update(signable);
    var signature = signer.sign(sa.private_key, 'base64url');
    var jwt = signable + '.' + signature;

    var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
    });
    var tokenData = await tokenResp.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
    return tokenData.access_token;
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

