# Post-Phase-4 Status Report

**Date:** 2026-04-17 (late session — Group A fully complete)
**Purpose:** Reconcile what's actually closed, group the ~87 remaining findings, and recommend a path forward that matches the value-per-session curve we've been on.

---

## Where the audit stands

All 9 Criticals closed. **Eleven Highs closed** (H5, H7, H8, H9, H10, H11, H14, H28, H33, H34, H35). M8, M13, M38 closed; M26 err-leak half closed, prompt-injection half deferred to Group D. **L8**, L14, L26, L27 closed. H21 has scaffolding landed (`api/_lib/google-delegated.js`) but 5 duplicate sites still need migration. `authenticator_secret_key` null-on-all-rows investigation resolved: `SENSITIVE_FIELDS` includes it; the null state just means no 2FA setup has been saved yet through the admin UI. Not a bug.

~87 findings remain. None of them are attack chains of the same severity as C1-C9. Most are hardening, consistency, and observability work. Ordering them linearly doesn't match their actual value; grouping them does.

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
| H21 + N6 | 7 copies of `getDelegatedToken` → extract `_lib/google-auth.js` with caching | 🔶 helper landed in `7adedb6` (`api/_lib/google-delegated.js` with token caching); 5 duplicate sites still pending migration |
| H4, H24, M10, M16 | `fetch()` without AbortController — extract `fetchWithTimeout` helper | 1 session |
| Pattern 12 | Migrate ~30 inline Supabase fetches in 5 big files to `sb.query`/`sb.mutate` | 1-2 sessions |
| H30, L7, L8, L22 | Duplicated helpers (Fathom dedup, Resend events, sbGet) | L8 ✅ closed; rest open |

**Recommendation:** H21 migration session is cheaper than originally scoped — the helper is already live in `api/_lib/google-delegated.js` with working token caching. Migration reduces to: delete 5 local copies, add require, rename call sites. Then AbortController. Then the Supabase helper migration.

### Group C — Template/email escape defaults (1 session, template surface)

| ID | Issue | Effort |
|---|---|---|
| H18 | Newsletter story fields rendered unescaped | In one session |
| H19 | Image URL not scheme-validated | Same session |
| H20 | `p()` + `footerNote` accept raw HTML | Same session |
| H22 | Proposal `next_steps` rendered unescaped | Same session |
| M6 | Monitor alert HTML unescaped | Same session |
| M22 | Unsub subscriberId not URL-encoded | Trivial |

**Recommendation:** One session. Goal: make the default behavior of every template helper "escape input," add `.raw()` variants for the rare case when the caller actually has HTML. This pattern lands across all template modules at once.

### Group D — AI prompt injection hardening (1 session)

| ID | Issue | Effort |
|---|---|---|
| H25 | `practiceName` raw-interpolated into Claude prompt (compile-report) | Included |
| H31 | 25K chars of RTPBA to Claude verbatim (generate-content-page) | Included |
| M15 | Therapist name unsanitized in content-chat prompt | Included |
| M26 | `page`, `tab`, `clientSlug` in chat.js prompt | Included |

**Recommendation:** One session. Standardize the "untrusted input in Claude prompt" pattern: structured delimiters (`<user_data>` tags), the same kind of treatment C9's endorsement sanitization gave but applied consistently everywhere user input reaches a prompt.

### Group E — Non-transactional state & idempotency (1 session)

| ID | Issue | Effort |
|---|---|---|
| H26 | onboarding seed DELETE+INSERT non-transactional | One session |
| H27 | compile-report highlights DELETE+INSERT non-transactional | Included |
| M11 | deploy-to-r2 DELETE+INSERT not idempotent | Included |
| M30 | generate-proposal fire-and-forget PATCHes swallow errors | Included |

**Recommendation:** One session. All four are the same class of bug — crash between DELETE and INSERT leaves zero rows. Standard fix is upsert or wrap in RPC. Pattern is clear; applying it takes an hour.

### Group F — Public endpoint hardening beyond rate limits (1 session)

| ID | Issue | Effort |
|---|---|---|
| H15 | submit-entity-audit empty-Origin bypass | One session |
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

**Group A pattern fix — H33 + H34 + H35 + M13 + M26 (err-leak half).**

Reasoning:
- Closes Group A completely. Symmetrical finish to the small-wins work.
- All five are the same shape: response bodies (and one NDJSON stream) leak `err.message`, Anthropic/Resend response bodies, or raw AI output on the 5xx path. Same fix pattern everywhere: route detail to `monitor.logError` server-side, return generic messages to caller.
- H28 (just shipped) is the reference pattern — `monitor.logError(route, err, { detail: {...} })` + sanitized response. Clean mental model for the session.
- One session, 5 files, ~5 commits.

After that, the recommended sequence is:

1. **Group A pattern fix — err.message leaks** (1 session) — H33, H34, H35, M13, M26
2. **Group B.1 — H21 google-auth migration** (1 session) — helper already live, 5 duplicate sites to replace
3. **Group C — template escape defaults** (1 session) — fixes 6 related findings in one pass
4. **Group B.2 — AbortController extraction** (1 session)
5. **Group D — AI prompt injection hardening** (1 session)
6. **Group E — non-transactional state** (1 session)
7. **Group B.3 — Supabase helper migration** (1-2 sessions)
8. **Group F — public endpoint hardening** (1 session)
9. **Group G — operational resilience batched small items** (1-2 sessions)
10. **Group I — Lows + Nits sweep** (1 session)
11. **Group H — M1 Stripe metadata** (once dashboard metadata is added)

Approximately 10-12 sessions to clear the remaining open findings, or we stop earlier once diminishing returns kick in.

---

## Prompt for next session (Group A pattern fix — err.message leaks)

```
Error-leak pattern session. Five findings, one shape: response bodies
(and one NDJSON stream) leak raw err.message, provider response bodies,
or raw AI output on 5xx paths. Same fix pattern as H28 we just shipped
(commit 0c9bc85): route detail to monitor.logError server-side, return
generic messages to the caller.

Read docs/api-audit-2026-04.md sections H33, H34, H35, M13, M26 first.
Then walk through your plan before touching code.

Reference pattern from H28 (api/bootstrap-access.js commit 0c9bc85):
    var monitor = require('./_lib/monitor');
    // ...in catch:
    await monitor.logError('route-name', err, {
      client_slug: slug,  // if available
      detail: { stage: 'parse_ai_response', raw: errBody }
    });
    return res.status(500).json({ error: 'Generic user-facing message' });

────────────────────────────────────────────────────────────────────
Fix 1: H33 — api/newsletter-generate.js (pre-verified on current main)
────────────────────────────────────────────────────────────────────
Sites (current line numbers on main, not audit-time numbers):
  L64   'Failed to load newsletter: ' + e.message
  L78   'Failed to load stories: ' + e.message
  L159  detail: errBody.substring(0, 500)   (Anthropic response body)
  L176  raw: aiData                          (entire AI response object)
  L184  raw: rawText.substring(0, 500)       (raw Claude output)
  L283  'Generation failed: ' + e.message
  L287  'Fatal: ' + fatal.message            (fatal-handler path)

Fix: require monitor at top; at each site, call monitor.logError with
provider/stage detail and return a generic error string. Preserve the
fatal-handler shape at L287 (it's wrapped in try/catch for stream-
closed cases) — just replace the body.

────────────────────────────────────────────────────────────────────
Fix 2: H34 — api/send-audit-email.js (pre-verified)
────────────────────────────────────────────────────────────────────
Sites:
  L120  detail: emailResult                  (entire Resend response)
  L162  error: err.message                   (outer catch)

Fix: both sites get monitor.logError routing; response returns generic
'Email send failed' / 'Internal server error'. The L120 site should
preserve the console.error('Resend error:', emailResult) at L119 that
already runs — just strip the detail from the response.

────────────────────────────────────────────────────────────────────
Fix 3: H35 — api/generate-content-page.js (pre-verified, NDJSON stream)
────────────────────────────────────────────────────────────────────
Sites (these stream via send({step:'error',...}), not res.json):
  L146  detail: errText.substring(0, 500)    (Anthropic response body)
  L168  raw_preview: responseText.substring(0, 500)  (raw Claude HTML)
  L248  message: err.message                 (outer catch)

Fix: require monitor; at each send({step:'error',...}) site, call
monitor.logError server-side with the raw detail, and stream only a
safe/generic message. Keep the NDJSON shape — callers of this route
expect `step: 'error', message: '...'` to appear in the stream.

────────────────────────────────────────────────────────────────────
Fix 4: M13 — api/newsletter-webhook.js (pre-verified — narrower fix)
────────────────────────────────────────────────────────────────────
Site: L259 `return res.status(200).json({ ok: false, error: e.message })`

This file already has its own logEvent() writing to webhook_log, and
L257 already calls `logEvent('db_error', { headers: hdrs, detail: { error: e.message, stack: ... } })`.
Don't add a second monitor.logError — the existing logEvent is the
route's logging pathway.

Fix: just strip `error: e.message` from the response body. Change to
`return res.status(200).json({ ok: false })` or similar. The detail
is already in webhook_log.

Also check the other error-response sites in the file (L67, L98, L131)
— they look fine (they already do logEvent + generic response) but
spot-confirm they're not leaking.

────────────────────────────────────────────────────────────────────
Fix 5: M26 (err-leak half only) — api/chat.js (pre-verified)
────────────────────────────────────────────────────────────────────
Site: L126 `return res.status(500).json({ error: 'Internal server error', detail: err.message })`

Fix: require monitor; call monitor.logError('chat', err) in the outer
catch; drop `detail` from the response. Keep the console.error at L125.

OUT OF SCOPE for this session: the prompt-injection half of M26
(page/tab/clientSlug in prompt) — that's Group D. Leave it alone.

────────────────────────────────────────────────────────────────────
Testing
────────────────────────────────────────────────────────────────────
- No smoke tests strictly required; all five fixes are shape-preserving.
- Expect Vercel deploy READY after each push (or batch as you prefer).
- Spot-check: for each file, grep for '\.message' and 'detail:' after
  the fix to confirm no remaining raw-detail response-body leaks on
  the 5xx path.

────────────────────────────────────────────────────────────────────
Out of scope
────────────────────────────────────────────────────────────────────
- L15 anon-key expiry design question.
- M26 prompt-injection half (Group D).
- Any AbortController work in these files (Group B.2).
- Migrating inline Supabase fetches in these files (Pattern 12).
- Adding rate limits (Group F — several of these are public-ish routes).

────────────────────────────────────────────────────────────────────
Deliverables
────────────────────────────────────────────────────────────────────
- 5 commits (one per file), or batched if you prefer — either works.
- Final commit: doc update to api-audit-2026-04.md marking H33, H34,
  H35, M13, M26 resolved in the resolution log. Update tallies:
  High 8 → 11 resolved, Medium 2+ → 4+ resolved.
- Also update post-phase-4-status.md Group A table to mark all five
  items closed, and update the "Where the audit stands" paragraph.
```

---

## Closing thought on the grouping approach

The original phase-based plan (phases 1-7) was right when the audit was fresh and we needed to prioritize Criticals. Now that Criticals are all closed, continuing phase-by-phase would force awkward sequencing — e.g. doing H9 in "Phase 5" and H18 in "Phase 7" even though they're unrelated.

Grouping by shape (what kind of fix, what files, what skill) means each session has a single theme, one mental model, one commit style. That's a better fit for the current phase of work.
