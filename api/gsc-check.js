var crypto = require('crypto');

async function getDelegatedToken(saJson, impersonateEmail, scope) {
  var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var now = Math.floor(Date.now() / 1000);
  var claims = Buffer.from(JSON.stringify({
    iss: sa.client_email, sub: impersonateEmail, scope: scope,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
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
  if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error);
  return tokenData.access_token;
}

module.exports = async function(req, res) {
  try {
    var sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!sa) return res.status(500).json({ error: 'No SA configured' });
    var token = await getDelegatedToken(sa, 'support@moonraker.ai', 'https://www.googleapis.com/auth/webmasters.readonly');
    var resp = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    var data = await resp.json();
    var sites = (data.siteEntry || []).map(function(s) { return s.siteUrl; });
    res.json({ count: sites.length, sites: sites });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
