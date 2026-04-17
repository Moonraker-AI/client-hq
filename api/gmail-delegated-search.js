// api/gmail-delegated-search.js
// Search any Google Workspace mailbox using the service account with
// domain-wide delegation. Returns message metadata plus a subject histogram
// for quick triage.
//
// Body:
//   {
//     mailbox: "calls@moonraker.ai",      // user to impersonate
//     query:   "from:noreply@greminders.com newer_than:6m",
//     maxMessages: 250                     // optional, default 250, max 500
//   }
//
// Returns:
//   {
//     mailbox, query, total,
//     messages: [{ id, threadId, date, from, subject, snippet }, ...],
//     subjectHistogram: [{ subject, count }, ...],
//     senderHistogram:  [{ from, count }, ...]
//   }

var nodeCrypto = require('crypto');
var auth = require('./_lib/auth');

// ── Service account access token via JWT-bearer + DWD ─────────────

var _tokenCache = {};   // keyed by mailbox: { token, expiresAt }

async function getDelegatedAccessToken(mailbox, scope) {
  var cacheKey = mailbox + '|' + scope;
  var cached = _tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  var saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var missing');

  var sa;
  try { sa = JSON.parse(saRaw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }

  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON missing client_email or private_key');
  }

  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claims = {
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    sub: mailbox
  };

  function b64url(buf) {
    return Buffer.from(buf).toString('base64')
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  var signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  var signer = nodeCrypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  var signature = signer.sign(sa.private_key);
  var jwt = signingInput + '.' + b64url(signature);

  var resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt)
  });

  var data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('Token exchange failed: ' + (data.error_description || data.error || resp.status));
  }

  _tokenCache[cacheKey] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };
  return data.access_token;
}

// ── Gmail API helpers ─────────────────────────────────────────────

async function gmailListAllMessages(token, query, cap) {
  var collected = [];
  var pageToken = null;
  var safetyCounter = 0;

  while (collected.length < cap && safetyCounter < 20) {
    safetyCounter++;
    var pageSize = Math.min(500, cap - collected.length);
    var url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
      + '?q=' + encodeURIComponent(query)
      + '&maxResults=' + pageSize;
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);

    var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    var data = await resp.json();
    if (!resp.ok) {
      throw new Error('Gmail list failed: ' + (data.error && data.error.message || resp.status));
    }

    if (data.messages) collected = collected.concat(data.messages);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return collected.slice(0, cap);
}

async function gmailGetMetadata(token, id) {
  var url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + id
    + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
  var resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var data = await resp.json();
  if (!resp.ok) return null;

  var headers = {};
  if (data.payload && data.payload.headers) {
    for (var i = 0; i < data.payload.headers.length; i++) {
      var h = data.payload.headers[i];
      headers[h.name.toLowerCase()] = h.value;
    }
  }

  return {
    id: data.id,
    threadId: data.threadId,
    date: headers.date || '',
    internalDate: data.internalDate ? Number(data.internalDate) : null,
    from: headers.from || '',
    subject: headers.subject || '(no subject)',
    snippet: data.snippet || ''
  };
}

async function fetchAllMetadata(token, ids, concurrency) {
  var results = new Array(ids.length);
  var idx = 0;

  async function worker() {
    while (true) {
      var i = idx++;
      if (i >= ids.length) return;
      results[i] = await gmailGetMetadata(token, ids[i].id);
    }
  }

  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return results.filter(function(r) { return r; });
}

// ── Histogram helper ──────────────────────────────────────────────

function buildHistogram(messages, key, normalize) {
  var counts = {};
  for (var i = 0; i < messages.length; i++) {
    var raw = messages[i][key] || '';
    var k = normalize ? normalize(raw) : raw;
    counts[k] = (counts[k] || 0) + 1;
  }
  var entries = Object.keys(counts).map(function(k) {
    return { value: k, count: counts[k] };
  });
  entries.sort(function(a, b) { return b.count - a.count; });
  return entries;
}

function normalizeSubject(s) {
  // Strip Re:/Fwd: prefixes for cleaner grouping
  return (s || '').replace(/^(re|fwd|fw):\s*/i, '').trim();
}

// ── Handler ───────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var body = req.body || {};
  var mailbox = (body.mailbox || 'calls@moonraker.ai').toString().trim();
  var query = (body.query || '').toString();
  var maxMessages = Math.max(1, Math.min(500, Number(body.maxMessages) || 250));

  if (!mailbox || !mailbox.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)) {
    res.status(400).json({ error: 'Invalid mailbox address' });
    return;
  }

  try {
    var token = await getDelegatedAccessToken(
      mailbox,
      'https://www.googleapis.com/auth/gmail.readonly'
    );

    var ids = await gmailListAllMessages(token, query, maxMessages);
    var messages = await fetchAllMetadata(token, ids, 10);

    // Sort newest first by internalDate
    messages.sort(function(a, b) {
      return (b.internalDate || 0) - (a.internalDate || 0);
    });

    var subjectHist = buildHistogram(messages, 'subject', normalizeSubject)
      .map(function(e) { return { subject: e.value, count: e.count }; });
    var senderHist = buildHistogram(messages, 'from')
      .map(function(e) { return { from: e.value, count: e.count }; });

    res.status(200).json({
      mailbox: mailbox,
      query: query,
      total: messages.length,
      capped: ids.length === maxMessages,
      messages: messages,
      subjectHistogram: subjectHist,
      senderHistogram: senderHist
    });
  } catch (err) {
    console.error('[gmail-delegated-search]', err);
    res.status(500).json({ error: err.message || 'Search failed' });
  }
};
