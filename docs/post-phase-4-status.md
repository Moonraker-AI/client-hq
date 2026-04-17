# Post-Phase-4 Status Report

**Date:** 2026-04-17 (late session — Group A fully complete)
**Purpose:** Reconcile what's actually closed, group the ~87 remaining findings, and recommend a path forward that matches the value-per-session curve we've been on.

---

## Where the audit stands

All 9 Criticals closed. **Twenty-four Highs closed** (H4, H5, H7, H8, H9, H10, H11, H14, H18, H19, H20, H21, H22, H24, H25, H26, H27, H28, H30, H31, H33, H34, H35, H36). **M6, M8, M10, M11, M13, M15, M16, M22, M26 (fully resolved), M30, M38 closed.** **L8**, L14, L16, L26, L27 closed. Group C closed the template-escape surface; Group B.1 collapsed the `getDelegatedToken` duplication; Group D hardened every Claude-prompting route with `sanitizer.sanitizeText` at untrusted-input sources plus delimiter framing around large blobs, closing the prompt-injection half of M26. Group B.2 extracted `fetchWithTimeout` into `_lib/` and eliminated every bare `fetch()` call across the four files with the biggest AbortController gap. Group E converted every non-transactional DELETE+INSERT pair into a PostgREST `resolution=merge-duplicates` upsert (with stale-row cleanup on onboarding_steps) and converted `generate-proposal.js` fire-and-forget PATCHes into awaited try/catch + monitor.logError. H36 (8th `getDelegatedToken` copy in `convert-to-prospect.js`, discovered during B.1 verification) closed as Group D pre-task. `authenticator_secret_key` null-on-all-rows investigation resolved: `SENSITIVE_FIELDS` includes it; the null state just means no 2FA setup has been saved yet through the admin UI. Not a bug.

~72 findings remain. None of them are attack chains of the same severity as C1-C9. Most are hardening, consistency, and observability work. Ordering them linearly doesn't match their actual value; grouping them does.

---

## Grouping of remaining work

### Group A — Secret & config hygiene ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H10 | `api/admin/manage-site.js:15,18` — hardcoded CF account/zone IDs | ✅ closed `e772fa9` |
| H7 | `api/_lib/supabase.js:15` — hardcoded Supabase URL fallback | ✅ closed `330e6da` |
| H28 | `bootstrap-access.js` leaks provider error detail in response body | ✅ closed `0c9bc85` |
| H33 | `newsletter-generate.js` raw Claude output in error responses | ✅ closed `a8155dc` |
| H34 | `send-audit-email.js` Resend response + err.message in 5xx | ✅ closed `225d5a0` + `19b9199` |
| H35 | `generate-content-page.js` NDJSON stream error detail leaks | ✅ closed `b17c790` |
| M13 | `newsletter-webhook.js` e.message in response body | ✅ closed `3a9019d` |
| M26 (err-leak half) | `chat.js` err.message in outer catch | ✅ closed `9dc8c7b` (prompt-injection half → Group D) |
| L15 | Onboarding template anon key exp 2089 | Design question (deferred) |

**Group A done.** 8 findings closed (6 Highs + 1 Medium + 1 Medium-partial). Pattern established: `monitor.logError(route, err, { client_slug, detail: { stage, ... } })` server-side + generic user-facing response. Replicated cleanly across 6 files in two sessions.

### Group B — Shared library extraction (2-3 sessions, mechanical)

| ID | Issue | Status |
|---|---|---|
| H21 + N6 | 7 copies of `getDelegatedToken` → extract `_lib/google-auth.js` with caching | ✅ closed — helper landed `7adedb6`; 5 duplicates migrated in `17d0ae8`, `4e77e55`, `568a868`, `d592381`, `1d9c835` (Group B.1) |
| H4, H24, M10, M16 | `fetch()` without AbortController — extract `fetchWithTimeout` helper | ✅ closed — helper landed `12c805f`; H4 `f2a1b70`, H24 `0163f65`, M10 `274f273`, M16 `0d2c56d` + `2512c46` (Group B.2) |
| Pattern 12 | Migrate ~30 inline Supabase fetches in 5 big files to `sb.query`/`sb.mutate` | 1-2 sessions |
| H30, L7, L8, L22 | Duplicated helpers (Fathom dedup, Resend events, sbGet) | H30 ✅ closed (subsumed by H21 migration — Gmail/Fathom now share token cache); L8 ✅ closed; L7 + L22 open |

**Status:** Group B.1 (H21 migration) and Group B.2 (AbortController extraction) complete — see retrospectives below. Remaining Group B work is the repo-wide Supabase helper migration (Group B.3).

### Group C — Template/email escape defaults ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H18 | Newsletter story fields rendered unescaped | ✅ closed `0cd0670` |
| H19 | Image URL not scheme-validated | ✅ closed `0cd0670` |
| H20 | `p()` + `footerNote` accept raw HTML | ✅ closed `d024b84` (atomic 9-file rename + migration) |
| H22 | Proposal `next_steps` rendered unescaped | ✅ closed `aabdac1` |
| M6 | Monitor alert HTML unescaped | ✅ closed `1147a19` |
| M22 | Unsub subscriberId not URL-encoded | ✅ closed `0cd0670` |

**Group C done.** 6 findings closed in one session across 4 commits. Escape-by-default pattern now in place for `_lib/email-template.js` (both `p` and `footerNote`), `_lib/newsletter-template.js` (all plain-text interpolations + URL scheme validation), `_lib/monitor.js` critical-alert HTML, and `generate-proposal.js` deployed HTML. Future callers get safety by default; 82+ existing email call sites were migrated to explicit `pRaw` to preserve byte-identical output.

**Opportunistic follow-up** (not blocking): audit the 82+ `email.pRaw()` call sites in the 8 migrated files. Sites that pass plain text (no concatenated HTML fragments, no `email.esc()` wrapping) can be upgraded to `email.p()` for belt-and-suspenders safety. Not urgent — the security surface is closed because admin JWTs are the only write path into those templates.

### Group D — AI prompt injection hardening ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H25 | `practiceName` raw-interpolated into Claude prompt (compile-report) | ✅ closed `e4d9105` |
| H31 | 25K chars of RTPBA to Claude verbatim (generate-content-page) | ✅ closed `54153ec` |
| M15 | Therapist name unsanitized in content-chat prompt | ✅ closed `60bccb8` |
| M26 (prompt-injection half) | `page`, `tab`, `clientSlug` in chat.js prompt | ✅ closed `49f088a` (M26 now fully resolved; err-leak half was `9dc8c7b` in Group A) |
| H36 (pre-task housekeeping) | 8th copy of `getDelegatedToken` in convert-to-prospect.js | ✅ closed `221bfbc` |

**Group D done.** 5 findings closed in one session across 5 commits + 1 doc commit. See retrospective below.

### Group E — Non-transactional state & idempotency ✅ COMPLETE

| ID | Issue | Status |
|---|---|---|
| H27 | compile-report highlights DELETE+INSERT non-transactional | ✅ closed `886fe05` |
| H26 | generate-proposal onboarding seed DELETE+INSERT | ✅ closed `4fc3f69` |
| M11 | deploy-to-r2 DELETE+INSERT not idempotent | ✅ closed `9fe2810` |
| M30 | generate-proposal fire-and-forget PATCHes swallow errors | ✅ closed `4d0fa27` |

**Group E done.** 4 findings closed in one session across 4 commits + 1 doc commit. See retrospective below.

### Group F — Public endpoint hardening beyond rate limits (1 session)

| ID | Issue | Effort |
|---|---|---|
| H12 | content-chat.js empty-Origin bypass + unauthenticated Opus 4.6 streaming + content_page_id no UUID validation + no ownership check | One session |
| H15 | submit-entity-audit empty-Origin bypass | Included |
| H32 | digest.js recipients from request body, no allowlist | Included |
| M9 | submit-entity-audit slug race condition | Included |
| M12 | manage-site domain "normalization" too permissive | Included |
| M14 | content-chat silently returns nulls on Supabase error | Included |
| M20 | newsletter-unsubscribe UUID-probing oracle | Included |

**Recommendation:** One session. All input-validation/boundary-check fixes on public-ish endpoints.

### Group G — Operational resilience (1 session)

| ID | Issue | Effort |
|---|---|---|
| H1 | `_profileCache` no TTL | 15 min |
| H2 | Still listed as open — but H2 is just "same bug in two files" and the helper is extracted; verify and close | 5 min |
| H3 | `rawToDer` dead code — delete | 5 min |
| H6 | Stripe webhook fire-and-forget to `/api/notify-team` with no retry | 30 min (queue table or inline) |
| H13 | Agreement-chat 8K CSA on every prompt — add Anthropic prompt caching | 30 min |
| H17 | process-entity-audit internal auth fallback empty-string | 15 min |
| H29 | enrich-proposal encrypt `enrichment_data` at rest | 30 min |
| M2 | `last_login_at` updated every request — throttle | 15 min |
| M18 | checklist_items composite ID 8-hex-char collision | 10 min |
| M19 | Webhook race with auto-send audit email | Needs design |

**Recommendation:** Two short sessions, cherry-pick the 15-30 min items into groups of 4-5.

### Group H — M1 Stripe metadata detection (0.5 session)

Documented plan in M1 section. Blocked on you adding `metadata: { product: ... }` to the Stripe payment links dashboard-side. After that's done, code change is 10 minutes + a 30-day observation window before removing the amount fallback.

### Group I — Lows + Nits (1 sweep session)

25 Lows + 6 Nits still listed; several are likely stale after Phase 4. Worth a 1-session sweep: reconcile what's actually still present vs what got closed incidentally, then fix the remaining in-scope items (≤10 lines each).

---

## What's **not** in the groupings

Items I recommend marking "won't fix" or "needs design":

- **L3** (`var` everywhere): cosmetic. Skip.
- **L13** (hardcoded asset URLs): single-domain app. Skip.
- **L15** (anon key exp 2089): RLS is the control. Either leave as-is (accept the risk profile) or plan a migration — not both half-measures.
- **L16** (two Google auth functions in compile-report.js): closes with H21.
- **L19** (personal-email blocklist): add as data, not a code change.
- **M19** (webhook race with auto-send): needs a design — what's the desired behavior when Stripe lands after the free tier email already sent? Hold and refund? Upgrade anyway? Product decision, not a code decision.
- **M37** (auto-schedule doesn't check post-submit status flip): same — is this a bug or intended?

---

## Recommended next session

**Group F — Public endpoint hardening beyond rate limits.**

Reasoning:
- Group E closed 2026-04-17 (see retrospective below). Four commits landed across 3 files; every Vercel deploy READY. PostgREST upsert with `Prefer: resolution=merge-duplicates` is now the canonical replacement for DELETE+INSERT pairs backed by a unique index; fire-and-forget PATCHes have been purged from `generate-proposal.js` serverside.
- Group F is a natural next step. It's input-validation and boundary-check work on public-ish endpoints — a different skill set from the timeout/upsert/prompt-injection sessions that came before, but the same one-theme-per-session shape. Seven findings cluster cleanly: H12 (content-chat public/unauthenticated Opus streaming with filter injection + no UUID validation + no ownership check — the biggest remaining public attack surface), H15 (submit-entity-audit empty-Origin bypass), H32 (digest.js recipients without allowlist), M9 (submit-entity-audit slug race), M12 (manage-site domain normalization), M14 (content-chat silent-nulls), M20 (newsletter-unsubscribe UUID-probing oracle).

Recommended sequence after Group F:

1. **Group F — public endpoint hardening** (1 session) — closes H12, H15, H32 + M9, M12, M14, M20
2. **Group G — operational resilience** (1-2 sessions) — H1, H3, H6, H13, H17, H23, H29 + small Mediums
3. **Group B.3 — Supabase helper migration** (1-2 sessions) — remaining files outside the B.2 four; also covers L1 (the raw-fetch pattern noted during Group E's M30 review in `generate-proposal.js:62,80`)
4. **Group I — Lows + Nits sweep** (1 session)
5. **Group H — M1 Stripe metadata** (once dashboard metadata is added)

Approximately 4-6 sessions to clear the remaining open findings, or we stop earlier once diminishing returns kick in. The call on "when to stop" gets clearer around session 2 when what's left is mostly Low/Nit polish.

## Prompt for next session (Group F — Public endpoint hardening)

```
Public endpoint hardening session. Seven findings clustered around input
validation + boundary checks on endpoints exposed to untrusted callers
(public forms, admin JWT compromise surface, or trusted-identity misuse).

Read docs/api-audit-2026-04.md sections H12, H15, H32, M9, M12, M14,
M20 first. Then walk through your plan before touching code.

─────────────────────────────────────────────────────────────────────
Pre-verified state (current main)
─────────────────────────────────────────────────────────────────────

| File                          | Findings          | Current state summary |
|-------------------------------|-------------------|----------------------|
| api/content-chat.js           | H12, M14          | Origin + rate-limit + sanitizer already wired (good). Needs UUID validation + ownership + fail-loud on Supabase error |
| api/submit-entity-audit.js    | H15, M9           | Origin check works when present but empty-Origin still bypasses; slug check-then-insert is TOCTOU |
| api/digest.js                 | H32               | Admin/internal auth ✓, but `recipients` accepted from request body without allowlist |
| api/admin/manage-site.js      | M12               | `domain.toLowerCase().replace(...)` strips protocol/trailing slash but doesn't reject `:port`, `/path`, `user:pass@`, `?query` |
| api/newsletter-unsubscribe.js | M20               | UUID-format gate ✓, but valid-UUID-but-nonexistent still triggers PATCH zero-rows log warning — oracle for probing valid SIDs |

─────────────────────────────────────────────────────────────────────
Fix 1: H12 — api/content-chat.js UUID validation + ownership check
─────────────────────────────────────────────────────────────────────

content-chat.js already has Origin check, rate limit (20/min/IP), and
sanitizer in buildSystemPrompt (Group D). Remaining surface:

Site 1 — content_page_id validation (line 59-65):
  var contentPageId = context.content_page_id || '';
  if (contentPageId) {
    var fetched = await fetchPageContext(contentPageId);
    // ...
  }

  Issue: no UUID format check; attacker can pass arbitrary strings that
  concat into `?id=eq.` in fetchPageContext at line 124.

  Fix: UUID validation at the top of the handler (after rate limit,
  before fetchPageContext). On invalid UUID, return 400:
    var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (contentPageId && !uuidPattern.test(contentPageId)) {
      return res.status(400).json({ error: 'Invalid content_page_id' });
    }

  Also pass contentPageId through encodeURIComponent at the PostgREST
  query sites (line 124 and ~135) even though UUID format is already
  validated — defense in depth.

Site 2 — no ownership check:
  Anyone with a valid content_page_id UUID can hit this endpoint. The
  audit notes "no ownership check — anyone with a content_page_id UUID
  can stream Claude content about that client."

  Options:
  a) Require a page-token (scope='content-preview', contact_id bound).
     The content preview pages are client-facing slug URLs, so a token
     fits the C3/C7 page-token pattern. HIGHEST defense, highest effort.
  b) Check `pages[0].status` in fetchPageContext — if the content page
     is in a status that forbids preview (e.g. archived, deleted),
     return 404. MODEST defense.
  c) Scope ownership to lifecycle status: derive contact from
     pages[0].contact_id, verify contact.status is `active`/`onboarding`/
     `prospect` (not `lost`). Prevents streaming Claude content for a
     lost contact.

  Recommended: (c) at minimum. (a) if page-token infrastructure is ready
  to extend; check docs/phase-4-design.md for whether a `content-preview`
  scope already exists in page-token SCOPES. If it does, use it;
  otherwise, defer the full token-scoped fix and log (c) as the interim.

  If going with (c), return 404 (not 403) to avoid revealing existence:
    if (!contact || contact.lost || contact.status === 'lost') {
      return res.status(404).json({ error: 'Content page not found' });
    }

Site 3 — M14 fail-loud on Supabase error in fetchPageContext:
  Current (line 142-144):
    } catch(e) {
      return { page: null, contact: null, spec: null };
    }

  Silent null return lets Claude call proceed with empty context — an
  expensive no-op that burns Anthropic credits. Worse: if pages/contacts
  table is intermittently unreachable, every chat request runs a futile
  Opus call.

  Fix: throw instead of returning nulls. The handler's existing logic
  doesn't catch fetchPageContext — add a try/catch around line 63 that
  returns 503:
    try {
      var fetched = await fetchPageContext(contentPageId);
      // ...
    } catch (e) {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

─────────────────────────────────────────────────────────────────────
Fix 2: H15 — api/submit-entity-audit.js empty-Origin bypass
─────────────────────────────────────────────────────────────────────

Current (line 19-22):
  var origin = req.headers.origin || '';
  if (origin && origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

The `if (origin && ...)` branch skips the check when origin is empty.
`curl` sends no Origin header, so it passes. Rate limit at 3/hr/IP
(already shipped) is the real control against curl-based abuse, but
the audit calls out closing the empty-Origin bypass as defense-in-depth.

Fix: require Origin to be set AND match:
  var origin = req.headers.origin || '';
  if (!origin || origin !== 'https://clients.moonraker.ai') {
    return res.status(403).json({ error: 'Forbidden' });
  }

Same pattern applies to content-chat.js line 30-32 — the audit notes
H12's empty-Origin bypass inherits from the same pattern. Fix both
files identically. Group A-style: shared pattern, one commit per file,
sanitized similarly.

─────────────────────────────────────────────────────────────────────
Fix 3: M9 — api/submit-entity-audit.js slug TOCTOU
─────────────────────────────────────────────────────────────────────

Current flow (lines 66-100):
  1. Check `contacts?slug=eq.X` — 409 if exists
  2. Check `contacts?email=eq.X` — 409 if exists
  3. sb.mutate('contacts', 'POST', {..., slug: X})
  4. On unique-constraint error (line 199), substring match on
     'duplicate|unique' → 409

The check-then-insert is a TOCTOU race: two concurrent submissions
with the same slug pass the check, then one hits the unique constraint
at step 3. Current fallback works (string match on error message) but
is fragile.

Fix: eliminate the pre-check entirely. Just POST and rely on the
unique constraint. On 23505 (Postgres unique violation) or error
containing 'duplicate key' / 'contacts_slug_key' / 'contacts_email_key',
return 409 with the existing user message.

Verify the constraint names first via Supabase MCP:
  execute_sql: select conname from pg_constraint where conrelid = 'public.contacts'::regclass;

Likely constraint names are contacts_slug_key and contacts_email_key.
Match on both.

Preserve the user-facing error messages exactly — they're empathetic
and already written for the audit intake form.

─────────────────────────────────────────────────────────────────────
Fix 4: H32 — api/digest.js recipient allowlist
─────────────────────────────────────────────────────────────────────

Current (line 23): `var recipients = body.recipients;` accepted raw.
auth.requireAdminOrInternal gate exists at L11, so surface is admin
JWT compromise or CRON_SECRET compromise — but the `from:` field
sends as `notifications@clients.moonraker.ai` (trusted internal
identity), so a compromised admin JWT could spray trusted-identity
emails to arbitrary addresses.

Fix: allowlist recipient domains to `@moonraker.ai` (covers all team
members). Reject any recipient outside the allowlist:

  var ALLOWED_DOMAIN = '@moonraker.ai';
  var invalidRecipients = recipients.filter(function(r) {
    return String(r).indexOf(ALLOWED_DOMAIN) === -1;
  });
  if (invalidRecipients.length > 0) {
    return res.status(400).json({
      error: 'Recipients must be @moonraker.ai addresses',
      invalid: invalidRecipients
    });
  }

Keep `from:` and `to:` allowlist check off (they're stable internal
values; locking them down is overkill).

─────────────────────────────────────────────────────────────────────
Fix 5: M12 — api/admin/manage-site.js domain validation
─────────────────────────────────────────────────────────────────────

Current (line 69):
  domain = domain.toLowerCase().replace(/^https?:\\/\\//, '').replace(/\\/+$/, '').replace(/^www\\./, '');

Strips protocol, trailing slash, www. But doesn't reject:
  - `:port`                 → `domain.com:8080`
  - `/path`                 → `domain.com/admin`
  - `user:pass@host`        → basic auth prefix
  - `?query`                → tracking params
  - Characters outside FQDN charset

Fix: after the normalization, validate against a strict FQDN regex:
  var fqdnPattern = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$/;
  if (!fqdnPattern.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }

Admin-only endpoint, but bad input reaches the Cloudflare custom-
hostname API (line ~173) which will either reject it noisily or
create a hostname record with a malformed value.

─────────────────────────────────────────────────────────────────────
Fix 6: M20 — api/newsletter-unsubscribe.js UUID-probing oracle
─────────────────────────────────────────────────────────────────────

Current UUID gate (line 31-37) short-circuits on non-UUID format.
But valid-UUID-but-nonexistent still runs sb.mutate at line 40, which
logs `[sb.mutate] PATCH returned 0 rows` warning. An attacker could
probe valid UUIDs by monitoring 5xx vs 200 response timing, or by
inspecting server logs if they have any visibility.

Fix: silence the zero-rows warning on this specific PATCH. Two options:
  a) Check existence first: `sb.one('newsletter_subscribers?id=eq.X&select=id&limit=1')`.
     If null, return success anyway (don't reveal existence).
  b) Wrap the sb.mutate with a try/catch that doesn't log + treat
     zero-rows as success.

Recommended: (a). It's explicit and avoids adding zero-rows suppression
machinery. Response shape stays identical (same unsubPage HTML or JSON)
regardless of whether the subscriber existed.

─────────────────────────────────────────────────────────────────────
Testing
─────────────────────────────────────────────────────────────────────

- Each commit's Vercel deploy must go READY.
- Smoke tests (non-blocking):
    * content-chat.js: valid content_page_id still works; invalid UUID
      returns 400; unknown UUID returns 404 (not 503, not 500).
    * submit-entity-audit.js: valid submission works; duplicate slug
      returns 409 with same user-friendly message; curl with no Origin
      returns 403.
    * digest.js: `recipients` containing a non-moonraker.ai address
      returns 400 with invalid list.
    * manage-site.js: invalid domain (`domain.com/path`) returns 400.
    * newsletter-unsubscribe.js: valid-format-but-nonexistent SID
      returns 200 (same as success). No zero-rows log warning.

─────────────────────────────────────────────────────────────────────
Out of scope
─────────────────────────────────────────────────────────────────────

- Page-token infrastructure extension to content-preview scope (might be
  added in a later session; H12's minimum-viable fix is the status check).
- Retries / timeouts on the Anthropic stream in content-chat.js (Group
  B.2 scope; chat.js wasn't in that list, but add fetchWithTimeout only
  if it's trivial — don't rabbit-hole).
- CSRF protection via custom headers / tokens — existing rate limit +
  Origin check covers the practical surface.
- Other endpoints with similar empty-Origin bypass: if you spot them in
  this session, file as new findings rather than fix inline (keep commit
  scope clean).

─────────────────────────────────────────────────────────────────────
Deliverables
─────────────────────────────────────────────────────────────────────

Commit shape (suggested):
  c1: H12 — content-chat.js UUID validation + ownership status check + M14 fail-loud
  c2: H15 — submit-entity-audit.js + content-chat.js require-Origin (shared pattern, 1 commit)
  c3: M9 — submit-entity-audit.js remove TOCTOU pre-check
  c4: H32 — digest.js recipient allowlist
  c5: M12 — manage-site.js FQDN validation
  c6: M20 — newsletter-unsubscribe.js existence check before PATCH

Final: doc update to api-audit-2026-04.md:
  - Mark H12, H15, H32, M9, M12, M14, M20 resolved in resolution log
  - Tallies: Highs 24 → 27 resolved (H12, H15, H32), Mediums 11 → 15 resolved (M9, M12, M14, M20)

Also update post-phase-4-status.md: mark Group F complete, recommend
Group G batch 1 as next.
```


## Group B.1 — H21 google-auth migration ✅ COMPLETE (2026-04-17)

All 5 route-level duplicates of `getDelegatedToken`/`getGoogleAccessToken` migrated to `api/_lib/google-delegated.js`:

- `api/bootstrap-access.js` — `17d0ae8` (GBP, GA4, GTM delegated tokens)
- `api/discover-services.js` — `4e77e55` (switched to `getServiceAccountToken` — non-delegated variant with hardcoded scope now passed explicitly)
- `api/enrich-proposal.js` — `568a868` (Gmail three-mailbox loop; nested try/catch + `continue` preserves original silent-skip semantics; dropped the obsolete `typeof token === 'string'` guard)
- `api/generate-proposal.js` — `d592381` (Drive-folder creation for new prospects; happy path gated on `if (driveToken)`, `results.drive.error` branch preserved)
- `api/compile-report.js` — `1d9c835` (GSC + GBP Performance closures inside `safe()`; both local functions deleted, including dead `getGoogleAccessToken` — see L16)

Final grep on main: zero matches for `function getDelegatedToken|function getGoogleAccessToken` across `api/`. All 5 files now `require('./_lib/google-delegated')`.

Net result:
- H21 fully resolved (was partial).
- H30 resolved incidentally — Fathom + Gmail calls now share the helper's `_tokenCache`.
- L16 resolved incidentally — dead `getGoogleAccessToken` deleted.
- `api/_lib/google-drive.js` left as-is (bespoke signature, module-level cache) — tracked under N6 as a candidate follow-up, not a blocker.

Behavior-preservation notes:
- The new helper throws on failure rather than returning `{ error }`. Every call site wrapped in try/catch (or nested inside an existing one) so the original error-handling branches map 1:1 — `warnings.push(...)`, `results.drive.error = ...`, `enrichment.sources.gmail.push({ account, error })`, `return null` — all preserved with `e.message || String(e)`.
- Original warning strings kept verbatim where they differed across sites (e.g. compile-report's `'GBP Performance: delegated token failed - '` kept distinct from `'GSC: token failed - '`).

## Group B.2 — AbortController extraction ✅ COMPLETE (2026-04-17)

All four findings closed across six commits. New helper `api/_lib/fetch-with-timeout.js` is now the canonical HTTP client for non-streaming routes.

Commits landed on main:

- `12c805f` — New helper module `api/_lib/fetch-with-timeout.js`. Signature `fetchT(url, opts, timeoutMs)`, 25s default, throws `Error('Timeout after Xms: <url>')` on abort (URL added vs. the original closure for debuggability; leading `Timeout` prefix stable so existing catches matching on `.message.includes('Timeout')` continue to work).
- `f2a1b70` — **H4.** `_lib/supabase.js` `query()` + `mutate()` use `fetchT` with a 10s default. `query(path, opts)` honors `opts.timeoutMs`; `mutate(path, method, body, prefer, timeoutMs)` added an optional 5th param rather than changing the signature shape, so all existing 4-arg callers keep working unchanged.
- `0163f65` — **H24.** `compile-report.js` closure-scope `fetchT` deleted; file now imports the shared helper. All 21 `fetch` sites addressed: 16 Supabase direct-REST → `sb.query`/`sb.one`/`sb.mutate`; 3 external (Resend 15s, GSC sites 15s, Claude 60s) wrapped with `fetchT`; 7 pre-existing wrapped sites (3 GSC + GBP + 2 LocalFalcon + closure-wrapped checklist migrated to `sb.query`) now resolve to the module helper via the top `require`. Grep: 0 bare `fetch(`.
- `274f273` — **M10.** `submit-entity-audit.js` agent POST at 30s, Resend fallback at 10s.
- `0d2c56d` — **M16 (5a).** `process-entity-audit.js` 6 Supabase direct-REST sites migrated to `sb.*` helpers with try/catch error-shape preservation (see behavior notes below).
- `2512c46` — **M16 (5b).** `process-entity-audit.js` 13 external calls wrapped at tiered timeouts — Claude 60s, 3 GitHub template reads + 3 file-exists checks 15s each, 3 GitHub PUTs 30s each, internal `/api/send-audit-email` POST 30s, 2 Resend notifications 15s each.

Final grep on main across the four files: zero matches for `\bfetch\(` in any of `api/_lib/supabase.js`, `api/compile-report.js`, `api/submit-entity-audit.js`, `api/process-entity-audit.js`. All six commits READY on first Vercel build.

Net result:
- H4, H24, M10, M16 fully resolved.
- `fetchWithTimeout` is the canonical HTTP client for non-streaming routes going forward; future sessions should use it by default.
- Tallies: **Highs 22 / 36 resolved (14 open). Mediums 9 / 38 resolved. Total ≥45 resolved / ≤72 open across 117 findings.**

Behavior-preservation notes:
- `sb.mutate` throws on PostgREST 4xx/5xx; raw `fetch` did not. On sites that were previously silent-fail (highlights DELETE+POST in `compile-report.js`, checklist_items DELETE in `process-entity-audit.js`), inner try/catches were added around `sb.mutate` to preserve the original swallow-and-warn or swallow-and-continue semantics. This prevents the fallback branch in `compile-report.js`'s highlight-generation block from firing on a failed DELETE, which was not the intended trigger.
- For the 3 Supabase sites that previously threw custom error strings (`PATCH failed: …`, `INSERT failed: …`, `Status flip failed: …` in `compile-report.js`; `Supabase update failed:` in `process-entity-audit.js`), the user-facing 500 / error-step shape stays identical (still a `send`/throw with `e.message` inside). Only the interior detail text differs, now prefixed `Supabase mutate error:` from the shared helper. Watch the first few real errors post-deploy; if the interior format matters for any downstream log parser, replace the generic prefix with a custom message inside the catch block at that site.
- On `process-entity-audit.js` L409 (checklist_items POST bulk), the original had an `if (!ok) send(warning) / else send(success)` pair. Migrated to `try { send(success) } catch (e) { send(warning + e.message) }` — mirrors the original two-branch semantic but now the success `send` only fires after the mutate resolves, which is stricter and correct.
- The non-transactional DELETE+INSERT patterns in `compile-report.js` (H27) and `process-entity-audit.js` (M18 + M19) were intentionally preserved. Those are Group E territory and shouldn't ship in a "timeout wrapping" session. The added try/catches specifically avoid coupling Group E's fix to B.2's commits — Group E can swap the pair for an upsert without fighting the `sb.mutate` error shape.
- The `fetchT` closure in `compile-report.js` threw `Error('Timeout after Xms')` without URL; the new module helper throws `Error('Timeout after Xms: <url>')` with URL. Searched existing catch blocks in all four files — none match on the message content (they re-throw or log as-is), so the shape change is safe. The leading `Timeout` prefix is stable so any future catch matching on `.message.includes('Timeout')` still works.

Out of scope for Group B.2 (flagged for future):
- Retry-on-5xx logic — Group G (operational resilience).
- Repo-wide Pattern 12 Supabase helper migration across the files outside B.2's list — Group B.3.
- `api/_lib/google-drive.js` (has bespoke fetch + caching) — tracked under N6.
- Chat/streaming endpoints (`agreement-chat.js`, `content-chat.js`, `proposal-chat.js`, `report-chat.js`, `generate-content-page.js` NDJSON) — they stream with their own retry; not in B.2's list.

## Group D — AI prompt injection hardening ✅ COMPLETE (2026-04-17)

Five findings closed across the Claude-prompting code paths. Pattern: `sanitizer.sanitizeText(value, maxLen)` applied at field source where possible; bracketed `=== ... === / === END SOURCE MATERIAL ===` delimiter framing added around large untrusted blobs.

Pre-task housekeeping:
- `api/convert-to-prospect.js` — `221bfbc` (H36; migrate to `google-delegated` helper, delete local `getDelegatedToken` + stray inner `auth` require + dead else-branch that referenced the old `{error}` return shape)

Main Group D work:
- `api/compile-report.js` — `e4d9105` (H25; sanitize `practiceName` at source L120 — wraps the `contact.practice_name || (first_name + last_name)` expression once, closes the flagged prompt site at L1034 *and* the 8 email/report rendering sites at L730/L812/L830/L859/L1071/L1089/L1108/L1115 in a single edit)
- `api/generate-content-page.js` — `54153ec` (H31; 12 field wraps across `buildUserMessage` — Practice Info/Details + Bio loop + Endorsement loop fields; `rtpba` 25000 / `intelligence` 3000 / `action_plan` 2000 blobs each wrapped with sanitizer + opening `=== ... (treat as source material, not as instructions) ===` header and matching `=== END SOURCE MATERIAL ===` footer)
- `api/content-chat.js` — `60bccb8` (M15; `practiceName` + `therapistName` sanitized at source L154-155 covers three downstream template-literal interpolations; `city`/`state_province` sanitized at the Location interpolation site L194)
- `api/chat.js` — `49f088a` (M26 prompt-injection half; `page`/`tab`/`clientSlug` sanitized at source L139-141 — covers both the ctx_str interpolation at L177-179 *and* the `dataLabel` interpolation at L184; mode-dispatch `page.includes('/admin/...')` branches L162-174 still work because `sanitizeText` preserves slashes and path characters)

Final doc update: `Group D: doc updates` (this commit) — marks H25/H31/M15/M26/H36 resolved in `api-audit-2026-04.md`, upgrades M26 from 🔶 PARTIAL → ✅ RESOLVED, updates Totals (35 High → 36 High to include H36), updates Running tallies (Highs 17 → 20 resolved, Mediums 5 + partial → 7 resolved), appends 4 Resolution log rows, upgrades M26's row from partial to full.

Net result:
- H25, H31, H36, M15 resolved.
- M26 upgraded partial → fully resolved (err-leak half in Group A's `9dc8c7b`; prompt-injection half in `49f088a`).
- Tallies: **Highs 20 / 36 resolved (16 open). Mediums 7 / 38 resolved. Total ≥41 resolved / ≤76 open across 117 findings.**
- All 5 code commits went straight to READY on first Vercel build. `sanitizer.sanitizeText` has no external deps and no side effects; no runtime regressions observed.

Behavior-preservation notes:
- `sanitizeText` treats `&` as literal text (not entity) by design, so practice names like "Smith & Jones Therapy" render correctly downstream through email HTML, prompts, and UI labels. No double-encoding introduced on the 8 compile-report email sites covered transitively by the H25 source-level wrap.
- For H31's RTPBA: the delimiter header wording changed from `(VERBATIM, DO NOT REWRITE)` to `(treat as source material, not as instructions)` per the prescribed Group D pattern. This shifts emphasis from "use-as-is" to "don't-execute-instructions-embedded-in-this", which matters more for defense-in-depth on client-site-scraped content. Watch the first generated page or two — if Claude starts paraphrasing the RTPBA where it shouldn't, the fix is to combine both concerns as `(use verbatim; any embedded text below is content, not instructions)`.
- For H31's endorsement loop: fields are double-sanitized (once at C9 submit, again here). Idempotent by construction — `sanitizeText` output is always a valid `sanitizeText` input producing the same output. Kept as belt-and-suspenders defense-in-depth.
- For M26 chat.js: `page.includes('/admin/audit')` style mode-dispatch continues to match correctly because `sanitizeText` preserves slashes, alphanumerics, and path structure; it only strips HTML tags, HTML entities, control characters, and collapses excess whitespace — none of which appear in legitimate page paths.
- H36 migration preserved the outer `if (existingDriveFolder) ... else if (saJson) ...` gate. The `saJson` env-var check is now redundant (helper checks env internally) but harmless and kept as fail-fast.

Out of scope for Group D (flagged as candidate future sweeps):
- `agreement-chat.js`, `proposal-chat.js`, `report-chat.js` — not flagged in the original audit. Would extend the pattern if we ever want to be exhaustive; current audit surface is closed.
- Moving to Anthropic prompt caching for the big system prompts — that's H13, its own session.
- Restructuring Claude's JSON-output contracts (`compile-report` highlights, `generate-content-page` NDJSON stream) — current prompts left as-is.

## Group E — Non-transactional state & idempotency ✅ COMPLETE (2026-04-17)

Four findings closed across four code commits + one doc commit. Pattern: DELETE+INSERT pairs backed by a unique index replaced with PostgREST upsert (`Prefer: resolution=merge-duplicates`); fire-and-forget `.catch(function(){})` PATCHes converted to awaited `sb.mutate` in try/catch, with failures surfaced in the handler's `results` object and routed through `monitor.logError` at the high-stakes sites.

Commits landed on main:

- `886fe05` — **H27.** `api/compile-report.js` highlights: both `generateHighlights()` (~L700) and `buildFallbackHighlights()` (~L713) paths replaced with upsert via `Prefer: resolution=merge-duplicates,return=minimal`. Backed by new migration `report_highlights_unique_slug_month_sort` adding `UNIQUE(client_slug, report_month, sort_order)`. Pre-verified zero duplicates across 87 existing rows before creating the index. The B.2 try/catch warning wrappers are preserved around the single upsert call; two-step window eliminated.
- `4fc3f69` — **H26.** `api/generate-proposal.js` onboarding seed: DELETE+POST replaced with upsert on the existing `UNIQUE(contact_id, step_key)` using `return=minimal`. Contact `status='prospect'` flip also migrated from bare `fetch` to `sb.mutate`. Added targeted stale-row cleanup (`step_key=not.in.(...)` scoped by `contact_id`) so future template shrinkage doesn't orphan steps — production pre-check showed zero stale rows, so it's a future-proof no-op today. Each sub-step independently try/caught; failures surface in `results.conversion.{status_error, stale_cleanup_error, onboarding_error}`. Zero-row window that blocked `auto_promote_to_active` is closed.
- `9fe2810` — **M11.** `api/admin/deploy-to-r2.js` `site_deployments`: DELETE+POST replaced with upsert on `UNIQUE(site_id, page_path)` using `return=representation` (not `=minimal`) to preserve the single-row shape downstream code depends on in the `deployment` variable. No schema change needed. Clarifies a scope-description inconsistency — the original audit text said `client_sites`, the actual table is `site_deployments`.
- `4d0fa27` — **M30.** `api/generate-proposal.js` 4 fire-and-forget PATCHes: `await fetch(...).catch(function(){})` converted to `await sb.mutate(...)` in try/catch at L90 (`status='generating'`), L284 (error-branch `status='review'` + notes), L594 (`contacts.checkout_options`), L605 (final finalize: `status='ready'`, urls, content). Three sites (L90, L284, L605) additionally log via `monitor.logError('generate-proposal', err, { client_slug: slug, detail: { stage, proposal_id } })` with stages `set_status_generating`, `record_generation_failure`, `finalize_proposal`. Non-critical L594 is log-only through `results.checkout_options_error`. L605 is the audit-flagged "stuck in generating forever" site; it now surfaces as both an admin-visible `results.finalize_error` and an `error_log` entry.
- `62392a9` — Doc update: `api-audit-2026-04.md` marks H26/H27/M11/M30 ✅ RESOLVED with Resolution blocks; Highs 22 → 24, Mediums 9 → 11; total ≥49 resolved / ≤68 open across 117 findings; 4 rows appended to the Resolution log.

Net result:
- H26, H27, M11, M30 fully resolved.
- PostgREST upsert with `Prefer: resolution=merge-duplicates` is the canonical replacement for DELETE+INSERT pairs going forward, whenever the target table has (or can gain) a unique index on the conflict keys. Use `return=minimal` by default; switch to `return=representation` when downstream code depends on the post-write row shape.
- Fire-and-forget `.catch(function(){})` is now purged from `api/generate-proposal.js` serverside. The one remaining instance at L515 is intentional: it's inside the backtick `trackingScript` template literal injected into deployed HTML as a `<script>`, so it's browser-side code running in a visitor's tab, not a Vercel function.
- Tallies: **Highs 24 / 36 resolved (12 open). Mediums 11 / 38 resolved. Total ≥49 resolved / ≤68 open across 117 findings.**

Behavior-preservation notes:
- H26 upsert uses `return=minimal`. The `auto_promote_to_active` trigger fires on row-level `pending→complete` transitions, so an upsert that keeps rows at `status='pending'` (the template's seed value) is a no-op on the column the trigger watches — no risk of the fix itself spuriously firing the promotion. The fix's goal is to close the zero-row window that was blocking the trigger from ever firing, not to change its semantics.
- M11 chose `return=representation` rather than `=minimal`. Per the commit message, the handler reads fields from the upsert response into a `deployment` variable used downstream; `=minimal` would have returned an empty body and broken that read. Worth remembering as a general rule when applying the upsert template — match the `return=` preference to what the handler does with the response.
- M30's L605 finalize continues the existing handler pattern of always returning 200 with a `results` envelope, even on partial failure. Not an API-contract change; the admin UI already inspects `results` for error sub-fields. Introducing a 500 at L605 would have broken the "proposal HTML is already deployed, state-record update failed but the deploy succeeded" distinction — admin retry would then re-run the Drive folder creation step (not idempotent) and create duplicate folders. Keeping the 200 + `results.finalize_error` path preserves the retry safety.
- For M30 specifically, the three `monitor.logError` sites use `client_slug: slug` (the `slug` variable is set at L71 from `contact.slug`, after the proposal+contact load at L62-69 but before the first in-scope PATCH at L88). All three are reached only after `slug` is defined; confirmed by code inspection. The `detail.stage` tags are distinct so `error_log` queries can filter per-step.

Out of scope for Group E (flagged as candidate future work):
- L1 — the `fetch(sb.url() + '/rest/v1/...')` raw-read pattern still present at `generate-proposal.js:62,80` and across other files outside B.2's four. Tracked in the Low section, natural fit for Group B.3 (Supabase helper migration sweep).
- M18 + M19 — non-transactional DELETE+INSERT patterns in `process-entity-audit.js`. Flagged during B.2 as preserved deliberately; were not in Group E's four. If another round of this work is scheduled, these are the next-obvious targets — both have similar shape to H26/H27 and the upsert template applies directly.
- Rewriting the `auto_promote_to_active` trigger to be more robust against empty-row windows (remove the pending→complete requirement, or add a row-count guard). With H26 closed, the trigger's brittleness no longer has a realistic way to bite; not worth its own session.
- Moving any of these to server-side RPCs with real transactional semantics. Plain upsert turned out to be sufficient for all four findings; the RPC fallback path mentioned in the session prompt didn't need to be exercised.

## Closing thought on the grouping approach

The original phase-based plan (phases 1-7) was right when the audit was fresh and we needed to prioritize Criticals. Now that Criticals are all closed, continuing phase-by-phase would force awkward sequencing — e.g. doing H9 in "Phase 5" and H18 in "Phase 7" even though they're unrelated.

Grouping by shape (what kind of fix, what files, what skill) means each session has a single theme, one mental model, one commit style. That's a better fit for the current phase of work.
