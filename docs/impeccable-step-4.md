# Impeccable Step 4: Apply audit findings to homepage template

Status: shipped 2026-04-26 (commit `8aff0d2`).

## Goal

Run the design audit (built in Step 3) against a real client homepage render,
fold every finding back into `_templates/page-types/homepage.html` so future
renders inherit the fix. Mark v3 (`mark-obrien` slug, no `design_specs` row)
was used as the trial because no per-client overrides masked template
defaults. Anything wrong with a Mark v3 render is wrong with the template.

## Result

Mark v3 audit progression: 10 findings → 4 → 0.

| Round | Findings | Notes                                                        |
|-------|----------|--------------------------------------------------------------|
| 1     | 10       | 0 absolute, 9 strong, 1 advisory                             |
| 2     | 4        | All low-contrast brand-on-tint                               |
| 3     | 0        | Clean                                                        |

## The 6 fixes

All landed in commit `8aff0d2`. Selectors below refer to `_templates/page-types/homepage.html`.

1. **`.values` section restructure (icon-tile-stack pattern)**
   The values grid had 44×44 colored tiles stacked over headings. Generic
   AI dashboard slop, flagged as `slop` category. Replaced with a bare 22×22
   icon inline with the h3, wrapped in a new `.value-item-head` flex
   container. Grid gap increased to `2rem 2.5rem`, min column `280px`, body
   max-width `60ch`. The colored square is gone entirely; icon picks up
   `--color-accent` only.

2. **`.team-credentials` muted color**
   `var(--color-muted-text, #777)` → `var(--color-muted-text, #5a5a5a)`.
   `#777` on white falls below 4.5:1 for small text. `#5a5a5a` clears it.

3. **`.team-snippet` line length**
   Added `max-width: 65ch`. Untreated, snippets ran the full card width and
   blew through the 75-character readability ceiling on wide cards.

4. **Brand-tint fallback colors pre-composited to solid hex**
   Seven sites used `rgba(0,212,126, 0.12 / 0.18 / 0.04)` as fallbacks for
   `--color-primary-subtle` and `--color-surface-alt`. Replaced with
   `#e0faf0`, `#d1f7e8`, `#f5fdfa` respectively (alpha-on-white pre-composited
   to solid). This serves two purposes:

   - **Better default rendering** for clients without `design_specs` rows.
   - **Eliminates detector noise.** See "Detector contrast limitation" below.

5. **`.process-step-number` text color**
   `var(--color-accent, var(--color-primary, #00D47E))` (brand green) on the
   green tint background gave 1.8:1 contrast. Switched to
   `var(--color-heading-text, var(--color-primary-dark, #006e41))` —
   passes 4.5:1.

6. **`.team-headshot-fallback` text color**
   Same pattern as #5, same fix.

## Detector contrast limitation (background still relevant)

`resolveBackground()` in the upstream impeccable detector walks ancestors
and returns the first opaque background it finds — but for alpha-overlay
backgrounds (`rgba(brand, 0.12)` over a parent), it returns the alpha color
unmodified. `colorToHex()` then strips alpha. Result: `rgba(brand, 0.12)`
on white reports as solid brand color, which gives a false 1.0:1 contrast
finding because the text and background read as identical hex.

Fix #4 removes the noise at the template level: by defining fallbacks as
solid pre-composited hex, the detector sees `#e0faf0` as the resolved
background and computes contrast against that correctly.

This is captured upstream as a detector limitation, not a Moonraker bug.
The pre-compositing is the right fix regardless because it makes the
template render correctly without `design_specs` overrides.

## Audit infrastructure smoke pattern (validated)

Step 3 documented the loop. Step 4 exercised it end-to-end. Loop is:

1. Render the page locally via `/tmp/mr/rt/harness.js` (pulls live data
   from Supabase service role + applies template + nav/footer partials,
   produces output byte-identical to `/api/render-page-preview`).
2. Push to `_audit-staging/{name}.html` in the client-hq repo.
3. Wait ~30s for Vercel deploy. Note: Vercel strips `.html` from the URL,
   so the staging URL is `/_audit-staging/{name}` not `/_audit-staging/{name}.html`.
4. POST `/api/design-audit` (proxied to agent `POST /tasks/design-audit`)
   with the staging URL.
5. Iterate.

Once the staging audit hits 0 findings, fold the same edits into the
template, push, delete the staging file. Step 4 close-out followed exactly
this pattern.

## Footnote: temporary `api/audit-trigger.js`

The Step 4 close-out audit had to be invoked from a network where outbound
HTTPS was unavailable. A temporary GET wrapper at `api/audit-trigger.js`
authenticated by `CRON_SECRET` query param was created so the audit could
be triggered via the Vercel MCP `web_fetch_vercel_url` tool. It was
removed after the run completed (commits `d067018` / `553840c` / `4d9d6a0`).
The pattern is reusable but should not live in main long-term — it
broadens the auth surface.

Worth noting for future audit cycles: filenames starting with `_` in `api/`
are excluded from Vercel's serverless function discovery. The first attempt
named the file `_audit-trigger.js` and the deploy failed with
`The pattern "api/_audit-trigger.js" defined in functions doesn't match
any Serverless Functions inside the api directory`. Always use a non-leading-
underscore filename for new API routes.

## Next: Step 5 (slash commands)

Plan unchanged from Step 3 doc:

- Vendor `pbakaus/impeccable/source/commands/*.md` (18 files) into
  `client-hq/.claude/commands/`.
- Adapt `/audit`, `/critique`, `/polish` to know about Pagemaster file
  layout (`_templates/page-types/`, `/admin/design`, `design_specs` table).
- Test against Anna v2 with the patched template and a populated
  `design_specs` row.

## Other deferred work (still queued)

- Email deliverability: `diag-1777118232` marker test never landed in
  Gmail. Inspect Resend dashboard + Gmail spam/all/trash.
- `design_specs.screenshot_*` capture incomplete during Anna's onboarding;
  likely viewport-height or lazy-load timing in the agent.
- Add a `design_specs` row for Mark so subsequent audits exercise the
  override hierarchy (currently empty, which is why CSS fallbacks dominated).
- Audit Anna v2 with the Step 4 template for sanity (different client,
  different design_specs).
