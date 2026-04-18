// /api/enrich-proposal.js
// Enrichment endpoint for the proposal system.
// Searches Gmail (chris@, scott@, support@), Fathom (chris + scott accounts),
// entity audits in Supabase, and optionally the prospect's website to gather
// context for proposal generation.
//
// POST { proposal_id }
//   - Or: POST { contact_id } to enrich without a proposal record
//
// ENV VARS:
//   SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON,
//   FATHOM_API_CHRIS, FATHOM_API_SCOTT

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var monitor = require('./_lib/monitor');
var google = require('./_lib/google-delegated');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;


  var googleSA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  var fathomChris = process.env.FATHOM_API_CHRIS;
  var fathomScott = process.env.FATHOM_API_SCOTT;

  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var proposalId = body.proposal_id;
  var contactId = body.contact_id;

  if (!proposalId && !contactId) {
    return res.status(400).json({ error: 'proposal_id or contact_id required' });
  }

  // Supabase calls via sb helper

  var enrichment = {
    sources: { gmail: [], fathom: [], entity_audit: null, website: null },
    data: { emails: [], calls: [], audit_scores: null, audit_tasks: null, website_info: null },
    summary: { email_count: 0, call_count: 0, has_audit: false, has_website: false }
  };

  // ─── Load proposal + contact ──────────────────────────────────
  var proposal = null;
  var contact = null;

  try {
    if (proposalId) {
      proposal = await sb.one('proposals?id=eq.' + proposalId + '&select=*,contacts(*)&limit=1');
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
      contact = proposal.contacts;
      contactId = contact.id;
    } else {
      contact = await sb.one('contacts?id=eq.' + contactId + '&select=*&limit=1');
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load data: ' + e.message });
  }

  // Build search terms
  var searchEmail = contact.email || '';
  var searchDomain = '';
  if (contact.website_url) {
    try { searchDomain = new URL(contact.website_url).hostname.replace(/^www\./, ''); } catch(e) {}
  }
  if (!searchDomain && searchEmail) {
    var parts = searchEmail.split('@');
    if (parts.length === 2 && !parts[1].match(/gmail|yahoo|hotmail|outlook|protonmail|icloud/i)) {
      searchDomain = parts[1];
    }
  }
  var searchName = ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var practiceName = contact.practice_name || '';

  // Update proposal status to enriching
  if (proposalId) {
    try {
      await sb.mutate('proposals?id=eq.' + proposalId, 'PATCH', { status: 'enriching' });
    } catch (e) {
      console.error('[enrich-proposal] status=enriching flip failed:', e.message);
    }
  }

  // ─── 1. Gmail Search (all 3 accounts) ─────────────────────────
  if (googleSA && (searchEmail || searchDomain)) {
    var gmailAccounts = ['chris@moonraker.ai', 'scott@moonraker.ai', 'support@moonraker.ai'];
    var gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';

    for (var acct of gmailAccounts) {
      try {
        var token;
        try {
          token = await google.getDelegatedAccessToken(acct, gmailScope);
        } catch (tokenErr) {
          continue;
        }
        {
          // Build search query: email address OR domain
          var queries = [];
          if (searchEmail) queries.push(searchEmail);
          if (searchDomain) queries.push(searchDomain);
          if (searchName && searchName.length > 3) queries.push('"' + searchName + '"');
          var query = queries.join(' OR ');

          var msgResp = await fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(query) + '&maxResults=15',
            { headers: { 'Authorization': 'Bearer ' + token } }
          );
          var msgData = await msgResp.json();

          if (msgData.messages && msgData.messages.length > 0) {
            enrichment.sources.gmail.push({ account: acct, thread_count: msgData.messages.length });

            // Fetch up to 5 message snippets for context
            var fetchCount = Math.min(msgData.messages.length, 5);
            for (var i = 0; i < fetchCount; i++) {
              try {
                var detailResp = await fetch(
                  'https://gmail.googleapis.com/gmail/v1/users/me/messages/' + msgData.messages[i].id + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date',
                  { headers: { 'Authorization': 'Bearer ' + token } }
                );
                var detail = await detailResp.json();
                var headers = {};
                (detail.payload && detail.payload.headers || []).forEach(function(h) {
                  headers[h.name.toLowerCase()] = h.value;
                });
                enrichment.data.emails.push({
                  account: acct,
                  message_id: detail.id,
                  thread_id: detail.threadId,
                  subject: headers.subject || '',
                  from: headers.from || '',
                  to: headers.to || '',
                  date: headers.date || '',
                  snippet: detail.snippet || ''
                });
              } catch(e) { /* skip individual message errors */ }
            }
          }
        }
      } catch (e) {
        monitor.logError('enrich-proposal', e, {
          client_slug: contact.slug,
          detail: { stage: 'enrich_gmail', account: acct }
        });
        enrichment.sources.gmail.push({ account: acct, error: 'Failed to enrich from Gmail' });
      }
    }
    enrichment.summary.email_count = enrichment.data.emails.length;
  }

  // ─── 2. Fathom Search (both accounts) ─────────────────────────
  // Fathom REST API: https://api.fathom.ai/external/v1
  // Auth: X-Api-Key header. Filter by calendar_invitees_domains.
  // Summary endpoint: GET /recordings/{recording_id}/summary
  var FATHOM_BASE = 'https://api.fathom.ai/external/v1';

  // Helper: process matched Fathom meetings into enrichment data
  async function processFathomMeetings(meetings, fk, enrichment) {
    for (var rec of meetings) {
      var recId = rec.recording_id || rec.id;
      if (!recId) continue;
      if (enrichment.data.calls.some(function(c) { return c.recording_id === String(recId); })) continue;

      var callEntry = {
        recording_id: String(recId),
        fathom_owner: fk.owner,
        title: rec.title || rec.meeting_title || '',
        date: rec.created_at || '',
        duration_seconds: null,
        attendees: (rec.calendar_invitees || []).map(function(inv) {
          return { name: inv.name || '', email: inv.email || '' };
        })
      };

      if (rec.default_summary) {
        callEntry.summary = rec.default_summary.markdown_formatted || JSON.stringify(rec.default_summary).substring(0, 2000);
      } else {
        try {
          var sumResp = await fetch(
            FATHOM_BASE + '/recordings/' + recId + '/summary',
            { headers: { 'X-Api-Key': fk.key }, signal: AbortSignal.timeout(8000) }
          );
          if (sumResp.ok) {
            var sumData = await sumResp.json();
            callEntry.summary = sumData.markdown_formatted || sumData.summary || sumData.text || JSON.stringify(sumData).substring(0, 2000);
          }
        } catch(e) { /* summary optional */ }
      }

      enrichment.data.calls.push(callEntry);
    }
  }
  var fathomKeys = [];
  if (fathomChris) fathomKeys.push({ key: fathomChris, owner: 'chris' });
  if (fathomScott) fathomKeys.push({ key: fathomScott, owner: 'scott' });

  for (var fk of fathomKeys) {
    try {
      // Build query params: filter by prospect's domain and/or list recent external meetings
      var fParams = new URLSearchParams();
      if (searchDomain) {
        fParams.append('calendar_invitees_domains[]', searchDomain);
      }
      // Also include summary inline to reduce API calls
      fParams.append('include_summary', 'true');
      fParams.append('calendar_invitees_domains_type', 'one_or_more_external');

      var fUrl = FATHOM_BASE + '/meetings?' + fParams.toString();
      var fResp = await fetch(fUrl, {
        headers: { 'X-Api-Key': fk.key },
        signal: AbortSignal.timeout(10000)
      });

      if (fResp.ok) {
        var fData = await fResp.json();
        var meetings = fData.items || [];

        // If domain filter returned nothing, try broader search (recent meetings)
        // and manually filter by attendee email or name
        if (meetings.length === 0 && searchEmail) {
          var broadParams = new URLSearchParams();
          broadParams.append('include_summary', 'true');
          broadParams.append('calendar_invitees_domains_type', 'one_or_more_external');
          var broadUrl = FATHOM_BASE + '/meetings?' + broadParams.toString();
          var broadResp = await fetch(broadUrl, {
            headers: { 'X-Api-Key': fk.key },
            signal: AbortSignal.timeout(10000)
          });
          if (broadResp.ok) {
            var broadData = await broadResp.json();
            var allMeetings = broadData.items || [];
            // Filter client-side by attendee email or name in title
            meetings = allMeetings.filter(function(m) {
              var invitees = m.calendar_invitees || [];
              var hasEmail = invitees.some(function(inv) {
                return inv.email && inv.email.toLowerCase() === searchEmail.toLowerCase();
              });
              var titleMatch = searchName && m.title && m.title.toLowerCase().indexOf(searchName.toLowerCase()) !== -1;
              var meetingTitleMatch = searchName && m.meeting_title && m.meeting_title.toLowerCase().indexOf(searchName.toLowerCase()) !== -1;
              return hasEmail || titleMatch || meetingTitleMatch;
            });
          }
        }

        if (meetings.length > 0) {
          enrichment.sources.fathom.push({ owner: fk.owner, recording_count: meetings.length });
          await processFathomMeetings(meetings, fk, enrichment);
        }

        // Fallback 3: if still no matches, check recent meetings' summaries for contact name
        // This catches "Impromptu Zoom Meeting" calls where the prospect isn't on the calendar invite
        if (meetings.length === 0 && searchName && searchName.length > 3) {
          try {
            var sumParams = new URLSearchParams();
            sumParams.append('include_summary', 'true');
            // Look at last 30 days of meetings
            var thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
            sumParams.append('created_after', thirtyDaysAgo);
            var sumUrl = FATHOM_BASE + '/meetings?' + sumParams.toString();
            var sumResp2 = await fetch(sumUrl, {
              headers: { 'X-Api-Key': fk.key },
              signal: AbortSignal.timeout(12000)
            });
            if (sumResp2.ok) {
              var sumData2 = await sumResp2.json();
              var nameLower = searchName.toLowerCase();
              var lastNameLower = (searchName.split(' ').pop() || '').toLowerCase();
              meetings = (sumData2.items || []).filter(function(m) {
                var sumText = '';
                if (m.default_summary) {
                  sumText = (m.default_summary.markdown_formatted || JSON.stringify(m.default_summary)).toLowerCase();
                }
                var titleText = ((m.title || '') + ' ' + (m.meeting_title || '')).toLowerCase();
                return sumText.indexOf(nameLower) !== -1 || sumText.indexOf(lastNameLower) !== -1 || titleText.indexOf(nameLower) !== -1;
              });
              if (meetings.length > 0) {
                enrichment.sources.fathom.push({ owner: fk.owner, recording_count: meetings.length, match_method: 'summary_text' });
                await processFathomMeetings(meetings, fk, enrichment);
              }
            }
          } catch(e) { /* summary search fallback optional */ }
        }

        if (meetings.length === 0) {
          enrichment.sources.fathom.push({ owner: fk.owner, recording_count: 0, note: 'No matching meetings found' });
        }
      } else {
        var errText = '';
        try { errText = await fResp.text(); } catch(e) {}
        enrichment.sources.fathom.push({ owner: fk.owner, error: 'HTTP ' + fResp.status + ': ' + errText.substring(0, 200) });
      }
    } catch (e) {
      monitor.logError('enrich-proposal', e, {
        client_slug: contact.slug,
        detail: { stage: 'enrich_fathom', owner: fk.owner }
      });
      enrichment.sources.fathom.push({ owner: fk.owner, error: 'Failed to enrich from Fathom' });
    }
  }
  enrichment.summary.call_count = enrichment.data.calls.length;

  // ─── 3. Entity Audit Data ─────────────────────────────────────
  try {
    var audit = await sb.one('entity_audits?contact_id=eq.' + contactId + '&select=*&order=created_at.desc&limit=1');
    if (audit) {
      enrichment.sources.entity_audit = { id: audit.id, tier: audit.audit_tier, date: audit.audit_date, status: audit.status };
      enrichment.data.audit_scores = audit.scores || null;
      enrichment.data.audit_tasks = audit.tasks || null;
      enrichment.summary.has_audit = true;
    }
  } catch (e) { /* entity audit optional */ }

  // ─── 4. Also check campaign audit scores ──────────────────────
  try {
    var coreAudits = await sb.query('entity_audits?client_slug=eq.' + contact.slug + '&select=*&order=audit_date.desc&limit=1');
    if (coreAudits && coreAudits.length > 0) {
      enrichment.data.campaign_audit = {
        c_score: coreAudits[0].score_credibility,
        o_score: coreAudits[0].score_optimization,
        r_score: coreAudits[0].score_reputation,
        e_score: coreAudits[0].score_engagement,
        cres_score: coreAudits[0].cres_score,
        variance_score: coreAudits[0].variance_score,
        audit_date: coreAudits[0].audit_date
      };
    }
  } catch (e) { /* campaign audit optional */ }

  // ─── 5. Website Scan ──────────────────────────────────────────
  if (contact.website_url) {
    try {
      var wResp = await fetch(contact.website_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moonraker/1.0; +https://moonraker.ai/bot)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000)
      });
      if (wResp.ok) {
        var html = await wResp.text();
        // Extract useful metadata
        var titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
        var metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
        var h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);

        // Extract specialties/keywords from common therapy site patterns
        var bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .substring(0, 5000);

        enrichment.data.website_info = {
          url: contact.website_url,
          title: titleMatch ? titleMatch[1].trim() : '',
          meta_description: metaDescMatch ? metaDescMatch[1].trim() : '',
          h1: h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '',
          body_preview: bodyText.substring(0, 2000)
        };
        enrichment.sources.website = { url: contact.website_url, fetched: true };
        enrichment.summary.has_website = true;
      }
    } catch (e) {
      monitor.logError('enrich-proposal', e, {
        client_slug: contact.slug,
        detail: { stage: 'enrich_website', url: contact.website_url }
      });
      enrichment.sources.website = { url: contact.website_url, error: 'Failed to scrape website' };
    }
  }

  // ─── 6. Practice details from Supabase ────────────────────────
  try {
    var pd = await sb.one('practice_details?contact_id=eq.' + contactId + '&select=*&limit=1');
    if (pd) {
      enrichment.data.practice_details = pd;
    }
  } catch (e) { /* practice details optional */ }

  // ─── Save enrichment to proposal ──────────────────────────────
  if (proposalId) {
    try {
      await sb.mutate('proposals?id=eq.' + proposalId, 'PATCH', {
        status: 'review',
        enrichment_sources: enrichment.sources,
        enrichment_data: enrichment.data
      });
    } catch (e) {
      enrichment._save_error = e.message;
    }
  }

  // ─── Return results ───────────────────────────────────────────
  return res.status(200).json({
    ok: true,
    contact: {
      slug: contact.slug,
      name: searchName,
      email: searchEmail,
      domain: searchDomain,
      practice: practiceName
    },
    enrichment: enrichment
  });
};
