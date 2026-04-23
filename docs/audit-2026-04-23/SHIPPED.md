# Audit 2026-04-23 — Remediation Log

Starting findings: **4 Critical / 21 High / 40 Medium / 39 Low / 25 Nit** across 5 domains (API, frontend, cron, DB, VPS).

7 remediation batches shipped, all deployed to production.

---

## Batch-by-batch

### Batch 0 — `02a07022` — safe quick wins
- Cron: cleanup-rate-limits schedule comment fix; fetchT 15s on Resend in process-followups + trigger-quarterly-audits; AbortSignal.timeout on agent dispatch; status guards on process-audit-queue requeue PATCHes; explicit maxDuration=60 for process-audit-queue in vercel.json.
- API: health.js method guard; attribution-sync swapped to requireAdminOrInternal (constant-time).
- Frontend: String(body_html ‖ '').replace guard on 6 preview paths; alt on admin logo; alt="" on 3 decorative imgs; title on booking/Leadsie/newsletter-preview iframes.
- 12 files, 37+/30-.

### Batch 1 — `5839d162` — CRITICAL XSS + cron retry
- admin/clients + admin/audits: 3 `iframe.contentDocument.write(body_html)` XSS paths migrated to sandboxed srcdoc + full HTML escape (&, <, >, ", '). allow-same-origin retained for height auto-measure.
- admin/proposals SB_SVC → SB_ANON (misleading var name).
- proposal_followups + audit_followups retry migration (attempt_count / retriable / next_attempt_at / last_error + partial idx). process-followups handler rewrite: HTTP classify, 5/15/60-min backoff, MAX_ATTEMPTS=3, monitor.critical at exhaust.
- 6 files + 2 migrations.

### Batch 2 — `a7e31ce4` — API hardening sweep
- err.message leak sweep across 22 handlers: generic 5xx strings, full detail to monitor.logError. 15 monitor imports added.
- admin/chat.js Anthropic passthrough rate limit (60/60 per admin.user.id).
- encodeURIComponent sweep across 12 admin/internal routes; UUID regex + allowlisted join on trigger-batch-audit keyword_ids.
- checkout/create-session rate limit (20/60 per IP).
- newsletter-webhook svix-signature strip from headers_snapshot.
- 34 files, 166+/78-.

### Batch 3 — `65fc95ee` — frontend admin-auth hardening
- admin/newsletter preview iframe: sandbox="allow-same-origin" → sandbox="" (full lockdown). api/newsletter-preview routes output through sanitizeHtml() (defense in depth).
- _templates/content-preview: function-replacer kills $1/$2/$3 backref interpretation on endorsement inject. Existing esc() helper already covers per-field escape.
- FE-H2 verified already met (3 admin pages already use directory endpoints).
- FE-H3 deferred (needs new /api/auth/change-password endpoint).
- 3 files.

### Batch 4 — `1b14fe49` — DB hardening
- RLS state confirmed on all 60 public tables.
- report_configs wide-open anon SELECT (qual=true): dropped policy.
- admin_profiles self-UPDATE self-promotion risk: BEFORE UPDATE trigger blocks role/email/id mutation unless service_role.
- claim_next_audit / claim_next_content_page(uuid) / claim_next_report_queue: REVOKE EXECUTE from anon, authenticated, PUBLIC.
- client_attribution_insights + pending_checkout_sessions: explicit service-role policies (RLS-enabled-no-policy advisor INFO cleared).
- site_maps_touch_updated_at + touch_client_attribution_insights_updated_at: search_path pinned (advisor WARN cleared).
- signed_performance_guarantees.superseded_by: missing FK index added.
- workspace_credentials duplicate index dropped (UNIQUE covers same column).
- contacts_status_check: 'lost' added to allowlist (code already compared to it).
- Decision 2 (recommended C): contacts_lost_status_coherent CHECK — lost=true IFF status='lost'. All 113 existing rows comply.
- Security advisor post-migration: 0 lints.
- 1 migration file.

### Batch 5 — `5d80a0a1` — cron concurrency + report_queue retry
- Step 0.5 requeue folded into SECURITY DEFINER RPC requeue_retriable_agent_errors(timestamptz, int) with FOR UPDATE SKIP LOCKED. REVOKE EXECUTE from anon/authenticated/PUBLIC.
- process-audit-queue: replaces per-row PATCH loop with single RPC call.
- report_queue retry columns (attempt_count / retriable / next_attempt_at / last_error + partial idx).
- claim_next_report_queue RPC extended: claims pending OR retriable failed whose backoff elapsed.
- process-queue: full rewrite — classify compile errors (4xx perm, 5xx/network transient), 15/60/240-min backoff, MAX=3, monitor.critical at exhaust. 280s compile-report timeout preserved.
- process-scheduled-sends + process-followups outer-catch: 500 → 200 (per-row retry state authoritative).
- process-queue + process-batch-pages telemetry snapshot: blocking sb.query → fire-and-forget async IIFE.
- 8 files + 3 migrations.

### Batch 6a — `2f6ba698` — agent VPS hardening
VPS-side (moonraker-agent host — NOT in this repo):
- fail2ban caddy-admin-401 regex widened to (401|403|422|500). 2 historical hits found.
- admin_service.py v1.0.0 → v1.1.0: 10 req/60s per-IP rate limit before auth; 429 + Retry-After; rate_limit.exceeded logged. Fire-and-forget audit tee to Supabase.
- docker-compose.yml: security_opt no-new-privileges + cap_drop ALL.
- systemd override: NoNewPrivileges / PrivateTmp / ProtectSystem=strict / ProtectHome=ro / scoped ReadWritePaths.
- /etc/cron.daily/docker-builder-prune (reclaimed 28.88 GB on install).
- apt upgrade docker-ce + snapd (docker 5:29.4.0 → 5:29.4.1).

Repo-side:
- migrations/2026-04-23-vps-admin-audit-log.sql: public.vps_admin_audit_log table + RLS (service-role full, admin SELECT via is_admin()).
- 1 migration file.

Deferred: Batch 6b AGENT_API_KEY rotation (shipped separately below).

### Batch 6b — AGENT_API_KEY rotation (Option A coordinated swap)
- Generated new 32-byte hex token (never printed to chat, shredded post-rotation).
- Saved old value from `vercel env pull` to `/tmp/agent_api_key.old` (600) for rollback.
- VPS: `sed -i` on `/opt/moonraker-agent/.env` + `/opt/moonraker-admin/.env` with new value. Backups at `.env.bak-rotate-<ts>`. Services NOT restarted yet (still holding old in memory).
- Vercel: `env rm AGENT_API_KEY production` + `env add AGENT_API_KEY production` with new value. Note: initial pipe preserved trailing newline as literal `\n`; fixed via `tr -d '\n'` re-pipe.
- Empty commit + push to trigger redeploy. Vercel Ready 14s.
- VPS: `systemctl restart moonraker-admin` + initially `docker restart moonraker-agent` (insufficient — `docker restart` keeps old env). Re-did with `docker compose up -d --force-recreate agent` to reload `.env`.
- Verification:
  - `curl -H "Authorization: Bearer <OLD>" /health` → 401
  - `curl -H "Authorization: Bearer <NEW>" /health` → 200
  - Same pair on `/admin/health` → 401 / 200
- Blackout window: ~2 minutes (extended by the `docker restart` vs `--force-recreate` gotcha). Retry logic from Batches 1B + 5 absorbs any cron misses during the window.
- Secrets shredded: `/tmp/new_agent_key`, `/tmp/agent_api_key.old`, `/tmp/agent_api_key.vercel_check`, `/tmp/vercel_env.production`, `/tmp/vercel_env.verify`.
- VPS backup `.env.bak-rotate-<ts>` files retained (600) as rollback artifact; clean up in a follow-up if rotation holds.

### Batch 7 — `649b8b3a` — minimal cleanup
- trigger-agent: audit.contact_id === body.contact_id mismatch guard (M3).
- csp-report: 16 KB size cap (413) + 60/60 IP rate limit (L6).
- action-schema.js: tracked_keywords delete:true → delete:false (retire-only protocol).
- 9 client templates: credentials:'same-origin' on 13 fetch sites (M5).
- add-ons.html: offline-banner.js import added (M1). Coverage 15/15.
- checkout + entity-audit-checkout: alert() → branded inline error banner (M6).
- DB (Decision 3 + 4):
  - newsletters.content + 4 report_snapshots JSONB cols: CHECK jsonb_typeof='object' (nullable tolerant).
  - report_snapshots.deliverables: CHECK jsonb_typeof='array'.
  - tracked_keywords: BEFORE DELETE trigger raises; retire-only enforced schema-side.
- 13 files + 1 migration.

---

## Decisions resolved

| # | Question | Resolution |
|---|---|---|
| 1 | Retry state rollout | A — mirror newsletter pattern per table |
| 2 | contacts.status vs contacts.lost | C — keep both, CHECK coherence |
| 3 | JSONB shape enforcement | A — add jsonb_typeof checks now |
| 4 | keywords retire enforcement | B — action-schema false + DB trigger |
| 5 | /admin/exec posture | A — in-process rate limit (B as follow-up) |
| 6 | Token rotation date | Deferred — Batch 6b, next quiet window |
| 7 | workspace_credentials tightening | A — defer until 3rd admin |
| 8 | Email enumeration oracle | B — keep (UX wins) |
| 9 | Stripe amount-fallback | A — keep belt + suspenders, documented |

---

## Follow-up batches (shipped post-Batch 7)

### FE-H3 + FE-H2 extras — `0c91ea5d`
- `api/auth/change-password.js` — POST, admin-gated, rate-limited, rejects role/email/id/display_name in payload.
- `api/admin/client-deep-dive.js` — one-call replacement for 22 per-client REST reads.
- `api/admin/onboarding-directory.js` + `api/admin/reports-directory.js` — admin-gated directory consolidators.
- admin/login handlePasswordChange swapped to change-password endpoint.
- admin/onboarding + admin/reports + admin/clients (3 of 22 deep-dive sites) migrated.

### check-must-change + ga4_detail + offline-banner + FE-M5 leftovers — `831b7d11`
- `api/auth/check-must-change.js` — GET admin-gated; replaces direct admin_profiles reads from admin/login. Post-swap: 0 `admin_profiles` refs in admin/login.
- `migrations/2026-04-23-report-snapshots-ga4-detail-fix.sql` — UPDATE `(ga4_detail #>> '{}')::jsonb` on 1 legacy double-encoded row (`anna-skomorovskaia` / `2026-03-01`), then add `jsonb_typeof='object'` CHECK. Post-apply: 31/31 rows object.
- /shared/offline-banner.js added to all 14+1 admin pages (discovered admin/system during sweep).
- credentials:'same-origin' added to 3 remaining flagged fetch sites (endorsements, progress, proposal).

### FE-M7 full sweep + admin/clients cache-invalidation + admin/reports scope widen — `3c1d22bb`
- Supabase SDK 2.49.4 vendored to `/vendor/supabase/` with SRI.
- chart.js 4.4.1 vendored to `/vendor/chartjs/` with SRI (campaign-summary template).
- 13 HTML files swapped (12 admin pages + 1 template). admin/login swapped in the prior sub-batch.
- `vercel.json` CSP: dropped `https://cdn.jsdelivr.net` from `script-src` AND `connect-src`.
- admin/clients: added `refreshDeepDive` + `refreshDeepDiveSlice` with stale-client-race guard. 18 additional REST fetches migrated via cache-refresh pattern. `/rest/v1/` count dropped 22 → 1 (the last is the new-client slug-uniqueness check — handled in the next batch).
- admin/reports: dropped client-side `.filter(status==='active')`. Reports view now surfaces onboarding clients.

### AGENT_API_KEY rotation (Batch 6b) — `e6c6c2d5`
See the Batch 6b section above.

### moonraker-agent repo sync
PR #5 open at https://github.com/Moonraker-AI/moonraker-agent/pull/5. `host_admin/admin_service.py` v1.0.0 → v1.1.0 (rate limit + audit tee + version bump). Awaits operator review/merge.

### Final slug-check endpoint + admin/clients 0 REST
- `api/admin/check-slug.js` — GET admin-gated; rate-limited; UUID-style slug regex; returns legacy-compatible `[{id, practice_name}]` array shape so the admin/clients page-side swap is a one-line URL change.
- admin/clients line 10051: swapped to `fetch('/api/admin/check-slug?slug=…')`. Post-migration `/rest/v1/` count in admin/clients: **0**.

---

## Open / deferred (nothing blocking audit closure)

- **moonraker-agent PR #5** — your review/merge at convenience.
- **VPS `.env.bak-rotate-1776955281`** — delete after ~2026-04-30 (1 week stable post-rotation) via `ssh root@87.99.133.69 "rm /opt/moonraker-*/.env.bak-rotate-1776955281"`.
- **Decision 7** (`workspace_credentials` role-scoping) — revisit when hiring 3rd admin.
- **25 unused indexes** — revisit after stats accumulate (too new to decide).
- **Browser smoke test** — admin/login, any admin dashboard, any client `campaign-summary` page. Confirm vendored SDK + chart.js load + no CSP violations in devtools console.

---

## Top-line posture deltas

- Admin XSS session-takeover risk from DB-controlled HTML: **eliminated** on the 4 known sites.
- 22 handlers no longer leak backend internals via err.message: **eliminated**.
- report_configs wide-open anon SELECT: **eliminated**.
- admin self-role-promotion via admin_profiles self-UPDATE: **eliminated** at DB layer.
- claim_next_* RPCs anon-callable: **eliminated**.
- 2 follow-up queues (proposal + audit) silent permanent loss on Resend hiccup: **eliminated** (retry + backoff).
- report_queue silent permanent loss on compile failure: **eliminated**.
- process-audit-queue Step 0.5 race vs Step 1 claim: **eliminated** (RPC w/ SKIP LOCKED).
- /admin/exec anon floodable: **eliminated** (10 req/60s + widened fail2ban).
- /admin/exec local log forgery: **mitigated** (off-host Supabase audit tee).
- AGENT_API_KEY stale (pre-rotation): **rotated** in Batch 6b. Old key revoked (401), new key accepted end-to-end on both /health and /admin/health.
- tracked_keywords DELETE: **blocked** at app + schema layer.
- JSONB shape drift on renderer-critical fields: **blocked** at schema layer.
- contacts.status + lost drift: **blocked** at schema layer.

Security advisor final lint count: **0** (from initial 4 INFO + 2 WARN + 1 advisor).

Production: all 7 deploys Ready.
