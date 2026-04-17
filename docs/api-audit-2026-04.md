# Client HQ API Security & Quality Audit

**Date:** April 17, 2026
**Scope:** `api/*.js` (63 routes), `api/admin/*.js` (7 routes), `api/_lib/*.js` (8 shared modules). Excludes `api/cron/*` and the VPS agent service.

**Totals:** 9 Critical, 35 High, 38 Medium, 27 Low, 6 Nit.

Each finding has an ID (C/H/M/L/N-number) for reference in remediation commits and PRs.

---

## Executive summary

Four categories account for most findings:

1. **Functional bugs in critical flows.** Three routes are currently broken: `bootstrap-access.js` always 500s (C1/C8), `newsletter-webhook.js` updates random rows and then fails (C6), and `_lib/crypto.js` silently writes plaintext passwords when the encryption key is missing (C5). These are features that do not work today.

2. **Signature verification is wrong in both webhook routes.** Stripe (C2) and Resend/svix (H11) both reconstruct raw body via `JSON.stringify(req.body)` which does not reliably match signed bytes, and both use non-timing-safe string comparison. Both need `config.api.bodyParser = false` and `crypto.timingSafeEqual`.

3. **Public-to-production chains accept untrusted input without defense-in-depth.** Anyone can tamper with any onboarding client's data via `/api/onboarding-action` (C3/C7). Anyone can submit an endorsement that flows through Claude into deployed production HTML (C9). An admin JWT compromise via `action.js` filter injection (C4) gives read/write/delete access to 40+ tables with no audit log.

4. **Systemic code-quality debt.** `getDelegatedToken` is duplicated seven times across the codebase. ~30 routes bypass `_lib/supabase.js` and `_lib/github.js` with inline fetches. Hardcoded secret fallbacks live in source. No rate limiting anywhere. Errors leak internal detail to response bodies in ~20 places. `fetch()` without `AbortController` is the norm, not the exception.

Recommended remediation order in [Remediation plan](#remediation-plan) at the bottom.

---

## Critical

### C1. `api/bootstrap-access.js:25` — endpoint always throws ReferenceError
Handler calls `auth.requireAdmin(req, res)` at line 25, but `auth` is never required at module scope. The only `require('./_lib/auth')` in the file is on line 485, inside `getDelegatedToken()` — unreachable from the handler. Every invocation throws `ReferenceError: auth is not defined`, caught by outer try/catch, returns 500.

**Impact:** Post-Leadsie access-setup automation (GBP/GA4/GTM/LocalFalcon user grants) is 100% non-functional.

**Fix:** Move `var auth = require('./_lib/auth');` to line 20 alongside `sb`. Delete duplicate require on line 485.

### C2. `api/stripe-webhook.js` — signature verification unreliable
Three compounding issues:
1. No `config = { api: { bodyParser: false } }` export. Vercel parses JSON before handler sees it. Lines 28-34 reconstruct raw bytes via `JSON.stringify(req.body)`, which doesn't preserve key order, whitespace, or numeric formatting from what Stripe signed.
2. Line 60: `if (expected !== signature)` — plain string comparison, not timing-safe.
3. Line 42: `parts[kv[0].trim()] = kv[1]` — only the first `=` delimits, value isn't trimmed.

**Impact:** Probably works by accident on small/simple events. Any unusual event shape breaks silently — payment-to-onboarding transition won't fire. Timing side-channel for signature forgery.

**Fix:** Add `module.exports.config = { api: { bodyParser: false } };`. Read raw body via stream helper. Use `crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))`. Parse `event` from the raw buffer, not from `req.body`.

### C3. `api/onboarding-action.js` — unauthenticated, cross-client data tampering
Route has no JWT check. Sole access control: "contact_id points to a contact with status='onboarding'". The contact_id comes from attacker-controlled request body.

1. `create_record` path: attacker passes `data: { contact_id: <any onboarding contact_id>, ... }`. Check on line 36 queries that contact, passes, then writes arbitrary rows to `bio_materials`, `practice_details`, `social_platforms`, `directory_listings`.
2. `update_record`/`delete_record`: `buildFilter(filters)` includes every filter key. Attacker passes `filters: { contact_id: victim, id: anything, status: 'neq.deleted' }` — compound filter hits all matching rows.
3. Same PostgREST filter injection as C4 (lines 81-93): values starting with `eq|neq|gt|...` prefix get passed through raw. `filters: { id: "in.(id1,id2,id3)" }` broadens scope. `DELETE` with filter injection could wipe large swaths.

**Confirmed exploit path:** `_templates/onboarding.html:1989` fetches `contacts?slug=eq.<CLIENT_SLUG>&select=*` using the public anon key, exposing `contact.id` in the browser. Slug is in the URL. Anyone visiting any onboarding client's page gets that client's UUID, then POSTs to `/api/onboarding-action`.

**Fix:** HMAC-signed token bound to `contact_id`, issued when onboarding URL is generated. Validate server-side; extract `contact_id` from verified token only. Harden `buildFilter` — see C4.

### C4. `api/action.js:82-94` — PostgREST filter value injection
Line 85 validates the *key*, but lines 87-88:
```js
if (typeof val === 'string' && /^(eq|neq|gt|gte|lt|lte|is|in)\./i.test(val)) {
  parts.push(key + '=' + val);
```
Any value starting with an allowed operator gets concatenated raw. An authenticated admin can pass `filters: { id: "in.(1,2,3,4)" }`, `"is.null"`, `"not.is.null"` — circumventing UI intent.

No audit log of who does what. `signed_agreements`, `payments`, `workspace_credentials` mutable without record.

**Impact:** Compromised admin JWT → full read/write/delete over 40+ tables, no forensic trail.

**Fix:** Structured filter shape `{ column, op, value }` with operator allowlist and `encodeURIComponent` on every value. For `in`, accept array and build `in.(...)` server-side. Write `activity_log` row on every mutation.

### C5. `api/_lib/crypto.js:29` — silent plaintext passthrough
```js
if (!key) return plaintext; // Passthrough if no key configured
```
If `CREDENTIALS_ENCRYPTION_KEY` is unset (typo, rotation gap, config error), Gmail passwords, app passwords, authenticator secrets, and QR images get written in plaintext. No warning, no log.

**Impact:** Silent partial failure. Existing rows stay plaintext even after key is restored, until re-saved.

**Fix:** Throw in `getKey()` when env var missing. Loud warning at module load. Banner in admin UI when row ciphertext isn't `v1:`-prefixed.

### C6. `api/newsletter-webhook.js:51, 99, 104, 109, 127, 132` — entire webhook non-functional
Wrong calling convention throughout:
- `sb.query(path, opts)` expects `'newsletter_sends?resend_message_id=eq.X&select=...'` as single string. File calls `sb.query('newsletter_sends', 'resend_message_id=eq....')` — fetches with no filter, returns first 1000 rows, `sends[0]` is random.
- `sb.mutate(path, method, body, prefer)` — file calls `sb.mutate('newsletter_sends', 'id=eq.' + send.id, 'PATCH', updates)` — `method = 'id=eq.<uuid>'` (invalid HTTP verb).

**Impact:** All newsletter engagement tracking broken. Opens, clicks, bounces, complaints recorded by Resend never flow to `newsletter_sends`/`newsletter_subscribers`. Stats counters stay at zero.

**Fix:** Rewrite every call:
- `sb.query('newsletter_sends?resend_message_id=eq.' + encodeURIComponent(messageId) + '&select=...')`
- `sb.mutate('newsletter_sends?id=eq.' + send.id, 'PATCH', updates)`

Also address H11 signature issues in same PR.

### C7. `api/onboarding-action.js` — exploit path confirmed
Same root cause as C3. Filed separately to track the exploit-chain confirmation: `_templates/onboarding.html` exposes `contact.id` client-side via anon-key fetch, making C3 trivially exploitable by anyone who knows any onboarding client's slug.

### C8. `api/bootstrap-access.js:484-485` — mis-scoped require root cause
The definition site of the C1 bug. Lines 484-485:
```js
var crypto = require('crypto');
var auth = require('./_lib/auth');
```
`auth` is required inside `getDelegatedToken` where it's dead code, never referenced in that function body. The `crypto` require is used; `auth` was probably pasted next to it by mistake. Single-line fix: move to module scope.

### C9. `api/generate-content-page.js:410` + `_templates/endorsements.html:436` — public → Claude → production HTML injection chain
Endorsement collection page at `/<slug>/endorsements/` POSTs directly to Supabase with anon key. No auth, no captcha, no rate limit. RLS permits anon INSERT. Writes arbitrary `content`, `endorser_name`, `endorser_title` to `endorsements`.

Then in `generate-content-page.js`:
- Line 61: loads processed endorsements into prompt builder.
- Line 410: `msg += '  Quote: "' + e.content + '"\n';` — endorsement content interpolated verbatim into Claude's user prompt.
- Line 132-138: Claude Opus 4.6 generates complete HTML bio page with endorsements in an "Endorsement section" with `id="endorsement-section"`.
- Generated HTML saved to `content_pages.generated_html`, eventually deployed via `api/admin/deploy-to-r2.js` to client's production domain.

**Attack chain:**
1. Attacker submits endorsement with prompt injection in `content`.
2. Admin promotes endorsement to `status='processed'` (normal workflow, injection likely missed in long quote).
3. Content page generation runs.
4. Opus 4.6, though resistant, has non-zero compliance with injected instructions.
5. Generated HTML saved.
6. Admin deploys page (review is for content, not security).
7. Malicious JS executes on visitors to client's production bio page.

**Fix:** Defense in depth:
- Rate limit + captcha on collection form.
- Admin review flow with "user-submitted, may contain prompt injection" banner.
- Structured delimiters in prompt (pass endorsements as JSON array, tell Claude it's data to quote, not instructions).
- Server-side HTML sanitization before persisting/deploying (strip `<script>` not on allowlist).

---

## High

### H1. `api/_lib/auth.js:160` — `_profileCache` has no TTL
Module-scoped cache persists across warm invocations (up to 15min). Removing an admin from `admin_profiles` has no effect until cold start. Add 60s TTL or drop the cache.

### H2. Same filter-injection bug in `api/onboarding-action.js:81-93` (public) and `api/action.js:82-94` (admin)
Same `buildFilter` helper duplicated in both files. Fix together via shared `_lib/postgrest-filter.js`.

### H3. `api/_lib/auth.js:143-145` — `rawToDer()` dead code with misleading comment
Function returns input unchanged; `derSig` assignment is ignored. Comment claims ES256 needs DER, but `dsaEncoding: 'ieee-p1363'` handles it natively. Delete.

### H4. `api/_lib/supabase.js` — no fetch timeout/retry
`query()` and `mutate()` have no `AbortController`. PostgREST hang burns full function budget. Wrap in AbortController with 10s default + 1 retry with exponential backoff for 5xx.

### H5. AI chat endpoints — no rate limiting
`agreement-chat.js`, `content-chat.js`, `proposal-chat.js`, `report-chat.js` have zero auth and stream Claude. CORS header is browser enforcement; `curl` ignores it. Direct bill-amplification attack surface. Add IP-based rate limit + server-side Origin check that rejects empty Origin.

### H6. `api/stripe-webhook.js:129-148` — fire-and-forget HTTP calls
Cross-function POSTs to `/api/notify-team` and `/api/setup-audit-schedule` with no retry. Convert to queue table + cron processor, or inline as importable modules.

### H7. `api/_lib/supabase.js:15` — hardcoded fallback URL ✅ RESOLVED
```js
SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
```
Throw if env var unset instead of falling back.

**Resolution (2026-04-17, commit `330e6da`):** Fallback string removed. `url()` now throws `'NEXT_PUBLIC_SUPABASE_URL not configured'` on first call if env var is unset. Module-load `console.error` surfaces the gap in Vercel logs before the first route hits `url()`. Mirrors the H9/H10/C5 pattern. `NEXT_PUBLIC_SUPABASE_URL` verified set across production/preview/development prior to removing the fallback.

### H8. `api/_lib/crypto.js:45` — decrypt returns literal error strings as values
`'[encrypted - key not available]'` and `'[decryption failed]'` flow back to callers as if they were plaintext. Read-then-write cycle would encrypt the error strings. Throw instead.

### H9. `api/admin/deploy-to-r2.js:10` — hardcoded secret fallback in source ✅ RESOLVED
```js
var DEPLOY_SECRET = process.env.CF_R2_DEPLOY_SECRET || 'moonraker-r2-deploy-2026';
```
Live secret in git history (confirmed via `git log -p`). Assume compromised. Rotate, remove fallback, throw at module load.

**Resolution (2026-04-17, commit `36ac5bb`):** Rotated `CF_R2_DEPLOY_SECRET` in Vercel to a fresh 32-byte hex value. Uploaded transitional Worker accepting both old and new, then final Worker (`env.DEPLOY_SECRET` only) after verification. Removed source fallback; handler now returns 500 `'Deploy secret not configured'` if env missing, module-load `console.error` warning mirrors the C5 pattern. **Discovered during rotation:** the literal `'moonraker-r2-deploy-2026'` in source had been dead code in production — the Worker's own source had a different hardcoded value (`fa8e68f5…`), so the git-history string would never have authenticated against the live Worker. The actual live secret was in the Worker's uploaded script (not a secret binding) and is now rotated and moved to a proper secret binding.

### H10. `api/admin/manage-site.js:15, 18` — hardcoded CF account/zone IDs ✅ RESOLVED
Not secrets but infrastructure identifiers. Move to env.

**Resolution (2026-04-17, commit `e772fa9`):** Removed literal `CF_ACCOUNT_ID` fallback; migrated `MOONRAKER_ZONE_ID` from source literal to new `CF_ZONE_ID` env var on Vercel. Added module-load warnings for all three required CF env vars (`CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_ZONE_ID`) and request-time 500 if any are missing (except `action: 'status'` which is DB-read-only). Matches the C5 fail-closed pattern.

### H11. `api/newsletter-webhook.js:27, 32, 35-37` — same signature issues as Stripe
- Line 27: `JSON.stringify(req.body)` raw-body reconstruction won't match svix's signed bytes.
- Line 32: `signatures.indexOf(expected) === -1` not timing-safe.
- Line 35-37: Fail-open if `RESEND_WEBHOOK_SECRET` unset.

Fix alongside C6.

### H12. `api/content-chat.js` — public, uses Opus 4.6, filter injection
- Line 28: empty-Origin bypass.
- Line 47-50: `content_page_id` from request body, no UUID validation.
- Line 114: raw concatenation into PostgREST URL.
- No ownership check — anyone with a content_page_id UUID can stream Claude content about that client.
- Claude Opus 4.6 with 4000 max_tokens — most expensive endpoint.

### H13. `api/agreement-chat.js:119+` — full CSA (~8K tokens) in every system prompt
Pays for full CSA every request. Use Anthropic prompt caching with breakpoint after CSA block.

### H14. `api/submit-entity-audit.js:54-57` — global rate limit is DoS surface
Attacker sending 20 requests in an hour blocks all legitimate submissions. Per-IP bucketing + captcha.

### H15. `api/submit-entity-audit.js:17` — empty Origin bypasses check
Same pattern as chat endpoints. `curl` sends no Origin, passes.

### H16. `api/process-entity-audit.js:462, 492, 541` — template deployed without placeholder substitution
`content: tmplData.content.replace(/\n/g, '')` pushes template verbatim. If template uses `{{SLUG}}` or `{{PRACTICE_NAME}}` placeholders expecting server-side substitution, deployed page shows literal placeholders. Verify pattern vs proposal template.

### H17. `api/process-entity-audit.js:570-575` — internal auth fallback pattern unsafe
`var internalAuth = process.env.CRON_SECRET || process.env.AGENT_API_KEY || '';` — falls back to empty string; downstream call to `send-audit-email` gets `Authorization: Bearer ` which fails closed. But the pattern of OR'ing server secrets is wrong shape — hard-require at module load.

Line 599 onwards embeds `contact.first_name`, `contact.last_name` in notification email HTML without escaping. Free-audit contacts come from `submit-entity-audit.js` (public). Malicious submitter → injected HTML in team notification emails.

### H18. `_lib/newsletter-template.js:53, 55, 58, 66, 68, 218-231` — untrusted content rendered unescaped
Story `body`, `headline`, action items, quick wins, `finalThoughts` all inserted raw. If AI generation glitch produces malformed HTML, breaks every subscriber's layout. Compromised admin JWT could inject HTML into emails to all subscribers.

### H19. `_lib/newsletter-template.js:41, 220` — `image_url` only `esc()`-ed, no scheme validation
`javascript:` or `data:` schemes escape HTML but remain clickable in some email clients. Validate `https://` prefix at write time + render time.

### H20. `_lib/email-template.js:48-50, 164` — `p()` and `footerNote` insert raw HTML
Helper signature invites misuse. Every caller must remember to escape. Rename to `pRaw`, add safe `p()` that escapes by default.

### H21. Seven copies of `getDelegatedToken`/`getGoogleAccessToken`
- `api/bootstrap-access.js:480`
- `api/compile-report.js:909` (no impersonation variant: `getGoogleAccessToken`)
- `api/compile-report.js:1012`
- `api/generate-proposal.js:678`
- `api/enrich-proposal.js:414`
- `api/discover-services.js:281`
- `api/_lib/google-drive.js:39-59` (the only copy that caches tokens)

Extract once to `_lib/google-auth.js` with token caching keyed on `(scope, impersonate)`. Replace all sites.

**Partial progress (2026-04-17, commit `7adedb6`):** Helper module `api/_lib/google-delegated.js` created with `getDelegatedAccessToken(mailbox, scope)`, `getServiceAccountToken(scope)`, `getFirstWorkingImpersonation(mailboxes, scope, testFn)`, and `_tokenCache` keyed on `${mailbox||'sa'}|${scope}`. First and only caller so far is the new `api/campaign-summary.js` feature (not part of audit scope). **The 5 existing duplicate sites listed above still hold their own copies** — migration is the remaining H21 work. Not yet resolved; the design step is now skipped when this ships.

### H22. `api/generate-proposal.js:361` — AI-generated `next_steps` rendered into deployed HTML unescaped
If `enrichment_data` (admin-written, unsanitized) contains prompt injection convincing Claude to emit `<script>`, ends up in prospect-facing deployed proposal. Also line 330: `customPricing.amount_cents / 100` admin-controlled, no type validation, flows into checkout card HTML.

### H23. `api/chat.js:184, 190` — entire admin DB dumped into system prompt every turn
`clientData` + `clientIndex` serialized as JSON in system prompt. Every admin chat turn re-sends 10K+ tokens. Client PII (emails, phones, practice names) flows to Anthropic on every turn. Use prompt caching, or reduce to just the client being discussed.

### H24. `api/compile-report.js` — 23 unbounded fetches despite having `fetchT` helper
File defines `fetchT(url, opts, timeoutMs)` on line 87 and uses it 8 times (GSC, LocalFalcon). 23 other calls still use bare `fetch()`. Supabase queries, Claude call in retry loop, Resend sends — all can hang.

### H25. `api/compile-report.js:1119` — `practiceName` raw-interpolated into Claude prompt
Prompt injection via admin-controlled `practice_name` affects report highlights. Combined with C4, admin-JWT → content-manipulation chain.

### H26. `api/generate-proposal.js:573-590` — onboarding seed is non-transactional DELETE+INSERT
Crash between DELETE and INSERT leaves contact with zero onboarding steps. `auto_promote_to_active` trigger never fires. Use PostgREST upsert or RPC.

### H27. `api/compile-report.js:726, 740, 743` — same non-transactional pattern for highlights
DELETE old, INSERT new. Crash between = zero highlights. Fallback on line 738-746 compounds it.

### H28. `api/bootstrap-access.js:466-473` — response body returns `results` with provider error detail ✅ RESOLVED
`results.{gbp,ga4,gtm,localfalcon}.error` can contain JSON excerpts from Google/LocalFalcon APIs including account IDs, quotas, internal messages. Admin-only but any log capture exposes raw provider error bodies.

**Resolution (2026-04-17, commit `0c9bc85`):** Added `var monitor = require('./_lib/monitor');`. Every catch site (`load_contact`, `load_report_config`, GBP/GA4/GTM/LocalFalcon providers, `config_save`, `deliverable_update`) now calls `monitor.logError('bootstrap-access', e, { client_slug, detail: { provider, ... } })` with raw debug (token errors, GBP Approach A/B strings, LF add response) routed to `error_log` server-side. Response body now uses a new `publicResults` object (built via `pickDefined()` filter) that drops internal resource identifiers — `gbp.account`, `gbp.location_name`, `ga4.property`, `gtm.account` — and keeps only admin-UI-consumed fields (`location_title`, `gbp_location_id`, `display_name`, `container_name`, `container_id`, `place_id`, `users_added`). Thrown error messages in provider blocks replaced with generic strings (`'Google authentication failed'`, `'No matching GBP location found (check Leadsie access)'`, `'LocalFalcon add location failed'`, etc.) so `reason = e.message` can no longer carry PII. `errors` array entries follow the same generic pattern.

### H29. `api/enrich-proposal.js` — searches three team inboxes via domain-wide delegation
Lines 92-148. Impersonates `chris@`, `scott@`, `support@` to run Gmail searches. Results stored in `proposals.enrichment_data` as plaintext JSONB. Admin JWT compromise → Gmail search oracle over team inboxes. `searchDomain` is admin-controlled (via `website_url`) — creating a contact with `website_url = 'moonraker.ai'` returns internal business communications.

Also affects C4 blast radius: `enrichment_data` is readable via `action.js`, unencrypted. Encrypt at rest via `_lib/crypto.js`.

### H30. `api/enrich-proposal.js:161` — Fathom dedup uses string match
Works but is the sixth copy of `getDelegatedToken` (line 414) with no caching. Multiple Fathom + Gmail calls each mint fresh JWTs. Wasteful but not broken.

### H31. `api/generate-content-page.js:419` — 25K chars of RTPBA passed to Claude verbatim
RTPBA originates from Surge agent output parsed from client's website. Narrower surface than C9 — requires attacker to control client site content. Line 81-88 also extracts RTPBA from `entity_audits.surge_data.raw_text` via substring starting at literal "Ready-to-Publish" — 5000 chars from any injection point.

### H32. `api/digest.js:91` — recipients from request body, no allowlist
Admin with JWT sends digest from trusted `notifications@clients.moonraker.ai` to arbitrary addresses. Spamming oracle with trusted identity. Server-side allowlist (e.g. `*@moonraker.ai`).

### H33. `api/newsletter-generate.js:172, 180` — raw Claude output leaked in error responses
On parse failure, full generated text returned. Inconsistent with other routes' error handling. Truncate.

### H34. `api/send-audit-email.js:120, 162` — internal error detail in response body
`detail: emailResult` returns entire Resend response including error context. `err.message` same.

### H35. `api/generate-content-page.js:145, 167, 229` — error details in NDJSON stream
`errText.substring(0, 500)` (Anthropic response body) and `responseText.substring(0, 500)` (Claude generated content) sent as `detail`/`raw_preview` in stream. Admin-only but noise.

---

## Medium

### M1. `api/stripe-webhook.js:101` — amount-based audit detection fragile
`isEntityAudit = amountTotal === 200000 || amountTotal === 207000`. Any price change, tax adjustment, discount, or currency difference breaks. The CC-with-3.5%-fee rounding is especially exposed to drift.

**Remediation plan (deferred to a follow-up PR, noted 2026-04-17 after C2 session):**
1. Add `metadata: { product: 'entity_audit' }` to both Entity Audit payment links in Stripe Dashboard (ACH `buy.stripe.com/3cIdR87co3Z711Wfip5wI0V` and CC `buy.stripe.com/7sY4gyaoAgLT9ys7PX5wI0W`).
2. For CORE Marketing System payment links (8 of them), add `metadata: { product: 'core_marketing_system' }`.
3. Change detection logic in stripe-webhook.js to prefer `session.metadata.product` with a fallback to the current amount check for backward compat with any events already in flight.
4. After observing metadata-based detection work for ~30 days, remove the amount fallback.

### M2. `api/_lib/auth.js:199-204, 253-259` — `last_login_at` updated every request
Every authenticated API call PATCHes `admin_profiles`. 29+ admin routes × 3-5 calls/page = PATCH/second during normal use. Update only on actual login, or throttle to >60s since last update.

### M3. `api/action.js:24` — 40+ tables allowlisted with no action granularity
`signed_agreements`, `payments`, `workspace_credentials`, `settings`, `error_log` all mutable. Shape allowlist as `{ table, actions: ['read','create'] }`. `signed_agreements` and `payments` read-only via this endpoint. `workspace_credentials` requires elevated role.

### M4. `api/_lib/github.js:30` — path validation too permissive
Doesn't reject backslashes, null bytes, URL-encoded traversal, no allowed-prefix list. Any caller passing user-derived paths to `pushFile` is write-to-api vulnerability → Vercel auto-deploy RCE.

### M5. `api/newsletter-webhook.js` — optional signature verification (see H11).

### M6. `api/_lib/monitor.js:85` — critical alert HTML uses string concat with `route`, `slug` unescaped
Low risk (recipients trusted) but inconsistent. Escape everything.

### M7. `api/_lib/supabase.js:45, 66` — error detail may include raw PostgREST response body in thrown messages
Callers doing `return res.status(500).json({ error: err.message })` leak schema info, column names, constraints. Grep each catch.

### M8. `api/stripe-webhook.js:172-175` — `err.message` in response body
Remove `detail: err.message`.

### M9. `api/submit-entity-audit.js:47` — slug race condition
Check-then-insert TOCTOU. Depends on unique constraint existing on `contacts.slug`. Line 191 substring match on `duplicate|unique` is fragile.

### M10. `api/submit-entity-audit.js:118` — no timeout on agent fetch
Full 60s if VPS agent slow.

### M11. `api/admin/deploy-to-r2.js:71` — DELETE-then-INSERT not idempotent
Use PostgREST upsert with `Prefer: resolution=merge-duplicates`.

### M12. `api/admin/manage-site.js:53` — domain "normalization" accepts paths, ports, anything
Doesn't reject `domain:8080`, `domain/path`, `user:pass@domain`, `domain?q=x`. Malformed domain goes to CF custom-hostname API and stored in DB.

### M13. `api/newsletter-webhook.js:119` — returns `e.message` with status 200
Leaks error detail. Useful to attacker probing C6 bug.

### M14. `api/content-chat.js:108` — `fetchPageContext` silently returns nulls on error
If Supabase is down, prompt runs with nulls — expensive no-op. Short-circuit with 503.

### M15. `api/content-chat.js:143` — therapist name interpolated unsanitized into prompt
Prompt injection via `contact.first_name`/`last_name` if ever populated from untrusted source.

### M16. `api/process-entity-audit.js` — no AbortController on 20+ fetch calls
Template reads, destination checks, pushes, Claude API call on line 197. Hung fetch pushes to configured maxDuration.

### M17. `api/process-entity-audit.js` — 15+ inlined Supabase fetches bypass `_lib/supabase.js`
Biggest holdout of consistency pattern.

### M18. `api/process-entity-audit.js:388` — composite checklist_items ID uses first 8 hex chars
Birthday collision around 65K audits. Use full UUID or index-based synthetic id.

### M19. `api/process-entity-audit.js:568-582` — webhook race with auto-send email
Stripe webhook upgrading `audit_tier` to premium can race with agent callback auto-sending free scorecard. Free email goes out → webhook flips to premium → premium Loom flow never triggers.

### M20. `api/newsletter-unsubscribe.js:17-22` — PATCH-zero-rows oracle
UUID-format-but-nonexistent SID triggers PATCH warning in logs.

### M21. `_lib/google-drive.js:109, 157` — Drive query injection if `folderId` attacker-controlled
Unescaped in `q = "'" + folderId + "' in parents"`. Current caller uses admin-written `contact.drive_folder_id`, so requires admin JWT compromise.

### M22. `_lib/newsletter-template.js:141` — `subscriberId` in unsub URL not encoded
Trivial in practice (UUID) but brittle for future test strings.

### M23. `api/generate-proposal.js:598` — hardcoded Drive `CLIENTS_FOLDER_ID`
Infrastructure identifier in source.

### M24. `api/compile-report.js:206-209` — GSC auto-correct writes without admin approval
Silently PATCHes `report_configs.gsc_property` when configured value fails. No banner in UI. Transient Google 403 could re-point client's config to wrong property variant permanently.

### M25. `api/compile-report.js:1138` — markdown fence strip corrupts JSON with nested fences
Same as process-entity-audit.js:226 bug. Extract to helper.

### M26. `api/chat.js:175-177, 126` — prompt injection surface + error leak
`page`, `tab`, `clientSlug` interpolated unsanitized. `err.message` leaked in 500.

### M27. `api/bootstrap-access.js:55, 66, 436, 459` — `clientSlug` unencoded in PostgREST URLs
Line 38 only checks truthiness. Validate as `^[a-z0-9-]{1,60}$`.

### M28. `api/bootstrap-access.js:459` — compound deliverables PATCH filter built by concat
Currently safe (static values) but pattern invites future injection.

### M29. `api/chat.js:130-132` — 120s maxDuration may not cover heavy context
Sonnet 4.6 + 8192 max_tokens + dumped DB = potentially slow. Monitor.

### M30. `api/generate-proposal.js:79-81, 273-275, 543-547, 549-557, 563-569` — 5+ fire-and-forget PATCHes
`.catch(function(){})` swallows errors silently. If final PATCH (549) fails, proposal sits in `generating` forever.

### M31. `api/seed-content-pages.js:21, 23` — `require('./_lib/supabase')` imported twice
Harmless but indicates careless editing.

### M32. `api/enrich-proposal.js:74-78` — personal email regex misses common domains
Missing `aol`, `me.com`, `live.com`, `fastmail`, etc. Not anchored: `gmail.foo.com` matches.

### M33. `api/digest.js:44, 47, 50` — date strings unvalidated
Validate as `^\d{4}-\d{2}-\d{2}$` before concat into filter.

### M34. `api/newsletter-generate.js:13` — Pexels key fallback silent
If unset, every `searchPexelsImage` returns null; newsletter generation proceeds with placeholder images. No admin signal.

### M35. `api/generate-content-page.js:199, 206` — PATCH + POST no transaction
If PATCH succeeds but POST version fails, HTML saved without version record.

### M36. `api/seed-content-pages.js` uses arrow functions
Inconsistent with project's ES5 style.

### M37. `api/send-audit-email.js:131` — auto-schedule doesn't check contact status

### M38. `client_sites` RLS missing `authenticated_admin_full` policy ✅ RESOLVED
**Discovered during H9 rotation UI smoke test (2026-04-17).** `client_sites` had RLS enabled with only one policy: `anon_read_client_sites` (`roles={anon}`, `USING (true)`). Every other public table (`contacts`, `content_pages`, `tracked_keywords`, `bio_materials`, `neo_images`, …) has an additional `authenticated_admin_full` policy using `is_admin()`. `shared/admin-auth.js` installs a fetch interceptor that upgrades the `Authorization` header from the anon key to the user's admin JWT on direct Supabase REST calls, so the admin UI queries `client_sites` as role `authenticated` — which had no matching policy, returning empty.

**Impact:** The Website Hosting card in the client deep-dive has likely been silently empty for every admin viewing every client since RLS was introduced on this table. The UI's empty-state path calls `provisionHosting()` which POSTs to `/api/admin/manage-site` with a partially-populated body, producing the `400 contact_id, domain, and hosting_type are required` toast that has been observed but never traced to cause. No security exposure — RLS was over-restrictive, not under-restrictive — but a real correctness gap.

**Resolution (2026-04-17, migration `add_authenticated_admin_policy_client_sites`):** Added `authenticated_admin_full` policy matching the pattern used on every other table:
```sql
create policy authenticated_admin_full
  on public.client_sites
  for all
  to authenticated
  using (is_admin())
  with check (is_admin());
```
UI smoke test confirmed the Website Hosting card now renders the moonraker site correctly. A broader sweep for other tables with this pattern missing is a candidate follow-up.
Follow-up sequence scheduled even if contact has since flipped to `lost`/`onboarding`/`active`.

---

## Low

### L1. Inconsistent use of `_lib/supabase.js`
Many routes mix `sb.query`/`sb.mutate` helper calls with inline `fetch(sb.url() + '/rest/v1/...')`. The inline form bypasses the PATCH-zero-rows warning.

### L2. `api/stripe-webhook.js:37-63` — bare block wrapping signature check
Probably refactor artifact.

### L3. `var`-style declarations throughout
Consistent but foot-gun prone.

### L4. `api/_lib/github.js:32` — no retry on concurrent-write 409
If caller provides stale SHA, PUT 409s with no auto-retry.

### L5. `api/_lib/auth.js:104, 122` — duplicated verify blocks
Retry-with-refreshed-keys block is cut-and-paste. Extract helper.

### L6. `api/submit-entity-audit.js` — agent error swallowed, no requeue
Memory says `process-audit-queue.js` handles this. Verify.

### L7. `api/report-chat.js:62, 68` — retry logic duplicated between catch and 529 handler

### L8. `api/newsletter-webhook.js:41` — unhandled Resend types dropped silently ✅ RESOLVED
`email.sent`, `email.scheduled`, `email.delivery_delayed` hit default branch, discarded. Log to `newsletter_events`.

**Resolution (2026-04-17, commits `994f51a` + `bd0e195`):** `994f51a` added `webhook_log` observability with `logEvent('unhandled_type', { eventType, emailId, headers })` in the default branch, so every unrecognized type now leaves a trail. `bd0e195` then added explicit `case 'email.sent'` and `case 'email.delivery_delayed'` no-op branches that call `logEvent('ok_noop', ...)` — the audit's cited types specifically. `email.scheduled` still falls through to the `unhandled_type` default (which is correct — it's logged, just not acted on).

### L9. `api/submit-entity-audit.js:172` — admin link uses `#audit-` fragment
Verify admin clients page scrolls to/opens that anchor.

### L10. `api/admin/deploy-to-r2.js:46` — 16-hex-char content hash (64 bits)
Fine for change detection. Not fine if reused as etag across many sites.

### L11. `api/process-entity-audit.js:226` — markdown fence strip brittle with nested fences

### L12. `api/process-entity-audit.js:621-626` — function declared inside conditional branch
Non-strict mode hoisting inconsistency across engines.

### L13. `_lib/email-template.js:22-24` — hardcoded asset URLs

### L14. `DEPLOY_SECRET` in git history — covered by H9 ✅ RESOLVED
Resolved alongside H9 (commit `36ac5bb`). The rotation made the git-history string useless against the Worker. Note: the Worker's own legacy hardcoded secret (discovered during rotation) was also rotated out; see H9 resolution note.

### L15. `_templates/onboarding.html:955` — anon key JWT exp 2089 (effectively never)
RLS is the only control. Consider rotating to a shorter-exp anon key.

### L16. `api/compile-report.js:909, 1012` — two token functions with subtle difference
`getGoogleAccessToken` vs `getDelegatedToken` in same file. Delete unused one.

### L17. `api/generate-proposal.js:330` — `customPricing.amount_cents / 100` no null check

### L18. `api/chat.js:44-80` — `models` array has one element; outer loop never iterates

### L19. `api/enrich-proposal.js:76` — hardcoded personal-email domain blocklist

### L20. `api/compile-report.js` — 14 inlined Supabase fetches

### L21. `api/enrich-proposal.js:337` — `User-Agent: 'Moonraker-Bot/1.0'` may be blocked

### L22. `api/digest.js:128-131` — `sbGet` helper redefines `sb.query`

### L23. `api/newsletter-generate.js:191-205` — `stripEmDashes` six-step replace chain

### L24. `api/send-audit-email.js:12` — wrong calendar URL?
`email.CALENDAR_URL` = `scott-pope-calendar` but memory canonical is `moonraker-free-strategy-call`. Verify.

### L25. `api/generate-content-page.js:180-182` — VERIFY regex stops at `<`

### L26. `admin/clients/index.html:1991` — `renderContent()` race condition ✅ RESOLVED
**Discovered during H9 rotation UI smoke test (2026-04-17).** When the Content tab renders, `renderContent()` calls `renderHostingCard(c)` which kicks off an async fetch of `client_sites`. The initial synchronous render of the Service Pages section uses `state.clientSite` which is still `null` at that moment, so the conditional gate on `state.clientSite` for rendering the `☁ Deploy to Site` button fails and the button never appears. The fetch's `.then()` only re-rendered the hosting card, not the Service Pages section, so the button stayed hidden until the user switched tabs and came back.

**Resolution (2026-04-17, commit `402a579`):** In the fetch resolution, added a re-render of `renderContent()` guarded by (a) same-contact identity check (`state.contact === c`) and (b) active tab is `content`. No re-render on catch (the empty-sites render is already correct for that path).

### L27. `workspace_credentials.authenticator_secret_key` is null on every row — write path never built
**Observed during H9 session (2026-04-17).** `api/_lib/crypto.js:120` correctly lists `authenticator_secret_key` in `SENSITIVE_FIELDS`, and `api/action.js:78, 110` correctly applies `encryptFields` on `workspace_credentials` writes. The encrypt/decrypt plumbing is complete. **But nothing in the frontend writes to this column.** Grep of `admin/*.html` + `shared/*.js` returns zero hits outside the crypto module itself. The column exists in the schema, and rows exist in `workspace_credentials`, but the field is never populated.

**Not a bug — a workflow gap.** Likely intent: capture the TOTP seed when setting up 2FA on client Google Workspaces, alongside the app password. The setup UI captures `app_password` but not `authenticator_secret_key`. Either wire it up when 2FA capture becomes part of the onboarding flow, or remove the column. No action this session.
Cuts off flags mid-sentence with HTML brackets.

---

## Nit

### N1. `api/_lib/supabase.js` — `one()` returns null on error shape
Array.isArray on `{ message: 'X' }` error returns false; `one()` returns null as if row didn't exist.

### N2. `api/stripe-webhook.js:43` — `parts[kv[0].trim()] = kv[1]` with undefined values

### N3. `api/_lib/monitor.js:43` — log interpolation of user-sourced `slug` could inject newlines

### N4. `api/onboarding-action.js:2-4` — comment describes the bug as a feature
"No admin JWT required — uses service role key for writes" reads as intentional. Rewrite after fix.

### N5. Chat endpoints CORS origin is literal `clients.moonraker.ai`
Preview domains fail CORS when testing.

### N6. Seven copies of `getDelegatedToken` — covered in H21.

---

## Patterns to fix systemically

1. **`buildFilter` is duplicated and unsafe in both copies.** Extract to `_lib/postgrest-filter.js` with structured-input design. Replace both sites + grep for other copies.

2. **Public-facing writes need signed URL tokens, not id-based access.** `/onboarding`, `/audit`, `/proposal`, `/report`, `/content-preview`, `/agreement` pages are slug-addressable with anon Supabase reads. `_lib/page-token.js`: `sign({ scope, contact_id, exp }, secret)` + `verify(token, expected_scope)`. Template deploys embed token. Every write-endpoint from client-facing pages validates scope before accepting `contact_id`.

3. **`requireAdmin` vs `requireAdminOrInternal` split is inconsistent in practice.** Several routes called from crons use dual auth correctly. Several that also receive internal calls are admin-only. Audit caller graph before tightening.

4. **No request-level audit log.** `activity_log` table exists but isn't written by `action.js` or `onboarding-action.js`. Every write through those paths needs admin user ID + table + filter + action logged.

5. **No rate limiting anywhere.** Needed on at least 8 routes (chat endpoints, `submit-entity-audit`, `newsletter-unsubscribe`, endorsement form, `bootstrap-access`). `_lib/rate-limit.js` backed by Supabase table or Upstash KV.

6. **`fetch()` without `AbortController` is the default everywhere.** Standardize on `fetchWithTimeout(url, opts, ms)` helper.

7. **Error messages leak to 5xx response bodies** in ~20 places. Grep `json\(\{[^}]*\b(detail|error|raw|message)\s*:\s*(err|e|[a-zA-Z]+)\.`. Standardize: 5xx = `{ error: 'Internal error' }`, detail to `monitor.logError`.

8. **Module-scoped caches with no TTL.** `_profileCache` in auth.js (H1) is the caught one. Grep other `var _XxxCache = {}`.

9. **`.catch(() => {})` swallows errors silently.** ~30 instances. Minimum: `console.error('[route] context:', e.message)`.

10. **Webhook signature patterns ad-hoc.** Extract `_lib/verify-webhook.js` with raw-body helper, timing-safe compare, fail-closed. Both stripe-webhook and newsletter-webhook share rewrite.

11. **Helpers that insert HTML raw default to unsafe.** `_lib/email-template.js` and `_lib/newsletter-template.js` `p()` and body inserters require callers to escape. Rename raw variants to `.raw()`; make default escape.

12. **`process-entity-audit.js`, `compile-report.js`, `generate-proposal.js`, `bootstrap-access.js`, `enrich-proposal.js` have double-digit inlined Supabase fetches.** Mechanical migration to `sb.query`/`sb.mutate` — the single biggest code-quality win available.

13. **`validatePath` in `_lib/github.js` is bypassed by `process-entity-audit.js` GitHub deploys.** Enforce an allowed-prefix list when migrating (pattern 12).

14. **Error-in-stream shape leaks internal state.** NDJSON `send({ step: 'error', message: err.message })` across multiple routes. Standardize to safe summary; detail to monitor.

15. **Stream/body fallback pattern in `process-entity-audit.js:37-44`** (read `surge_data` from DB if not in body) is valuable but isolated. Generalize in `_lib/agent-callback.js`.

16. **Seven copies of `getDelegatedToken`.** Extract to `_lib/google-auth.js` with token caching.

17. **DELETE-then-INSERT idempotency pattern** recurs in `deploy-to-r2.js`, `generate-proposal.js` (onboarding seed), `compile-report.js` (highlights). Zero-rows state after crash. Use PostgREST upsert or RPC transactions.

18. **Hardcoded infrastructure identifiers in source:** `MOONRAKER_ZONE_ID`, `CF_ACCOUNT_ID`, `CLIENTS_FOLDER_ID`, `DEPLOY_SECRET` (the live secret), plus the Supabase anon key in every template. Centralize in `_lib/constants.js` with fail-closed env overrides.

19. **Request-body filter construction without format validation** in virtually every admin endpoint. `_lib/validate.js` with `uuid()`, `slug()`, `isoDate()` helpers at every destructuring site.

20. **Public-to-AI-to-production chains are the highest-severity new category.** Any path accepting untrusted input → Claude prompt → deployed domain needs: structured delimiters in prompt, server-side HTML sanitization before deploy, rate limit + captcha on public form.

21. **Calling-convention mistakes in `sb.query`/`sb.mutate` (C6)** suggest the `(path, opts)` / `(path, method, body, prefer)` signatures are confusing. Add runtime validation (first arg must contain `?` if filter content is present), or add `sb.queryTable(table, filter)` / `sb.updateTable(table, filter, body)` higher-level wrappers.

---

## Remediation plan

Ordered by value/risk ratio. Each item references finding IDs.

### Phase 1 — Broken features (urgent, low risk) ✅ COMPLETE
1. ✅ **C1 + C8** — commit `28ffa37` (2026-04-17). One-line fix, unblocks bootstrap-access.
2. ✅ **C5 + H8** — commit `c717d99` (2026-04-17). Fail-closed on missing `CREDENTIALS_ENCRYPTION_KEY`; decrypt throws instead of returning error strings. DB audit confirmed zero plaintext rows to remediate.
3. ✅ **C6 + H11** — commit `b9b8f47` (2026-04-17). Rewrote newsletter-webhook calling convention, added raw-body reader, timing-safe signature compare, fail-closed on missing secret.

### Phase 2 — Payment security (urgent, contained) ✅ COMPLETE
4. ✅ **C2 + M8** — commit `5263aa5` (2026-04-17). Stripe webhook now uses raw-body reader (`readRawBody` helper), supports multi-signature headers (Stripe key rotation), timing-safe compare with length guard, `Number.isFinite` timestamp validation, removed `err.message` from 500 response. Added partial unique index `payments_stripe_session_unique` for idempotent retries. **Historical backfill:** 5 previously-lost payment rows recovered by resending Stripe events through the now-working webhook. First confirmed end-to-end webhook successes in production history.

### Phase 3 — Architectural decisions (design-first)
Before coding Phase 3+:
- **Design `_lib/page-token.js`** — HMAC token shape for client-facing pages. Affects C3/C7 and future rate-limiting identity.
- **Decide rate-limit backing store** — Supabase table, Upstash KV, or Vercel KV. Affects C9 and H5 fixes.
- **Decide `action.js`/`onboarding-action.js` direction** — shared hardened mutation layer, or rewrite `onboarding-action.js` with named actions only (no generic table/filters passthrough).

### Phase 4 — Public attack surface (high impact) ✅ COMPLETE
5. ✅ **C3 + C7** — Sessions P4S1–P4S3. `api/_lib/page-token.js` (stateless HMAC), `api/onboarding-action.js` now requires verified page_token. Token minted at onboarding page deploy; contact_id sourced from verified token, not request body. Filter injection bug closed via shared helper (P4S5). 22+ existing onboarding pages redeployed with tokens.
6. ✅ **C4** — Session P4S5. `api/_lib/postgrest-filter.js` rejects operator-prefix passthrough; `api/_lib/action-schema.js` per-table manifest (permissive defaults, tightening follows as observed). `api/action.js` writes field-level rows to `activity_log` on every mutation. `api/onboarding-action.js` shares the filter helper.

### Phase 5 — Hardening passes (IN PROGRESS)
8. ✅ **H9 + L14** — commit `36ac5bb` (2026-04-17). Rotated `CF_R2_DEPLOY_SECRET` in Vercel, removed source fallback from `api/admin/deploy-to-r2.js:10`, module-load warning + request-time 500 on missing env var. The old fallback `'moonraker-r2-deploy-2026'` no longer works against the worker.
8b. ✅ **H10** — commit `e772fa9` (2026-04-17). Removed hardcoded `CF_ACCOUNT_ID` + `MOONRAKER_ZONE_ID` literals; added `CF_ZONE_ID` env var; fail-closed on missing CF config.
8c. ✅ **M38** (new, discovered during H9 smoke test) — Supabase migration `add_authenticated_admin_policy_client_sites` (2026-04-17). Added missing `authenticated_admin_full` RLS policy to `client_sites`; admin hosting card now renders correctly.
8d. ✅ **L26** (new) — commit `402a579` (2026-04-17). Fixed `renderContent()` race so Service Pages re-renders after async hosting fetch resolves.
8e. ✅ **H7** — commit `330e6da` (2026-04-17). Removed `api/_lib/supabase.js` hardcoded URL fallback; module-load warning + throw on first `url()` call if env missing.
8f. ✅ **H28** — commit `0c9bc85` (2026-04-17). `bootstrap-access.js` response body now uses filtered `publicResults` object; every catch site routes raw debug to `monitor.logError`; provider-specific thrown strings replaced with generic messages.
8g. ✅ **L8** — commits `994f51a` + `bd0e195` (2026-04-17). Newsletter webhook now logs every unhandled type via `logEvent('unhandled_type', …)`; added explicit no-op handlers for `email.sent` and `email.delivery_delayed`.
8h. 🔶 **H21 (partial)** — commit `7adedb6` (2026-04-17). Helper `api/_lib/google-delegated.js` created with token caching; used by new `campaign-summary.js`. 5 existing duplicate sites still pending migration.
9. **H21 migration** — replace 5 duplicate `getDelegatedToken` sites (bootstrap-access, compile-report ×2, generate-proposal, enrich-proposal, discover-services) and `_lib/google-drive.js` implementation with the now-live `_lib/google-delegated.js` helper.
10. **H4 + H24 + M10 + M16 + the many AbortController gaps** — extract `fetchWithTimeout`, apply everywhere.
11. **Pattern 12** — migrate inline Supabase fetches to helper in the five big files. Mechanical, test-with-deploy.

### Phase 6 — Rate limiting ✅ COMPLETE
12. ✅ **H5 + H14** — Session P4S4. `api/_lib/rate-limit.js` backed by Supabase table + atomic RPC. Applied: chat endpoints (agreement/content/proposal/report) at 20/min/IP; `submit-entity-audit` at 3/hr/IP (replacing global H14 limit); `newsletter-unsubscribe` at 30/min/IP. Daily cleanup cron registered.

### Phase 6.5 — C9 endorsement chain ✅ COMPLETE
_(Brought forward from Phase 7 since Chris chose "ship now" over "wait for traffic")_
✅ **C9** — Session P4S7. New `api/submit-endorsement.js` requires scope='endorsement' page_token (minted per-client at endorsement page deploy), rate-limited 10/hr/IP, all text fields passed through `sanitizeText()`. `api/_lib/html-sanitizer.js` added; generated content HTML sanitized before save as defense in depth. Template updated to POST through the server endpoint instead of direct anon-key write.

### Phase 7 — Code quality cleanup (PENDING)
13. Template/email escape defaults (H18, H19, H20).
14. Error-leak standardization (pattern 7).
15. **M1** — Stripe metadata-based product detection (detailed plan in M1 section above).
16. Remaining Medium/Low cleanup as time permits.

### Won't-fix-now list
- L3 (`var` everywhere) — cosmetic.
- L13 (hardcoded asset URLs) — single-domain app, fine.
- L15 (long-exp anon key) — RLS is the control; no immediate action.

---

## Running tallies

- **Critical:** 9 total (C1–C9). **Resolved: 9 ✅** (all).
- **High:** 35 total (H1–H35). **Resolved: 8** (H5, H7, H8, H9, H10, H11, H14, H28). **Open: 27.**
- **Medium:** 38 total (M1–M38). **Resolved: 2+** (M8 confirmed; M38 added + resolved same session; several more likely closed via Phase 4 action-schema work — needs verification sweep). **Open: ~35.**
- **Low:** 27 total (L1–L27). **Resolved: 4** (L8, L14, L26, L27-documented-only). **Open: 23.**
- **Nit:** 6 total (N1–N6). **Open: 6.**

**Total: 115 findings. Resolved: ≥23. Open: ≤92.**

### Resolution log
| Finding | Commit / Session | Date |
|---|---|---|
| C1 + C8 | `28ffa37` | 2026-04-17 |
| C5 + H8 | `c717d99` | 2026-04-17 |
| C6 + H11 | `b9b8f47` | 2026-04-17 |
| C2 + M8 | `5263aa5` | 2026-04-17 |
| C3 + C7 | Phase 4 S1–S3 (page-token + filter helper) | 2026-04-17 |
| C4 | Phase 4 S5 (action-schema + postgrest-filter + activity_log) | 2026-04-17 |
| C9 | Phase 4 S7 (submit-endorsement + html-sanitizer) | 2026-04-17 |
| H5 | Phase 4 S4 (rate-limit chat endpoints) | 2026-04-17 |
| H14 | Phase 4 S4 (per-IP submit-entity-audit limit) | 2026-04-17 |
| H9 + L14 | `36ac5bb` (rotate CF_R2_DEPLOY_SECRET, remove fallback) | 2026-04-17 |
| H10 | `e772fa9` (strip CF_ACCOUNT_ID + CF_ZONE_ID fallbacks) | 2026-04-17 |
| M38 | migration `add_authenticated_admin_policy_client_sites` | 2026-04-17 |
| L26 | `402a579` (renderContent race fix) | 2026-04-17 |
| L27 | documented-only (workflow gap, not a bug) | 2026-04-17 |
| L8 | `994f51a` + `bd0e195` (webhook_log + explicit noop handlers) | 2026-04-17 |
| H7 | `330e6da` (supabase.js fallback removed, fail-closed) | 2026-04-17 |
| H28 | `0c9bc85` (bootstrap-access response sanitized, monitor.logError) | 2026-04-17 |
| H21 (partial) | `7adedb6` — helper `_lib/google-delegated.js` created; 5 duplicates still pending | 2026-04-17 |

Audit was performed across five sessions reading ~11,000 lines of API route code, the eight `_lib/` modules, relevant templates, and git history for secret leakage. Unread in detail: chat system prompt bodies (low-risk content), several `send-*-email.js` / `trigger-*` / `ingest-*` routes (expected to follow already-catalogued patterns), most `api/admin/*` read-only dashboard routes. The audit is considered comprehensive for Critical and High findings; Medium/Low/Nit counts would grow modestly with further reading.
