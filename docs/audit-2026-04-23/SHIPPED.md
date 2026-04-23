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

Deferred: Batch 6b AGENT_API_KEY rotation.

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

## Deferred work (follow-up batches)

### Needs new API endpoint + frontend swap (pair)
- **FE-H3 + API new route** — `/api/auth/change-password` endpoint that validates role field is NOT in payload. admin/login:196/247/340 then swap to call it. Current admin_profiles self-UPDATE is safe (Batch 4 trigger) but defense-in-depth wants the server-side route anyway.

### Needs new directory endpoints
- `/api/admin/client-detail?slug=X` — consolidates ~22 per-client deep-dive reads in admin/clients/index.html.
- `/api/admin/onboarding-directory` — consolidates admin/onboarding reads.
- `/api/admin/reports-directory` — consolidates admin/reports reads.
- Global client-search nav widget — shared across audits, clients, deliverables. Single cross-cutting migration.
- Per-page audits PATCHes (entity_audits saveLoom, changeEaStatus) — migrate to /api/action.

### Single-site polish
- endorsements.html, progress.html, proposal.html — 3 unguarded fetch sites flagged in Batch 7 FE-M5 sweep.
- FE-M7 — vendor Supabase SDK locally + narrow cdn.jsdelivr.net CSP grant (SRI-pin).
- FE-M2 — admin pages (14) missing offline-banner.js.

### DB outliers
- report_snapshots.ga4_detail has 1 legacy string row vs 30 objects. Fix the outlier, then add the `jsonb_typeof='object'` CHECK (deferred from Batch 7).
- 25 unused indexes — revisit after stats accumulate (too new to decide safely).

### VPS
- **Batch 6b** — AGENT_API_KEY rotation. Requires coordinated window: rotate Vercel env + /opt/moonraker-agent/.env + /opt/moonraker-admin/.env + recreate container. Rollback tested mentally but not exercised.
- moonraker-agent repo sync — patched admin_service.py v1.1.0 on the VPS has NOT been committed back to Moonraker-AI/moonraker-agent. Next VPS rebuild from repo would revert the rate-limit + audit tee. Fix: sync separately in that repo.
- VPS-H2 option B — replace /admin/exec with named RPCs (docker-restart, logs-tail, deploy). Larger effort; separate design.
- SSH move off port 22 (optional; 14,000+ brute-force probes vs 0 successful).

### Decisions still open
- Decision 7 revisit when hiring a 3rd admin.

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
- /admin/exec local log forgery: **mitigated** (off-host Supabase audit tee, pending 6b token rotation for full posture).
- tracked_keywords DELETE: **blocked** at app + schema layer.
- JSONB shape drift on renderer-critical fields: **blocked** at schema layer.
- contacts.status + lost drift: **blocked** at schema layer.

Security advisor final lint count: **0** (from initial 4 INFO + 2 WARN + 1 advisor).

Production: all 7 deploys Ready.
