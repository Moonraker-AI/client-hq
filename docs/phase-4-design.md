# Phase 4 Design Decisions

**Purpose:** Three architectural questions that need answers before coding C3, C4, C7, C9. Each decision has options with tradeoffs. No code yet.

**Date:** 2026-04-17
**Author:** Claude (drafted during audit remediation planning)

**Status check (current state, not audit-time state):**
- 86 active contacts in lifecycle.
- 0 endorsements ever submitted (C9 is purely theoretical right now — no attack surface exploited, and no rush if we want to prioritize other work first).
- `activity_log` table exists with 126 rows, field-level change schema. Writes are from elsewhere in the codebase.
- No `rate_limits` or `page_tokens` table yet.
- `admin_profiles` role distinction exists: Chris is `owner`, Scott and support@ are `admin`. Manifest `require_role` enforcement works with no migration.

---

## Decision 1 — Page token design (blocks C3, C7, and parts of C9)

### The problem

Client-facing pages (`/<slug>/onboarding`, `/<slug>/audit`, `/<slug>/proposal`, `/<slug>/report`, `/<slug>/content-preview`, `/<slug>/endorsements`) are public URLs. They need to permit writes scoped to one contact without admin auth. Today, `onboarding-action.js` trusts the `contact_id` in the request body and only checks it points to a contact with `status='onboarding'` — anyone who knows any onboarding client's UUID (trivial: visit their page, read the network tab) can tamper with their data.

We need a mechanism where:
1. The server issues a token that proves "the bearer came from a legitimate link we generated."
2. The token binds the request to a specific `contact_id` + scope (e.g. `onboarding`, `endorsement`, `proposal-chat`).
3. Write endpoints extract the contact_id from the verified token, never from the request body.

### Option A — Stateless HMAC

```
token = base64url(JSON.stringify({ scope, contact_id, exp })) + '.' + HMAC_SHA256(payload, secret)
```

Issued at template-deploy time (baked into the HTML). Verified on every write request. No DB lookup.

**Pros:**
- Zero DB reads per request. Adds ~0.5ms of HMAC compute.
- No new table.
- Works offline-ish (if Supabase is down, verification still works).
- Smallest implementation: one file, `sign()` + `verify()`, ~30 lines.

**Cons:**
- **Can't revoke a single token** without rotating the secret (which invalidates every token for every client).
- Token lifetime is fixed at issue. For onboarding this is fine (expires when onboarding completes or ~90 days). For audit/report viewing, might need longer-lived tokens.
- Secret leak = everyone's tokens are forgeable. Mitigated by keeping it in Vercel env, never logging it, rotating on suspected compromise.

### Option B — Stateful (Supabase table)

Token is a random opaque string. Row in `page_tokens` table: `{ token, scope, contact_id, expires_at, revoked_at, uses_remaining }`.

**Pros:**
- Revoke individually (set `revoked_at`).
- Can enforce use-count limits ("this endorsement-submission token is single-use").
- Audit trail of token use (`uses_remaining` decrement on each verification).
- Can be bulk-invalidated via `UPDATE page_tokens SET revoked_at = now() WHERE contact_id = X` if a client asks to be forgotten.

**Cons:**
- One DB read per request. Adds ~10ms latency on every write endpoint.
- New table, indexes, maintenance cron for expired-token cleanup.
- More moving parts to test.

### Option C — Hybrid (HMAC + revocation list)

HMAC token as default (Option A). Plus a `revoked_tokens` table with just the token ID. Verification does HMAC check first (cheap), then checks revocation list only if HMAC succeeds.

**Pros:**
- Fast path is HMAC (~0.5ms). Revocation list is small (only revoked tokens, not all tokens) so the lookup is cheap even via PostgREST.
- Get revocation capability without paying per-request latency for every token.

**Cons:**
- Two codepaths to maintain.
- Revocation list still needs cleanup cron (after token's `exp` passes, the revocation row is redundant).

### Recommendation: **Option A (Stateless HMAC)**

Reasoning:
- For the scopes we actually need (onboarding: 90-day lifespan, tied to status; proposal: read-only so lower-stakes; endorsement submission: one-per-session fine; content-preview chatbot: short-lived), revocation is not a real requirement. When a client signs the agreement and onboarding is complete, the status check in the handler prevents further writes regardless of token validity.
- 86 active contacts is small. If we move to Option B later, we're not rewriting — we'd just add a DB lookup inside `verify()`. The call-site code doesn't change.
- Secret rotation is the big-hammer recovery: rotate the HMAC secret in Vercel, all existing tokens invalidate, admin re-deploys templates (which re-issues fresh tokens). Acceptable for this scale.
- **Exception:** if C9's endorsement flow ends up needing "submit one endorsement per invite email," that's a use-count semantic that HMAC can't enforce cleanly. In that case, add a `page_tokens` table later specifically for endorsement tokens — scope-limited, not general.

### Concrete shape

```
// api/_lib/page-token.js
const SCOPES = ['onboarding', 'proposal', 'content_preview', 'endorsement', 'report'];
const DEFAULTS = {
  onboarding: 90 * 86400,
  proposal: 60 * 86400,
  content_preview: 30 * 86400,
  endorsement: 180 * 86400,
  report: 30 * 86400
};

exports.sign = function({ scope, contact_id, ttl_seconds }) { ... }
// returns 'scope.contactId_b64.exp.signature'

exports.verify = function(token, expectedScope) { ... }
// returns { contact_id, exp } on success, null on failure
// throws is fine too; callers wrap in try/catch
```

Deploy-time token embedding: every template that gets deployed to `<slug>/<page>/index.html` gets a `window.__PAGE_TOKEN__` injected. Client-side JS reads it and includes it in every API call to the scoped endpoint.

Environment: new env var `PAGE_TOKEN_SECRET`, 32-byte hex string, same pattern as `CREDENTIALS_ENCRYPTION_KEY`.

---

## Decision 2 — Rate-limit backing store (blocks H5, H14, and public endpoints in C9)

### The problem

Seven-ish endpoints need rate limiting: the four public chat streams (`agreement-chat`, `content-chat`, `proposal-chat`, `report-chat`), `submit-entity-audit`, `newsletter-unsubscribe`, and (once C9 ships) the endorsement submission endpoint. Each has a different abuse profile — chat endpoints are the expensive ones (Claude API cost), submission endpoints need spam/DoS protection.

We need: a way to record "this IP+route hit count in this window," check it atomically, and fail closed if the store is down.

### Option A — Supabase table

```sql
CREATE TABLE rate_limits (
  bucket_key text PRIMARY KEY,  -- e.g. "ip:1.2.3.4:chat"
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1
);
```

With an upsert RPC that increments atomically:
```sql
INSERT ... ON CONFLICT (bucket_key) DO UPDATE SET
  count = CASE WHEN window_start < now() - interval '1 minute'
               THEN 1 ELSE rate_limits.count + 1 END,
  window_start = CASE WHEN window_start < now() - interval '1 minute'
                      THEN now() ELSE rate_limits.window_start END
RETURNING count;
```

**Pros:**
- No new infrastructure. Same project, same connection pool, same monitoring.
- Free within existing Supabase plan.
- Data is inspectable via admin UI if we ever want to see who's hitting what.
- Atomic via the DO UPDATE.

**Cons:**
- ~10ms per check (PostgREST round trip). On the chat endpoints this is negligible (the Claude call is 2000ms+). On `newsletter-unsubscribe` it's noticeable but fine.
- Table grows unbounded unless we add a cleanup cron (easy: `DELETE WHERE window_start < now() - interval '1 day'` daily).
- Connection pool pressure if chat endpoints take off (every stream request is now 1 extra DB call).

### Option B — Vercel KV (managed Redis)

**Pros:**
- Fast (~2ms).
- Native TTL support (keys auto-expire, no cleanup needed).
- Designed for exactly this use case.

**Cons:**
- Costs money. Free tier: 30K requests/month, then $0.25 per 100K requests. With 86 clients and current traffic, we're nowhere near the free tier limit. But if `agreement-chat` gets hit from ad traffic, we could spike.
- New dependency, new dashboard to check, new env var.
- Tied to Vercel. If we ever migrate off, this is one more thing to port.

### Option C — Upstash Redis (direct)

Same Redis semantics as Vercel KV, but direct from Upstash. Generous free tier (10K commands/day per database, multiple DBs). HTTP-based so works from serverless.

**Pros:**
- Same speed as Vercel KV.
- Free tier covers our current scale easily.
- Not tied to Vercel.

**Cons:**
- Yet another vendor dashboard.
- Separate monitoring.

### Option D — In-memory per-instance with Supabase fallback

Module-level `Map` in each Vercel instance. Warm instances share the cache; cold starts reset it. Periodically flush hot buckets to Supabase for persistence across cold starts.

**Pros:**
- Zero latency on the fast path.

**Cons:**
- Vercel's multi-instance reality means rate limits are per-instance. A determined attacker gets N× the limit where N = number of warm instances.
- Complex failure modes.
- **Don't pick this.** It looks clever but breaks in production.

### Recommendation: **Option A (Supabase table)**

Reasoning:
- Current scale is 86 clients + ad-hoc public traffic. 10ms extra latency on rate-limited endpoints is invisible compared to the Claude API latency that dominates the response time.
- Keeps infra consolidated. One database, one connection pool, one place to look when things break.
- Zero new vendors, zero new env vars, zero new dashboards.
- The table-growth concern is a real-but-solved problem (daily cleanup cron).
- Can migrate to Upstash later if Supabase latency becomes a bottleneck — the interface is `rateLimit(key, limit, windowSeconds)`, backing store is swappable.

### Concrete shape

New table `rate_limits(bucket_key, window_start, count)`. New RPC `rate_limit_check(bucket_key text, limit_count int, window_seconds int)` returning `boolean` (true = allowed).

```
// api/_lib/rate-limit.js
exports.check = async function(key, limit, windowSeconds) { ... }
// returns { allowed: bool, count: number, reset_at: Date }
```

Call sites:
- `chat.js` public endpoints: 20 requests/min per IP
- `submit-entity-audit.js`: 3 submissions/hour per IP (replaces the current global limit — H14)
- `newsletter-unsubscribe.js`: 30/min per IP (permissive but blocks enumeration bursts)
- Future endorsement endpoint: 3/hour per IP

Bucket key shape: `<ip>:<route>` for IP limits, `<contact_id>:<route>` where we have a token (per-user limits).

IP source: `x-forwarded-for` first entry (Vercel sets this), falling back to `x-real-ip`.

Cleanup: new cron `api/cron/cleanup-rate-limits.js` runs daily, deletes rows where `window_start < now() - interval '1 day'`.

---

## Decision 3 — action.js direction (blocks C4)

### The problem

`api/action.js` is a generic admin mutation endpoint: `{action, table, filters, data}` → PostgREST call. Two issues:
- **Filter injection (C4):** `buildFilter` passes values starting with `eq|neq|gt|...` prefix through unescaped. Admin JWT compromise → broad read/write/delete.
- **No audit log:** 40+ tables are mutable with no record of who did what.

The same route is called from the admin UI (all of it) and from the AI chat assistant (action blocks the user confirms). Both expect arbitrary table/data flexibility.

### Option A — Harden `buildFilter`, keep generic shape

Extract `_lib/postgrest-filter.js`:
```
exports.buildFilter = function(filters) {
  // filters is an object; each value is either:
  //   - a primitive (number, string, bool) → becomes `col=eq.<encoded>`
  //   - an object: { op: 'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'in'|'is', value: ... }
  //     where value is always encoded, op is allowlisted
  // no string passthrough of operator-prefixed values, ever
}
```

Update `action.js` to reject operator-prefixed strings. Update the admin UI's `apiAction()` helper to build the new shape. Update `chat.js`'s action-block format to match.

Add `activity_log` writes on every mutation: one row per changed field per mutation (the existing schema supports this).

**Pros:**
- Smallest diff. The generic shape is what the admin UI and chat assistant both already use.
- Audit log via existing table, no schema changes.
- Fix applies to `onboarding-action.js` too via shared `postgrest-filter.js`.

**Cons:**
- Generic shape still means "admin can read/write/delete anything on the allowlist." No per-table permission granularity.
- `signed_agreements`, `payments`, `workspace_credentials` are still mutable via this endpoint (admin compromise → data destruction).
- AI chat assistant still emits free-form action JSON; any injection in Claude's output still lands on this endpoint (but at least the filters are safe).

### Option B — Replace with named actions

Delete the generic shape. Add one endpoint per operation type: `api/actions/update-contact-status`, `api/actions/create-deliverable`, etc. Each endpoint has its own schema validation, per-action rate limit, per-action audit log.

**Pros:**
- Each action has explicit allowed fields. Can't update `signed_agreements.signed_at` even with a compromised JWT.
- Easy to deprecate individual actions without breaking others.
- Self-documenting (endpoint name = what it does).

**Cons:**
- Huge diff. Admin UI currently has ~40 distinct apiAction() call sites; each becomes its own endpoint.
- Chat assistant's action-block format needs a total rewrite.
- Future admin features are slower to build (each new action = new route file).
- Vercel function limit pressure (every new route is another function).

### Option C — Shape-aware middleware

Keep the generic endpoint. Add a per-table manifest:
```
// api/_lib/action-schema.js
exports.TABLES = {
  contacts: { read: ['*'], write: ['status', 'lost', 'first_name', ...], delete: false },
  signed_agreements: { read: ['*'], write: [], delete: false },
  workspace_credentials: { read: ['*'], write: ['gmail_email', ...], delete: true, require_role: 'owner' },
  payments: { read: ['*'], write: [], delete: false },
  ...
};
```

`action.js` looks up the manifest, rejects disallowed operations per-table. Generic shape preserved; security granularity gained. Audit log still writes per mutation.

**Pros:**
- Mid-sized diff (one new file, small edit to `action.js`).
- Per-table + per-field granularity without per-action routes.
- Future-proof: adding a new table is a manifest entry, not a route.
- Defense in depth against admin JWT compromise.

**Cons:**
- Manifest has to be maintained. Forgetting to add a new table → it's blocked by default (good for security) but the UI breaks (bad UX). Clear error message mitigates.
- Per-row permissions (e.g. "admin can only edit contacts they're assigned to") isn't expressed here. Probably fine — we don't have per-row RBAC today.

### Recommendation: **Option C (shape-aware middleware)**

Reasoning:
- Option A is too loose. Even with filter injection fixed, an admin JWT compromise still nukes `signed_agreements` and `payments`.
- Option B is too much code for the value gained. 40 endpoints is genuinely a lot of drift to maintain, and the admin UI / chat assistant both assume a generic action shape.
- Option C threads the needle. Security per table/field, generic call site, explicit record of what's mutable and what isn't. Manifest doubles as internal documentation ("what can admins do with this table?").
- Once the manifest exists, `onboarding-action.js` can share it — the public-side version uses a whitelist subset: `practice_details` (write: specific fields), `bio_materials` (write: specific fields), etc.

### Concrete shape

New file `api/_lib/action-schema.js` with table manifest. Update `api/action.js` and `api/onboarding-action.js` to consult the manifest. Update `_lib/postgrest-filter.js` (from C4 fix) to use structured filter input. Every mutation writes field-level rows to `activity_log`.

Security additions:
- `require_role` key in manifest: `'owner'` means only Chris (admin_profiles.role='owner'). `workspace_credentials` and `signed_agreements` should require owner. **Confirmed: role distinction already exists. Chris=`owner`, Scott & support=`admin`. No migration needed.**
- `write: []` for read-only tables means any PATCH/POST is rejected.
- `delete: false` rejects DELETE regardless of filters.

Migration:
- Ship the manifest with defaults that mirror current behavior (nothing blocked). Add audit log writes.
- Observe admin UI for a week, verify nothing breaks.
- Tighten manifest: restrict `payments`, `signed_agreements` to read-only. Tighten `workspace_credentials` to owner role.

---

## Recommended sequence

1. **Ship page-token design (Decision 1).** Low risk, no DB changes, small new file. Validates the approach on one endpoint before spreading to others. Suggest starting with `proposal-chat.js` because it's the chattiest endpoint with the clearest ownership model (token issued at proposal deploy time).
2. **Fix C3/C7** using page tokens. At this point `onboarding-action.js` still has the filter-builder bug (C4 shared code), but with token-bound contact_id the blast radius is already contained — attacker would need a valid token for a specific victim contact, which is one per person.
3. **Ship rate-limit store (Decision 2)** as a separate PR. Zero logic changes; just the new table, RPC, and helper module. Gets production exercise before we rely on it for abuse protection.
4. **Apply rate limit** to the chat endpoints (H5). High-value, low-risk — adds a check at the top of each handler.
5. **Ship action-schema manifest (Decision 3)** in permissive mode (everything allowed). Add audit log writes. This completes C4 for the filter-injection side; the full permission model follows as a tighten-up PR.
6. **Tighten manifest.** Restrict `signed_agreements`, `payments`, `workspace_credentials`. Observe for a week. Ship.
7. **C9 endorsement chain.** Rate-limit the collection endpoint. Add page-token to the submission path (scope: `endorsement`). Add server-side HTML sanitization to the content-page deploy (`_lib/html-sanitizer.js` or a library like `sanitize-html`). Revisit urgency once the other pieces ship — right now no endorsement has ever been submitted, so C9's practical risk is zero.

Each step is ~1 focused session. Total time-to-all-criticals-closed: 6-7 sessions.

---

## Open questions for Chris

1. **Page token lifetime for onboarding:** I suggested 90 days. Is that comfortable, or should it tie to the onboarding status flip (token invalidates when contact transitions to `active`)?
2. **Rate limit for chat endpoints:** 20 req/min per IP is conservative — a real user clicking "ask again" a few times hits this. Is that the right ceiling, or do you want more headroom? (I can also key by contact_id where we have a token, which permits real users more while limiting casual attackers.)
3. **Manifest `role` distinction:** ✅ **Confirmed.** `admin_profiles` already has Chris=`owner` and Scott/support=`admin`. `require_role: 'owner'` works as-designed. No migration needed.
4. **C9 urgency:** zero endorsements today means we have flexibility. Do you want to ship C9 before the endorsement feature gets real usage, or park it until endorsements start coming in? (Parking is fine; just noting the feature exists and is unused.)

Once Q1, Q2, Q4 are answered, we have enough to start Phase 4.
