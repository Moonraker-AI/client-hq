// api/newsletter-subscribers-import.js
// Imports newsletter subscribers (single or bulk) with dedup + resubscribe semantics.
//
// POST body:
//   {
//     subscribers: [{ email, first_name?, last_name?, source?, status? }, ...],
//     resubscribe: boolean   // optional; default false.
//                            // When true, existing rows with status in
//                            // ('unsubscribed','bounced','complained') are
//                            // flipped back to 'active' and unsubscribed_at cleared.
//   }
//
// Per-row outcomes (returned in results[]):
//   created                      — new row inserted
//   already_active               — existing row with status 'active' or 'pending'
//   resubscribed                 — previously unsub/bounced/complained, flipped to active
//   needs_resubscribe_confirm    — previously unsub/bounced/complained, resubscribe flag was false
//   invalid_email                — failed regex or was empty
//
// Admin auth required.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var ALLOWED_SOURCES = ['ghl-import', 'entity-audit', 'manual', 'website', 'webinar'];
var ALLOWED_STATUSES = ['active', 'pending'];
var MAX_PER_REQUEST = 500;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var body = req.body || {};
  var subs = Array.isArray(body.subscribers) ? body.subscribers : [];
  var resubscribe = !!body.resubscribe;

  if (subs.length === 0) {
    return res.status(400).json({ error: 'subscribers required (non-empty array)' });
  }
  if (subs.length > MAX_PER_REQUEST) {
    return res.status(400).json({ error: 'Too many subscribers. Max ' + MAX_PER_REQUEST + ' per request.' });
  }

  // ── Normalize + validate, de-duplicate within the batch by email ───────
  var results = new Array(subs.length);
  var normalizedByEmail = {};   // email → { indices: [original indices], row: normalized }
  var emailOrder = [];          // preserve first-seen order for batch insert

  for (var i = 0; i < subs.length; i++) {
    var s = subs[i] || {};
    var rawEmail = typeof s.email === 'string' ? s.email.trim().toLowerCase() : '';

    if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
      results[i] = { email: rawEmail || null, result: 'invalid_email' };
      continue;
    }

    var source = (typeof s.source === 'string' && ALLOWED_SOURCES.indexOf(s.source) !== -1)
      ? s.source : 'manual';
    var status = (typeof s.status === 'string' && ALLOWED_STATUSES.indexOf(s.status) !== -1)
      ? s.status : 'active';
    var first = typeof s.first_name === 'string' ? s.first_name.trim() : '';
    var last  = typeof s.last_name  === 'string' ? s.last_name.trim()  : '';
    var ghlId = typeof s.ghl_contact_id === 'string' && s.ghl_contact_id.trim() ? s.ghl_contact_id.trim() : null;
    var metadata = (s.metadata && typeof s.metadata === 'object' && !Array.isArray(s.metadata)) ? s.metadata : {};

    if (normalizedByEmail[rawEmail]) {
      // Duplicate within the submitted batch — attach this index to the first occurrence.
      // The outcome written to `results` for this index will mirror whatever the first
      // occurrence resolves to, so callers still get one entry per input row.
      normalizedByEmail[rawEmail].indices.push(i);
    } else {
      normalizedByEmail[rawEmail] = {
        indices: [i],
        row: {
          email: rawEmail,
          first_name: first || null,
          last_name: last || null,
          source: source,
          status: status,
          ghl_contact_id: ghlId,
          metadata: metadata
        }
      };
      emailOrder.push(rawEmail);
    }
  }

  // Nothing valid? Return early.
  if (emailOrder.length === 0) {
    return res.status(200).json({ results: results, counts: summarize(results) });
  }

  try {
    // ── Single batched lookup of existing rows ─────────────────────────
    // Emails have already been validated against EMAIL_RE, so commas/quotes
    // are impossible, but we still wrap in double-quotes for PostgREST's in.()
    // syntax to be safe against edge chars like '+'.
    var inClause = emailOrder.map(function(e) {
      return '"' + e.replace(/"/g, '""') + '"';
    }).join(',');

    var existing = await sb.query(
      'newsletter_subscribers?email=in.(' + inClause + ')&select=id,email,status'
    );
    var existingMap = {};
    for (var j = 0; j < existing.length; j++) {
      existingMap[existing[j].email] = existing[j];
    }

    // ── Resolve each unique email to an outcome ────────────────────────
    var toInsert = [];
    var toResubscribeIds = [];

    for (var k = 0; k < emailOrder.length; k++) {
      var em = emailOrder[k];
      var entry = normalizedByEmail[em];
      var ex = existingMap[em];
      var outcome;

      if (!ex) {
        toInsert.push({
          email: entry.row.email,
          first_name: entry.row.first_name,
          last_name: entry.row.last_name,
          status: entry.row.status,
          source: entry.row.source,
          engagement_tier: 'warm',
          ghl_contact_id: entry.row.ghl_contact_id,
          metadata: entry.row.metadata
        });
        outcome = { email: em, result: 'created' };
      } else if (ex.status === 'active' || ex.status === 'pending') {
        outcome = { email: em, result: 'already_active', prior_status: ex.status };
      } else {
        // unsubscribed / bounced / complained
        if (resubscribe) {
          toResubscribeIds.push(ex.id);
          outcome = { email: em, result: 'resubscribed', prior_status: ex.status };
        } else {
          outcome = { email: em, result: 'needs_resubscribe_confirm', prior_status: ex.status };
        }
      }

      // Apply the outcome to every original index that mapped to this email
      for (var m = 0; m < entry.indices.length; m++) {
        results[entry.indices[m]] = outcome;
      }
    }

    // ── Apply mutations ───────────────────────────────────────────────
    if (toInsert.length) {
      await sb.mutate('newsletter_subscribers', 'POST', toInsert, 'return=minimal');
    }
    if (toResubscribeIds.length) {
      await sb.mutate(
        'newsletter_subscribers?id=in.(' + toResubscribeIds.join(',') + ')',
        'PATCH',
        {
          status: 'active',
          unsubscribed_at: null,
          bounce_count: 0,
          subscribed_at: new Date().toISOString()
        },
        'return=minimal'
      );
    }

    return res.status(200).json({ results: results, counts: summarize(results) });

  } catch (e) {
    console.error('newsletter-subscribers-import error:', e);
    return res.status(500).json({ error: 'Import failed: ' + e.message });
  }
};

function summarize(results) {
  var c = {
    created: 0,
    already_active: 0,
    resubscribed: 0,
    needs_resubscribe_confirm: 0,
    invalid_email: 0
  };
  for (var i = 0; i < results.length; i++) {
    if (!results[i]) continue;
    if (Object.prototype.hasOwnProperty.call(c, results[i].result)) {
      c[results[i].result]++;
    }
  }
  return c;
}
