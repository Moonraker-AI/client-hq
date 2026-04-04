import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 300 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IMPERSONATE_USER = 'support@moonraker.ai';

const CAMPAIGN_SHEETS = {"kelly-chisholm":"1YdaVY7RcQbFJGPgYw4eaK1UynavzAyqRMBSFkGXAklA","sara-smith":"1E_sOqF9sUpMFY6A-u5IxnZ9SaMq3d8z8hbc5i7gkgGs","alli-christie-disney":"1WsDbsG3hwawiHFkmlx4CUSp33IPDsSXYYEaoaZjVK-I","amy-hagerstrom":"1tFXMb01ioDu-xx0Qk0ovS9xQWEN2NtJhJLsyYx_tlUU","ross-hackerson":"11M99pUeAaweZW_2cW78A51W0qYUX6UThD6PpdcKR4lo","audrey-schoen":"1aYed38rLzRVVHiJ8gxaI9gBx4bdBIO26hJ6j4DBhSoI","stephanie-crouch":"17lDirkwT3t69X8QKEgMe_kITNeMQPjW492wlX6GnVP0","daniel-arteaga":"1vLn_kGKhzWpHUKFzHg4UAr-tuF_G2FiiyMWdxV6eWY4","erika-frieze":"1mMbMdr_NIPxqlqhaLgdjcf-EcofJnTPpP8sbF15n2NA","amy-castongia":"1kesw8ISLwVEOcqY6bx1lp8Fn3qJy35PhyGrbtIF5qHA","kelly-chisholm-2":"1BxKrLLoP1i1p_BFYxdMCLtBn7LxfMBH7hugwJZC0GjY","joanne-garrow":"1Bqyh6j17upSQ4EHjozHFhKIubCaPFuUIATSOFxteIVE","amber-young":"1aZimbFgRZjz3nUBPTlVwo3ji7QO0F4OJ7426kn7oZLE","natalie-goldberg":"1r1WTzQ279Z_iP5beHzkDJ42JA3s9DkW-2Zj2PYha1F8","erica-aten":"1hjI-PjFCRuqteEhtU9ybTkowfztNPOC_EBm_2Ti2cxE","brooke-brandeberry":"1AL5O1z3p_WG8Cf-CXZSjZr2GGxxyzzPEH_-DA9_NcFs","elizabeth-harding":"1boXBLJaKF-fAAxGZInr5rSxVWLGiY6LRYYtGBVM6vSg","cristina-deneve":"1VCu5tfQGAtxxFs0errly_AYvAyrN2Wd2ECEzUxzbX1s","erika-beck":"1bpe0r28Gb5lwT0NUuxFya691o6nL6JPiTZqeo8MZm0o","erinn-everhart":"1Z3tkTtjb-ykc73XoNvKh8cJT8uKCOp2YR9GQKpRF2Y8","kevin-anderson":"1QDO1XMYUN1eEUgpay8eVIZdMBdEVoqL1DWXp4vYRt8Y","matt-ciaschini":"1q0LeZ-SwQE8n-cPNRPvgrJYRPeSZmjZfwOYnK4dtdo0","viviana-mcgovern":"1KrS4NPrH5CuSe5eK2oQ5P8y5M_ZQzUTfMm2p3eT7cNo","lianna-purjes":"14s22g17_JoU-625gxOq3URhMWI5yPBuE_X67OWcIdWI","gaia-somasca":"14G1Qg-44orMddlPKVSMS8LWCF8z6jbJvLTco3h2X1HE","laura-biron":"14JsJZZRk7V06gMxuCZFvBmoAO8Ra1LTyFWylp0bAvqo","lydia-zygeta":"1_qA7bv3n24FSMbN_e_WGLva3mruNNMGmSuFgWP8W2s4","jon-abelack":"1HDYbcRokE0PLVIu3H0yNlkMMwlYPpqvH7ZBP35iiv9o","katrina-kwan":"1IXOpKbWbXXRO-23WGSZKuZzI97r93hayRfUmSbwnIVk","laura-bai":"1X-L8zmBML6mDIMI2ERO--iwTy2zwTy3OYhw5kETnlI0","kelsey-thompson":"1fI8rOJrRZIuL6OdAObVhUv9AYTuMuSGFHbZ-lbdD0zw","linda-kocieniewski":"1O2CJogiAD9moHo33yOF4GdcNVyMjeMmhxY5iuOwUiZM","kelsey-fyffe":"1UX4EdUkH83Sp37_enzRlDb20zwQpwlvCJgLsE4wefGk","amanda-bumgarner":"1XS5Squ9fYPOn8fVjP9qMB0YWW8OjY0Cu60zzkOgfhkg","lucy-orton":"1UVZvMebcAKXCJqa61A67j6Dkb_R_S_K2GcQ83FWszkY","nicole-mccance":"1vFAIGYN4oewl5mRUsXuIFw4rnURXb_sfJaxL9UdQG-o","isable-smith":"1GbkD2d_jCxEWfBZkAVy7o1-Ia5SYU7-IXqpzJa29NTg","gianna-lalota":"1hCq4qxTlhQb5FC2GWQRq3uQr8kNcWmp9jm61eu-1tTU","emily-newman":"1L9E9esfkBzYz3aAcKAEVWp-Od1Ixw6vXxfvAgtz6R8s","allison-shotwell":"1R3Hhg6iefSqo6xqBxqTuSeEqIaRbH5ATtT4H0xNr0Fg","lauren-hogsett-steele":"1tBSspNeoPn-yLGTV0DhB97iKiUztQe5ofX9WNMV6PJw","jose-de-la-cruz-2":"1USpOjVuFki5DzbrvE77jbvmiqlCukBsMNKW5DjteWuk","vivienne-livingstone":"1UJ_CHSfHU7hs3R6JdE3YD6BGTU8N0SEgqj9MBeAe1R4","robyn-sheiniuk":"1FRpT6Cupep5GcCoO-iNee04qiH7lsadc2K65btBWGm0","jose-de-la-cruz":"1DCX-K5LlCHftqMxi-xpmTJKWM6PYB2d8exAT3NY1xlA","utkala-maringanti":"1AL-n7Z9Jo1ylWlfY3swzYdVENd7f6l2Nojfzv1_aWn8","robyn-sevigny":"1u2ICLV-Q5R3s_fLU0TKxJKIcip0xmbRq_xtfE3kkoh8","mitchel-rosenholtz":"1uI-JnEr90KnGP8CxMuU7qZ_RjKdeGAF50QhDlBNboDA","christine-ruberti-bruning":"1SVI3bJzGCcwSArJuj75sYYqFd5nfRhvdaBhqRMoHdVk","rachelle-ryan":"1kapAqZnvYm6dHubkrCId4j-DlkMnx4n8vsA3OFRfOo8","melinda-schuster":"1T7yehvG_sRnGzvj4_0MOmK_IprTO3nvtRFg7Hs5_-ZI","shabnam-lee":"1i8x8WsyYzfmFUE8pM7l4Gf72RsVrmMcB6FqMx0OeLns","ande-welling":"1AFaeL2aWW9JSLwI-_eYnNpxghOHpvToLLyo1Sy7iSpU","alanna-esquejo":"1e5p5ls_2Bp15ZE3cUNnJA7uMzuHPETA1RJtDOthn5RU","christine-willing":"1A5sqDg8UqbZYCQB0fUJFgimUrxNoZbSFYMOsmjYHvgs","maya-weir":"1q-h01KIOMGFKnxSiQ3GzMzwZnrpS3xvV6iajpkFuwqY","alex-littleton":"1haV-wxhiR8QaUCsgCdlFtOlAkPGw5EfdHL8_k-pso2g","austin-casey":"1S_Ja8JPuLHFQ6nJxpmc2WKHhU-jQ8Ciqejxueglq7C8","erika-doty":"10RM6ioH76A5lr7jPDEOkZtcYJ8EZFi5E0t1wDFIx0yo","anna-skomorovskaia":"1NDQre_9k7BYluHVjbzaubHto4KUlGKvd3wV_iWjAVPM","robert-espiau":"17177oIw3heccaPveXZq5uAy-HGeMDrKG2-Ik7nl5xfE","monique-dunn":"1cUk4RiJL9I4GYjLeaXtER2NzB_D8MIMXFa-ppsAt6S0","atiq-shomar":"1VYQColy_oJ_bXTECNaUA8Mm2qgx5ejh2Tjusa9bMe7c","derek-smith":"1QzkaHhwmd9a4Vh8FgPbJ4iGigcwRQzhnpg0HrRI0WDI"};

// --- JWT Auth (same pattern as bootstrap-access.js) ---
async function getGoogleToken(scope) {
  var crypto = require('crypto');
  var sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  var now = Math.floor(Date.now() / 1000);
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var payload = Buffer.from(JSON.stringify({
    iss: sa.client_email, sub: IMPERSONATE_USER, scope: scope,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })).toString('base64url');
  var signature = crypto.createSign('RSA-SHA256').update(header + '.' + payload).sign(sa.private_key, 'base64url');
  var jwt = header + '.' + payload + '.' + signature;
  var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  var tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Token error: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function getSheetTabs(token, sheetId) {
  var resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
  var data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return (data.sheets || []).map(s => s.properties.title);
}

async function getSheetValues(token, sheetId, range) {
  var resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` } });
  var data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.values || [];
}

function parseKeywordsFromRows(rows) {
  var keywords = [], locations = [], section = null, kwRow = null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || row.length === 0) { section = null; continue; }
    var c0 = (row[0] || '').trim();
    if (c0 === 'Service Pages') { section = 'service'; continue; }
    if (c0 === 'Location Pages') { section = 'location'; continue; }
    if (section === 'service') {
      if (c0 === 'Primary Keyword' || c0 === 'Keyword') {
        kwRow = row.slice(1).map(v => (v || '').trim()).filter(Boolean);
      }
      if (c0 === 'URL' || c0 === 'Optimized Page') {
        var urls = row.slice(1).map(v => (v || '').trim());
        if (kwRow) {
          for (var j = 0; j < kwRow.length; j++) {
            var u = (urls[j] || ''); if (u.includes('docs.google.com')) u = '';
            keywords.push({ keyword: kwRow[j], target_page: u || null, type: 'service' });
          }
        }
        kwRow = null; section = null;
      }
    }
    if (section === 'location') {
      if (c0 === 'Location' || c0 === 'Keyword') {
        kwRow = row.slice(1).map(v => (v || '').trim()).filter(Boolean);
      }
      if (c0 === 'URL' || c0 === 'Optimized Page') {
        var lurls = row.slice(1).map(v => (v || '').trim());
        if (kwRow) {
          for (var k = 0; k < kwRow.length; k++) {
            var lu = (lurls[k] || ''); if (lu.includes('docs.google.com')) lu = '';
            locations.push({ keyword: kwRow[k], target_page: lu || null, type: 'location' });
          }
        }
        kwRow = null; section = null;
      }
    }
  }
  return { keywords, locations };
}

export default async function handler(req, res) {
  if (req.query.key !== 'moonraker2026') return res.status(401).json({ error: 'Unauthorized' });
  var dryRun = req.query.dry === 'true';
  var singleSlug = req.query.slug || null;
  try {
    var token = await getGoogleToken('https://www.googleapis.com/auth/spreadsheets.readonly');
    var supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    var { data: contacts } = await supabase.from('contacts').select('id, slug').in('slug', Object.keys(CAMPAIGN_SHEETS));
    var slugToId = {}; for (var c of contacts) slugToId[c.slug] = c.id;
    var results = [], errors = [];
    var slugs = singleSlug ? [singleSlug] : Object.keys(CAMPAIGN_SHEETS);
    for (var slug of slugs) {
      var sheetId = CAMPAIGN_SHEETS[slug]; var contactId = slugToId[slug];
      if (!sheetId || !contactId) { errors.push({ slug, error: 'Missing sheet or contact' }); continue; }
      try {
        var tabs = await getSheetTabs(token, sheetId);
        var tabName = tabs.includes('Optimization') ? 'Optimization' : tabs.includes('Technicals') ? 'Technicals' : null;
        if (!tabName) { errors.push({ slug, error: 'No keyword tab, tabs: ' + tabs.join(', ') }); continue; }
        var rows = await getSheetValues(token, sheetId, "'" + tabName + "'!A1:Z100");
        var parsed = parseKeywordsFromRows(rows);
        var all = [...parsed.keywords, ...parsed.locations];
        if (all.length === 0) { errors.push({ slug, error: 'No keywords found' }); continue; }
        var inserts = all.map(function(e) { return {
          contact_id: contactId, client_slug: slug, keyword: e.keyword, keyword_type: e.type,
          target_page: e.target_page, priority: 1, source: 'migration',
          track_gsc: true, track_geogrid: e.type === 'service', track_ai_visibility: e.type === 'service', active: true
        }; });
        if (!dryRun) {
          var { error: ie } = await supabase.from('tracked_keywords').insert(inserts);
          if (ie) { errors.push({ slug, error: ie.message }); continue; }
        }
        results.push({ slug, tab: tabName, service: parsed.keywords.map(k=>k.keyword), locations: parsed.locations.map(l=>l.keyword), total: inserts.length });
      } catch (se) { errors.push({ slug, error: (se.message||'').substring(0, 200) }); }
    }
    return res.status(200).json({ mode: dryRun ? 'DRY RUN' : 'LIVE', processed: results.length, errored: errors.length, total_keywords: results.reduce((s,r)=>s+r.total,0), results, errors });
  } catch (err) { return res.status(500).json({ error: err.message }); }
}
