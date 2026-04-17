// api/admin/manage-site.js
// Manages client site hosting configuration.
// Actions: provision (create + set up CF), update, deprovision, status
//
// For moonraker-hosted sites on CF zones we already own:
//   Creates DNS record (if needed), Worker route, and activates the site.
// For moonraker-hosted sites via Custom Hostnames:
//   Registers custom hostname on CF for SaaS, returns CNAME instructions.
// For external sites (WP, Squarespace, etc):
//   Just records the hosting config for reference. No CF provisioning.

var sb = require('../_lib/supabase');
var { requireAdmin } = require('../_lib/auth');

var CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
var CF_TOKEN = process.env.CF_API_TOKEN;
var CF_BASE = 'https://api.cloudflare.com/client/v4';
var MOONRAKER_ZONE_ID = process.env.CF_ZONE_ID;
var WORKER_NAME = 'client-sites-worker';

// Loud warnings at module load so config gaps surface in Vercel logs
// before any user hits the endpoint. C5 pattern, mirrors api/_lib/crypto.js
// and api/admin/deploy-to-r2.js.
if (!CF_ACCOUNT_ID) console.error('[manage-site] CRITICAL: CF_ACCOUNT_ID is not set. CF operations will return 500.');
if (!CF_TOKEN)      console.error('[manage-site] CRITICAL: CF_API_TOKEN is not set. CF operations will return 500.');
if (!MOONRAKER_ZONE_ID) console.error('[manage-site] CRITICAL: CF_ZONE_ID is not set. Moonraker zone provisioning will return 500.');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var admin = await requireAdmin(req, res);
  if (!admin) return;

  // Fail closed on any missing CF config. 'status' action is read-only against our DB
  // and doesn't touch CF, so let it through even when CF env is incomplete.
  try {
    var preview = req.body || {};
    if (preview.action !== 'status' && (!CF_ACCOUNT_ID || !CF_TOKEN || !MOONRAKER_ZONE_ID)) {
      return res.status(500).json({ error: 'Cloudflare configuration missing (CF_ACCOUNT_ID, CF_API_TOKEN, CF_ZONE_ID required)' });
    }
  } catch (e) {}

  try {
    var { action } = req.body;

    if (action === 'provision') return await handleProvision(req, res);
    if (action === 'update') return await handleUpdate(req, res);
    if (action === 'deprovision') return await handleDeprovision(req, res);
    if (action === 'status') return await handleStatus(req, res);
    if (action === 'list_zones') return await handleListZones(req, res);

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[manage-site] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─── Provision: create a client_sites record and set up CF infrastructure ───

async function handleProvision(req, res) {
  var { contact_id, domain, hosting_type, cf_zone_id } = req.body;

  if (!contact_id || !domain || !hosting_type) {
    return res.status(400).json({ error: 'contact_id, domain, and hosting_type are required' });
  }

  // Clean domain
  domain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^www\./, '');

  // M12: strict FQDN validation. The prior normalization strips protocol,
  // trailing slash, and leading www., but accepts anything else — so
  // domain.com:8080, domain.com/path, user:pass@host, domain.com?q=x all
  // flowed through to the CF custom-hostname API and got persisted to
  // client_sites.domain. Reject anything that isn't a well-formed FQDN.
  //
  // Constraints: 1-253 total chars, each label 1-63 chars of alnum or
  // hyphen (no leading/trailing hyphen), final TLD 2-63 alpha chars.
  var fqdnPattern = /^(?=.{1,253}$)(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.)+[a-z]{2,63}$/;
  if (!fqdnPattern.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }

  // Check for duplicate
  var existing = await sb.one('client_sites?domain=eq.' + encodeURIComponent(domain) + '&select=id');
  if (existing) {
    return res.status(409).json({ error: 'Domain already registered', site_id: existing.id });
  }

  var siteData = {
    contact_id: contact_id,
    domain: domain,
    hosting_type: hosting_type,
    cf_zone_id: cf_zone_id || null,
    status: 'disabled'
  };

  // For external hosting, just save the record
  if (hosting_type !== 'moonraker') {
    siteData.status = 'active';
    var site = await sb.mutate('client_sites', 'POST', siteData, 'return=representation');
    return res.status(200).json({
      success: true,
      site: Array.isArray(site) ? site[0] : site,
      message: 'Site registered as ' + hosting_type + ' (external). No CF provisioning needed.'
    });
  }

  // For moonraker hosting, provision CF infrastructure
  if (!CF_TOKEN) {
    return res.status(500).json({ error: 'CF_API_TOKEN not configured in environment' });
  }

  var cfResult = {};

  if (cf_zone_id) {
    // Domain is on our CF account — use Worker Routes directly
    cfResult = await provisionOwnedZone(domain, cf_zone_id);
    siteData.cf_zone_id = cf_zone_id;
    siteData.cf_route_ids = JSON.stringify(cfResult.route_ids || []);
    siteData.dns_verified = true;
    siteData.status = 'active';
  } else {
    // Domain is external — use Custom Hostnames
    cfResult = await provisionCustomHostname(domain);
    siteData.cf_custom_hostname_id = cfResult.hostname_id;
    siteData.status = 'pending_verification';
  }

  var site = await sb.mutate('client_sites', 'POST', siteData, 'return=representation');

  return res.status(200).json({
    success: true,
    site: Array.isArray(site) ? site[0] : site,
    cf: cfResult
  });
}

// Set up Worker Routes on a zone we already own
async function provisionOwnedZone(domain, zoneId) {
  var routeIds = [];

  // Check if root DNS record exists and is proxied
  var dnsResp = await cfFetch('/zones/' + zoneId + '/dns_records?name=' + domain + '&type=A');
  var dnsRecords = dnsResp.result || [];
  var rootRecord = dnsRecords.find(function(r) { return r.name === domain; });

  var dnsNote = null;
  if (!rootRecord) {
    // Create a proxied A record with dummy IP
    await cfFetch('/zones/' + zoneId + '/dns_records', 'POST', {
      type: 'A', name: domain, content: '192.0.2.1', proxied: true, ttl: 1
    });
    dnsNote = 'Created proxied A record for ' + domain;
  } else if (!rootRecord.proxied) {
    dnsNote = 'WARNING: DNS record for ' + domain + ' exists but is not proxied. Traffic will bypass the Worker until proxied.';
  }

  // Add Worker routes for root and www
  var patterns = [domain + '/*', 'www.' + domain + '/*'];
  for (var i = 0; i < patterns.length; i++) {
    try {
      var routeResp = await cfFetch('/zones/' + zoneId + '/workers/routes', 'POST', {
        pattern: patterns[i],
        script: WORKER_NAME
      });
      if (routeResp.result && routeResp.result.id) {
        routeIds.push(routeResp.result.id);
      }
    } catch (err) {
      // Route may already exist
      console.warn('[manage-site] Route create warning for ' + patterns[i] + ':', err.message);
    }
  }

  return {
    method: 'worker_routes',
    route_ids: routeIds,
    dns_note: dnsNote
  };
}

// Register a Custom Hostname via Cloudflare for SaaS
async function provisionCustomHostname(domain) {
  var resp = await cfFetch('/zones/' + MOONRAKER_ZONE_ID + '/custom_hostnames', 'POST', {
    hostname: domain,
    ssl: { method: 'http', type: 'dv', wildcard: false }
  });

  var result = resp.result || {};

  return {
    method: 'custom_hostname',
    hostname_id: result.id,
    ssl_status: result.ssl ? result.ssl.status : 'unknown',
    verification: result.ownership_verification || null,
    cname_target: 'sites.moonraker.ai',
    instructions: 'Add a CNAME record: ' + domain + ' → sites.moonraker.ai'
  };
}

// ─── Update hosting config ───

async function handleUpdate(req, res) {
  var { site_id, hosting_type, status } = req.body;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  var updates = {};
  if (hosting_type) updates.hosting_type = hosting_type;
  if (status) updates.status = status;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  var site = await sb.mutate(
    'client_sites?id=eq.' + site_id,
    'PATCH',
    updates,
    'return=representation'
  );

  return res.status(200).json({
    success: true,
    site: Array.isArray(site) ? site[0] : site
  });
}

// ─── Deprovision: disable site ───

async function handleDeprovision(req, res) {
  var { site_id } = req.body;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  // Just disable — don't delete CF routes or R2 files (can be re-enabled)
  var site = await sb.mutate(
    'client_sites?id=eq.' + site_id,
    'PATCH',
    { status: 'disabled' },
    'return=representation'
  );

  return res.status(200).json({
    success: true,
    site: Array.isArray(site) ? site[0] : site,
    message: 'Site disabled. R2 files and CF routes preserved for re-activation.'
  });
}

// ─── Status: check CF and deployment state ───

async function handleStatus(req, res) {
  var { site_id } = req.body;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  var site = await sb.one('client_sites?id=eq.' + site_id + '&select=*');
  if (!site) return res.status(404).json({ error: 'Site not found' });

  var deployments = await sb.query(
    'site_deployments?site_id=eq.' + site_id + '&select=page_path,deployed_at,content_hash,deployed_by&order=deployed_at.desc'
  );

  var cfStatus = null;
  if (site.cf_custom_hostname_id && CF_TOKEN) {
    try {
      var resp = await cfFetch('/zones/' + MOONRAKER_ZONE_ID + '/custom_hostnames/' + site.cf_custom_hostname_id);
      cfStatus = {
        status: resp.result.status,
        ssl_status: resp.result.ssl ? resp.result.ssl.status : 'unknown'
      };
    } catch (err) {
      cfStatus = { error: err.message };
    }
  }

  return res.status(200).json({
    site: site,
    deployments: deployments,
    cf_status: cfStatus,
    pages_deployed: deployments.length
  });
}

// ─── List available CF zones (for admin UI zone picker) ───

async function handleListZones(req, res) {
  if (!CF_TOKEN) {
    return res.status(500).json({ error: 'CF_API_TOKEN not configured' });
  }

  var resp = await cfFetch('/zones?account.id=' + CF_ACCOUNT_ID + '&per_page=50&status=active');
  var zones = (resp.result || []).map(function(z) {
    return { id: z.id, name: z.name, plan: z.plan.name };
  });

  return res.status(200).json({ zones: zones });
}

// ─── CF API helper ───

async function cfFetch(path, method, body) {
  var opts = {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + CF_TOKEN,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  var resp = await fetch(CF_BASE + path, opts);
  var data = await resp.json();

  if (!data.success) {
    var errMsg = (data.errors && data.errors[0]) ? data.errors[0].message : 'CF API error';
    var err = new Error(errMsg);
    err.cfErrors = data.errors;
    throw err;
  }
  return data;
}
