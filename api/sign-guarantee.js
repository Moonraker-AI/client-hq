// /api/sign-guarantee.js
// Client-facing endpoint for signing the Performance Guarantee from
// onboarding Step 9. Called when the user clicks the Sign button under the
// frozen document + signature block.
//
// Security model:
//   1. Page-token (scope='onboarding') is the ONLY accepted credential —
//      read from the HttpOnly cookie `mr_pt_onboarding`. Body must not carry
//      a contact_id; the token's verified contact_id is authoritative.
//   2. Contact must be in status ∈ {onboarding, active} and lost=false.
//   3. performance_guarantees.status must be 'locked'. Draft guarantees
//      cannot be signed — admin locks first, then client signs.
//   4. Already-signed-for-this-PG requests return 409 instead of double-
//      inserting. (The upgrade-mid-engagement flow that would supersede a
//      prior signed row happens on a NEW performance_guarantees row keyed
//      to the new commitment window, so the match here is scoped to
//      performance_guarantee_id, not contact_id.)
//   5. Service-role writes; row contents are bounded to the verified
//      contact_id and PG id.
//
// Side effects on success:
//   - INSERT into signed_performance_guarantees with frozen prose,
//     embedded signature image, and the benchmark snapshot.
//   - PATCH onboarding_steps where step_key='performance_guarantee'
//     to status='complete'. The auto_promote_to_active trigger fires if
//     this is the last pending step, flipping contact.status onboarding→active.
//   - Resend: confirmation email to the client + notification to support@.
//     Email failures log but don't fail the sign call — signing is idempotent
//     from the client's perspective once the row is committed.
//
// Rate limit: per-contact, 10 req/60s, fail-closed. Signing is rare and any
// burst probably indicates client-side double-click or bot activity.

var sb         = require('./_lib/supabase');
var pageToken  = require('./_lib/page-token');
var monitor    = require('./_lib/monitor');
var rateLimit  = require('./_lib/rate-limit');
var sanitizer  = require('./_lib/html-sanitizer');
var email      = require('./_lib/email-template');
var ghtml      = require('./_lib/guarantee-html');

var BASE_URL = 'https://clients.moonraker.ai';

function coerceSignerName(v) {
  if (typeof v !== 'string') return null;
  var name = sanitizer.sanitizeText(v, 200).trim();
  if (name.length < 2) return null;
  return name;
}

function coerceEmail(v) {
  if (typeof v !== 'string') return null;
  var e = v.trim();
  if (e.length < 3 || e.length > 320) return null;
  // Loose validation; Resend will reject a malformed address anyway.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function coerceSignatureImage(v) {
  if (typeof v !== 'string') return null;
  var s = v.trim();
  if (!s.length) return null;
  if (s.indexOf('data:image/') !== 0) return null;
  // Cap to 512KB to avoid gigantic payloads; realistic sigs are 20-80KB.
  if (s.length > 512 * 1024) return null;
  return s;
}

function extractClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) {
    // First value is the original client; strip potential port.
    var first = fwd.split(',')[0].trim();
    if (first.length <= 64) return first;
  }
  if (req.socket && req.socket.remoteAddress) {
    return String(req.socket.remoteAddress).substring(0, 64);
  }
  return null;
}

async function sendSignedEmails(contact, pg, signedRow) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { sent: false, error: 'RESEND_API_KEY not configured' };

  var firstName = contact.first_name || 'there';
  var practiceName = contact.practice_name ||
    ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() ||
    'your practice';

  var onboardingUrl = BASE_URL + '/' + encodeURIComponent(contact.slug) + '/onboarding';

  // 1. Client confirmation
  var clientHtml = email.wrap({
    headerLabel: 'Performance Guarantee Signed',
    content:
      email.greeting(firstName) +
      email.pRaw('Your Performance Guarantee is signed and active. Thank you for trusting us with ' + email.esc(practiceName) + '.') +
      email.pRaw('Here is what we have committed to together:') +
      email.pRaw('<strong>' + signedRow.guarantee_calls + ' organic consultation calls</strong> over the next 12 months, or we continue delivering at no additional cost until the benchmark is hit.') +
      email.pRaw('Total 12-month benchmark: <strong>' + signedRow.total_benchmark + ' organic calls</strong>.') +
      email.cta(onboardingUrl, 'View Your Onboarding') +
      email.pRaw('A signed copy of the document is preserved in your account and our records. If you have any questions, you can reply to this email and it will go to the Moonraker team.')
  });

  var results = [];
  try {
    var clientResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: email.FROM.notifications,
        to: [contact.email],
        cc: ['support@moonraker.ai'],
        reply_to: 'support@moonraker.ai',
        subject: 'Your Performance Guarantee is Signed',
        html: clientHtml
      })
    });
    var clientData = await clientResp.json();
    results.push({ kind: 'client', ok: !!clientData.id, id: clientData.id, error: clientData.error });
  } catch (e) {
    results.push({ kind: 'client', ok: false, error: (e && e.message) || 'fetch-error' });
  }

  // 2. Internal notification (to Scott + Chris)
  var internalHtml = email.wrap({
    headerLabel: 'PG Signed',
    content:
      email.pRaw('<strong>' + email.esc(practiceName) + '</strong> signed their Performance Guarantee.') +
      email.pRaw('<strong>Benchmark:</strong> ' + signedRow.guarantee_calls + ' calls / ' + signedRow.total_benchmark + ' total over 12 months.') +
      email.pRaw('<strong>Effective:</strong> ' + new Date(signedRow.commitment_start_at).toLocaleDateString('en-US', { timeZone: 'UTC' }) + ' through ' + new Date(signedRow.commitment_end_at).toLocaleDateString('en-US', { timeZone: 'UTC' })) +
      email.pRaw('<strong>Signer:</strong> ' + email.esc(signedRow.signer_name) + ' &lt;' + email.esc(signedRow.signer_email) + '&gt;') +
      email.cta(BASE_URL + '/admin/clients?slug=' + encodeURIComponent(contact.slug), 'Open in Client HQ')
  });

  try {
    var internalResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: email.FROM.notifications,
        to: ['scott@moonraker.ai', 'chris@moonraker.ai'],
        subject: 'Performance Guarantee signed — ' + practiceName,
        html: internalHtml
      })
    });
    var internalData = await internalResp.json();
    results.push({ kind: 'internal', ok: !!internalData.id, id: internalData.id, error: internalData.error });
  } catch (e) {
    results.push({ kind: 'internal', ok: false, error: (e && e.message) || 'fetch-error' });
  }

  var anyFail = results.some(function(r) { return !r.ok; });
  return { sent: !anyFail, results: results };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured())        return res.status(500).json({ error: 'Service not configured' });
  if (!pageToken.isConfigured()) return res.status(500).json({ error: 'Auth not configured' });

  var contact = null;
  var stage = 'init';

  try {
    // 1. Page-token → contact_id
    stage = 'verify_token';
    var submittedToken = pageToken.getTokenFromRequest(req, 'onboarding');
    if (!submittedToken) return res.status(403).json({ error: 'Page token required' });

    var tokenData;
    try {
      tokenData = pageToken.verify(submittedToken, 'onboarding');
    } catch (e) {
      console.error('[sign-guarantee] page-token verify threw:', e.message);
      return res.status(500).json({ error: 'Auth system unavailable' });
    }
    if (!tokenData) return res.status(403).json({ error: 'Invalid or expired page token' });
    var verifiedContactId = tokenData.contact_id;

    // 2. Rate limit (fail-closed; signing is rare and bursty patterns are suspect)
    stage = 'rate_limit';
    var rl = await rateLimit.check(
      'contact:' + verifiedContactId + ':pg-sign',
      10, 60, { failClosed: true }
    );
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(((rl.reset_at || new Date()) - new Date()) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }

    // 3. Validate inputs
    stage = 'validate_inputs';
    var body = req.body || {};
    var signerName     = coerceSignerName(body.signer_name);
    var signerEmail    = coerceEmail(body.signer_email);
    var signatureImage = coerceSignatureImage(body.signature_image);
    var consent        = body.consent === true;

    if (!signerName)     return res.status(400).json({ error: 'Signer name required (at least 2 characters).' });
    if (!signerEmail)    return res.status(400).json({ error: 'A valid email address is required.' });
    if (!signatureImage) return res.status(400).json({ error: 'A drawn signature is required.' });
    if (!consent)        return res.status(400).json({ error: 'You must accept the terms to sign.' });

    // 4. Load contact (state gate + monitoring context + slug binding + email)
    stage = 'load_contact';
    contact = await sb.one(
      'contacts?select=id,slug,email,first_name,last_name,practice_name,status,lost' +
      '&id=eq.' + encodeURIComponent(verifiedContactId) + '&limit=1'
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (contact.lost) return res.status(403).json({ error: 'Contact is no longer active' });
    if (body.slug && !pageToken.assertSlugBinding(body.slug, contact.slug)) {
      return res.status(403).json({ error: 'Page token not valid for this client' });
    }
    if (['onboarding', 'active'].indexOf(contact.status) === -1) {
      return res.status(403).json({ error: 'Contact not in a valid state to sign' });
    }

    // 5. Load the locked guarantee
    stage = 'load_guarantee';
    var pg = await sb.one(
      'performance_guarantees?select=*&contact_id=eq.' +
      encodeURIComponent(verifiedContactId) + '&limit=1'
    );
    if (!pg) return res.status(404).json({ error: 'No Performance Guarantee exists for this contact' });
    if (pg.status !== 'locked') {
      return res.status(409).json({ error: 'Performance Guarantee is not yet ready to sign' });
    }

    // 6. Already signed for this exact PG? (defensive; UI normally hides sign form)
    stage = 'check_existing_signed';
    var existingSigned = await sb.one(
      'signed_performance_guarantees?select=id,signed_at' +
      '&performance_guarantee_id=eq.' + encodeURIComponent(pg.id) +
      '&superseded_by=is.null&limit=1'
    );
    if (existingSigned) {
      return res.status(409).json({
        error: 'This Performance Guarantee has already been signed.',
        signed_at: existingSigned.signed_at
      });
    }

    // 7. Compute the frozen commitment window + re-render HTML server-side
    stage = 'render_html';
    var signedAtDate = new Date();
    var commitmentEnd = new Date(signedAtDate.getTime());
    commitmentEnd.setUTCFullYear(commitmentEnd.getUTCFullYear() + 1);

    var docHtml = ghtml.buildGuaranteeHtml(pg, contact, {
      effectiveStartDate: signedAtDate.toISOString(),
      effectiveEndDate:   commitmentEnd.toISOString()
    });
    var sigBlockHtml = ghtml.buildSignatureBlockHtml({
      signer_name:     signerName,
      signer_email:    signerEmail,
      signed_at:       signedAtDate.toISOString(),
      signature_image: signatureImage
    });
    var frozenHtml = docHtml + sigBlockHtml;

    // 8. INSERT signed_performance_guarantees
    stage = 'insert_signed';
    var userAgent = String(req.headers['user-agent'] || '').substring(0, 500) || null;
    var clientIp  = extractClientIp(req);

    var insertRow = {
      contact_id:                    verifiedContactId,
      performance_guarantee_id:      pg.id,
      version:                       1,
      superseded_by:                 null,
      commitment_start_at:           signedAtDate.toISOString(),
      commitment_end_at:             commitmentEnd.toISOString(),
      avg_client_ltv_cents:          pg.avg_client_ltv_cents,
      conversion_rate:               pg.conversion_rate,
      attendance_rate:               pg.attendance_rate,
      current_monthly_organic_calls: pg.current_monthly_organic_calls,
      investment_cents:              pg.investment_cents,
      value_per_call_cents:          pg.value_per_call_cents,
      guarantee_calls:               pg.guarantee_calls,
      total_benchmark:               pg.total_benchmark,
      benchmark_snapshot_json: {
        performance_guarantee_id: pg.id,
        locked_at:                pg.locked_at,
        snapshotted_at:           signedAtDate.toISOString(),
        source:                   'sign-guarantee v1'
      },
      guarantee_terms_html:          frozenHtml,
      signer_name:                   signerName,
      signer_email:                  signerEmail,
      signed_at:                     signedAtDate.toISOString(),
      ip_address:                    clientIp,
      user_agent:                    userAgent,
      signature_image:               signatureImage
    };

    var inserted = await sb.mutate(
      'signed_performance_guarantees',
      'POST',
      insertRow,
      'return=representation'
    );
    var signedRow = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!signedRow || !signedRow.id) {
      throw new Error('signed_performance_guarantees INSERT returned no row');
    }

    // 9. PATCH onboarding_steps: performance_guarantee → complete
    //    Row-level pending/in_progress → complete transition fires the
    //    auto_promote_to_active trigger for any contact still onboarding.
    stage = 'patch_step';
    var stepFilter = 'contact_id=eq.' + encodeURIComponent(verifiedContactId) +
                     '&step_key=eq.performance_guarantee' +
                     '&status=in.(pending,in_progress)';
    try {
      await sb.mutate('onboarding_steps?' + stepFilter, 'PATCH', {
        status:       'complete',
        notes:        'Signed by ' + signerName + ' on ' + signedAtDate.toISOString().substring(0, 10),
        completed_at: signedAtDate.toISOString()
      });
    } catch (e) {
      // Non-fatal: the signed row exists; step may already be complete
      // for active clients who signed a prior PG. Log + continue.
      try {
        await monitor.logError('sign-guarantee', e, {
          client_slug: contact.slug,
          detail: { stage: 'patch_step_non_fatal', signed_pg_id: signedRow.id }
        });
      } catch (_) {}
    }

    // 10. Notifications — never fail the sign if emails fail
    stage = 'send_emails';
    var emailResult = { sent: false, results: [] };
    try {
      emailResult = await sendSignedEmails(contact, pg, signedRow);
    } catch (e) {
      try {
        await monitor.logError('sign-guarantee', e, {
          client_slug: contact.slug,
          detail: { stage: 'send_emails_threw', signed_pg_id: signedRow.id }
        });
      } catch (_) {}
    }
    if (emailResult.results && emailResult.results.some(function(r){ return !r.ok; })) {
      try {
        await monitor.logError('sign-guarantee',
          new Error('one or more confirmation emails failed'), {
            client_slug: contact.slug,
            detail: { stage: 'email_partial_failure', signed_pg_id: signedRow.id, results: emailResult.results }
          });
      } catch (_) {}
    }

    return res.status(200).json({
      success:              true,
      signed_pg_id:         signedRow.id,
      signed_at:            signedRow.signed_at,
      commitment_start_at:  signedRow.commitment_start_at,
      commitment_end_at:    signedRow.commitment_end_at,
      emails_sent:          !!emailResult.sent
    });

  } catch (err) {
    try {
      await monitor.logError('sign-guarantee', err, {
        client_slug: contact && contact.slug,
        detail: { stage: stage }
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Signing failed' });
  }
};
