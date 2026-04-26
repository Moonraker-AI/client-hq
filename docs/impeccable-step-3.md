# Impeccable step 3 — design audit endpoint

Status: Shipped 2026-04-26.

Replaces the Step 3 plan in `docs/impeccable-integration.md` (regex-based
checker). That earlier approach was the wrong tool: regex on raw HTML can't
audit the rendered output of WordPress / Squarespace / Wix client sites,
where theme cascade and runtime CSS injection mean source HTML ≠ what the
user sees. Computed-style rules (contrast, line-length in actual rendered
chars, line-height, skipped headings, cramped padding) need a real browser.

## What ships

A synchronous design audit using the upstream impeccable browser-mode
detector running inside our existing Playwright stack on
agent.moonraker.ai.

### Agent side (moonraker-agent repo)

- `static/impeccable-browser-detector.js` — 98KB upstream detector,
  vendored unchanged from `pbakaus/impeccable@main`. Apache 2.0.
- `tasks/design_audit.py` — Playwright runner. Loads URL in chromium,
  sets `data-impeccable-extension="true"` on `<html>` so the detector
  enters extension mode, injects the detector via `add_script_tag`,
  awaits `document.fonts.ready`, calls `window.impeccableScan()`,
  serializes findings (DOM elements stripped, replaced with selector +
  tagName + rect). Hard cap 30s default, configurable 5-60s.
- `server.py` — adds `DesignAuditRequest` Pydantic model and
  `POST /tasks/design-audit` route. Acquires `browser_lock`, awaits
  result directly, returns 200 with findings or 504/502 on failure.
  No task_id, no callback. Caller blocks ~5-15s typical.

### CHQ side (client-hq repo)

- `api/design-audit.js` — thin proxy. Admin → CHQ → agent. Validates
  url, forwards to `${AGENT_SERVICE_URL}/tasks/design-audit` with
  `${AGENT_API_KEY}` bearer. 70s client timeout (>agent's 60s ceiling).
  Stateless — nothing persisted to Supabase.
- `vercel.json` — adds `api/design-audit.js` with `maxDuration: 75`
  and `memory: 512`. 32/50 entries used.

## Request / response shape

`POST https://clients.moonraker.ai/api/design-audit`
Auth: admin session OR internal bearer.

Body:
```json
{
  "url": "https://example.com/page",
  "viewport_width": 1440,
  "viewport_height": 900,
  "wait_for_selector": ".main-content",
  "timeout_seconds": 30
}
```

Only `url` is required.

Response:
```json
{
  "status": "complete",
  "url": "https://example.com/page",
  "scanned_at": "2026-04-26T12:34:56+00:00",
  "started_at": "2026-04-26T12:34:50+00:00",
  "viewport": {"width": 1440, "height": 900},
  "duration_ms": 7234,
  "findings": [
    {
      "id": "side-tab",
      "severity": "absolute",
      "category": "slop",
      "detail": "border-left: 4px solid",
      "selector": "div.alert-warning",
      "tagName": "div",
      "rect": {"x": 0, "y": 240, "width": 720, "height": 80},
      "isPageLevel": false
    }
  ],
  "summary": {
    "total": 4,
    "by_severity": {"absolute": 1, "strong": 2, "advisory": 1},
    "by_category": {"slop": 3, "quality": 1}
  }
}
```

## Severity classification

The upstream detector returns 28 finding types in two categories
(`slop` / `quality`). We map them to severity:

- **absolute** — upstream's hard bans we will never accept:
  `side-tab`, `border-accent-on-rounded`, `gradient-text`.
- **strong** — flagged by `MOONRAKER_DESIGN_BANS`, fix unless
  explicit override: `ai-color-palette`, `nested-cards`,
  `pure-black-white`, `gray-on-color`, `bounce-easing`, `dark-glow`,
  `icon-tile-stack`, `layout-transition`, `low-contrast`,
  `everything-centered`, `monotonous-spacing`.
- **advisory** — everything else: `overused-font`, `single-font`,
  `flat-type-hierarchy`, `line-length`, `cramped-padding`,
  `tight-leading`, `skipped-heading`, `justified-text`, `tiny-text`,
  `all-caps-body`, `wide-tracking`.

Severity classification lives in `tasks/design_audit.py`. To
re-classify a finding, edit `ABSOLUTE_BAN_IDS` / `STRONG_BAN_IDS`.

## Why the upstream detector verbatim

1. ~28 rules, most needing computed CSS / DOM walks. Porting any
   subset would be expensive and lose value.
2. Upstream is actively maintained (445 commits, 19k stars).
   Refreshing the static asset is a one-line cp.
3. The detector is self-contained IIFE — no build step, no deps.

## Coverage

Works on:
- R2-deployed Pagemaster pages (our own infra).
- WordPress sites where we've embedded HTML blocks under a third-party
  theme.
- Squarespace sites (same pattern).
- Wix sandboxed iframe pages and the parent site.
- Reference sites for design extraction.
- Internal admin surfaces (clients.moonraker.ai/admin/...).

Anywhere chromium can navigate to, this can audit.

## Browser lock contention

The agent's `browser_lock` is shared with Surge audits (which can take
20-35 minutes). If a design audit hits the lock during a Surge run,
it queues. The CHQ proxy has a 70s ceiling, so a Surge-blocked audit
will return 504 to the admin. Acceptable: design audits are
infrequent and the admin can retry after the Surge job completes.

If contention becomes a problem, we can spin a second chromium pool
on a separate lock — design audits don't need the same isolation
guarantees as Surge (no long-running sessions, no stealth).

## Stateless by design

V1 doesn't write findings to Supabase. Reasons:
- We don't see meaningful design drift on third-party theme updates,
  so trend tracking has low value right now.
- Storage shape would need a `design_audits` table with retention
  policy. Premature.
- Admin can paste the raw JSON into a comment field if they want a
  snapshot.

If we later want history, the natural shape is a `design_audits`
table keyed on `(client_slug, page_url, scanned_at)` with the result
JSON stored in a single column.

## Discarded from prior session

The previous session staged but never pushed:
- `api/_lib/design-checker.js` — regex-only port. Wrong tool. Discarded.
- `api/render-page-preview.js` patch injecting `design_issues` from
  the regex checker into the v2 JSON response. Discarded for the same
  reason — would only catch source-level patterns, miss themed sites.

If we want render-time auditing on R2-deployed pages specifically, the
right path is to call `POST /api/design-audit` against the preview URL
from the admin UI after render. Not yet wired.

## Deploy steps

Agent VPS:
```
ssh root@87.99.133.69
cd /opt/moonraker-agent
git pull origin main
docker compose down
docker compose build
docker compose up -d
```

The new file `static/impeccable-browser-detector.js` is included in
the image via `COPY . .` (Dockerfile L40). No Dockerfile change needed.

CHQ:
- Pushes auto-deploy via Vercel.

## Smoke test

After deploy:
```
curl -sS -X POST https://clients.moonraker.ai/api/design-audit \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://moonraker.ai"}' | jq .summary
```

Expected: 200 with summary block, total finding count 0-15ish for
our own well-styled site. If the agent isn't reachable, expect 502.
If timing out, expect 504.

## Next steps

- Step 4: apply impeccable to the homepage Pagemaster template. Use
  this audit endpoint as the critic loop. Audit Mark v3 render →
  patch template → re-audit → repeat.
- Step 5: wire upstream's `/audit`, `/critique`, `/polish` slash
  commands into `.claude/commands/`, calling this endpoint where
  appropriate.
