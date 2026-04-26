Run systematic **technical** quality checks on a Moonraker client page and generate a comprehensive report. Don't fix issues — document them for `/critique`, `/polish`, and the other commands to address.

This is a code-level audit, not a design critique. Check what's measurable and verifiable in the implementation.

## Where Moonraker pages live

- **Client-facing templates**: `_templates/page-types/*.html` in `client-hq`. Rendered into `content_pages.generated_html` by the Pagemaster pipeline, then delivered via R2 / direct deploy.
- **Internal admin UI**: `admin/*.html` in `client-hq`. Admin JWT gated.
- **Public marketing**: `moonraker-website` repo. Indexed.
- **Live previews**: `/api/render-page-preview?slug=<client>&page=<slug>` returns the rendered HTML for a `content_pages` row. Use this URL for live audits.

When the user names a target, resolve it: a file path means audit source; a slug + page means audit the rendered preview URL; a bare URL means audit that URL directly.

## Diagnostic Scan

Run comprehensive checks across 5 dimensions. Score each 0-4 using the criteria below. **Always run the deterministic detector first** (see Detector below); it gives you ground truth for dimensions 1, 4, and 5.

### Detector (run this first)

`/api/design-audit` proxies the agent's Playwright + impeccable detector against any live URL. Use it when the target is a viewable page.

```bash
curl -s -X POST https://clients.moonraker.ai/api/design-audit \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"<target-url>","viewport_width":1440,"viewport_height":900}' \
  | python3 -m json.tool
```

For mobile, repeat with `viewport_width: 380, viewport_height: 800`.

The response contains `findings[]` (each with `severity: absolute|strong|advisory`, `category`, `detail`, `selector`) and a `summary` with counts. Treat `absolute` as P0/P1 and `strong` as P1/P2 and `advisory` as P2/P3 unless the impact says otherwise.

If the target is a source file (no live URL), skip the detector and audit by reading code directly.

### 1. Accessibility (A11y)

- **Contrast**: any text < 4.5:1 (or 7:1 for AAA). The detector flags this; cross-check with `api/_lib/contrast.js` clamp logic for any tokens that bypassed analyze-time clamping.
- **Missing ARIA**: interactive elements without proper roles, labels, or states. Inline `onclick` handlers (we use these intentionally) still need `aria-label` if the button content is icon-only.
- **Keyboard navigation**: focus indicators present, tab order logical, no traps. Critical on therapist-facing flows where users may rely on assistive tech.
- **Semantic HTML**: heading hierarchy intact, `<main>` / `<nav>` / `<footer>` landmarks, no `<div role="button">` where `<button>` would do.
- **Alt text**: images need descriptive alt. Pages from `_templates/` often interpolate `${client.business_name}` — check the fallback.
- **Forms**: inputs labeled, required fields indicated, error messages clear. `_audit-staging/` patterns from prior sessions apply.

**Score 0-4**: 0=Inaccessible, 1=Major gaps, 2=Partial, 3=WCAG AA mostly met, 4=AA fully met.

### 2. Performance

- **Layout shift (CLS)**: hero images without explicit dimensions, web fonts swapping in late, content jumping after JS hydrates.
- **Animations**: only `transform` and `opacity`. Anything animating `width` / `height` / `top` / `left` is a finding.
- **Image hygiene**: lazy loading on below-fold, appropriate format (WebP/AVIF where available), no oversized originals.
- **Font loading**: Outfit + Inter loaded with `font-display: swap`, no FOIT.
- **Inline JS**: anything pulling more than tokens at first paint is a smell. Defer-loaded helpers must use `ready()`-guard pattern (see `docs/client-page-helper-protocol.md`).

**Score 0-4** as above.

### 3. Theming

- **Hard-coded colors**: anything outside the token palette. Tokens come from `design_specs.color_palette` for client pages, or `/admin/design` for admin. Detector flags this with a `token_drift` category.
- **Dark mode**: `localStorage moonraker-theme` read before first paint; theme toggle uses `document.startViewTransition()` (0.25s); all colors flip cleanly.
- **Inconsistent tokens**: same conceptual color used twice with different values is drift.
- **Theme switching**: manually toggle and watch for elements that don't update — inline `style="color: #..."` is the usual culprit.

**Score 0-4** as above.

### 4. Responsive Design

- **Fixed widths**: any `width: <px>` on text containers is a smell. Use `max-width` + `margin: 0 auto`.
- **Touch targets**: < 44×44px is a P1 finding on mobile. The detector reports this.
- **Horizontal scroll**: re-run detector at `viewport_width: 380` and check for `overflow_horizontal` in findings.
- **Text scaling**: increase browser zoom to 200% and verify nothing breaks.
- **Breakpoints**: mobile-first with `@media (min-width: ...)` progressions.

**Score 0-4** as above.

### 5. Anti-Patterns (CRITICAL)

Cross-check every detector finding against the **DON'T** guidelines from the parent skill (already loaded). The parent skill has the full list; the canonical absolute bans are:

1. **Indented colored vertical bars on left edge** of cards/banners.
2. **Gradient text via `background-clip: text`**.

Strong bans (use only with explicit reason): pure `#000` / `#fff`, gray on colored backgrounds, glassmorphism, sparklines as decoration, identical card grids, hero metric template, cyan-on-dark, purple-to-blue gradients.

Moonraker-specific tells to watch for:

- The Pagemaster pipeline distills `voice_dna` and `color_palette` from a client's source site. If their source site has slop (gradient text, pure black, identical card grids), the analyze prompt should now strip it — but verify. A finding here means the **source-site audit on capture** isn't catching the pattern.
- Em-dashes in any client-facing copy: this is non-negotiable per coding conventions. Treat as P1.

**Score 0-4**: 0=AI slop gallery (5+ tells), 4=No AI tells.

## Generate Report

### Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | ? | [most critical a11y issue or "--"] |
| 2 | Performance | ? | |
| 3 | Theming | ? | |
| 4 | Responsive Design | ? | |
| 5 | Anti-Patterns | ? | |
| **Total** | | **??/20** | **[Rating band]** |

**Rating bands**: 18-20 Excellent, 14-17 Good, 10-13 Acceptable, 6-9 Poor, 0-5 Critical.

### Anti-Patterns Verdict

**Start here.** Pass/fail: does this look AI-generated? List specific tells from the detector + your read. Be brutally honest. A therapy client paying us for a distinctive online presence cannot ship a page that looks like every other AI-generated landing page.

### Executive Summary

- Audit Health Score: **??/20** ([rating band])
- Total issues found, broken down by severity (P0/P1/P2/P3)
- Detector counts: `absolute: N, strong: N, advisory: N`
- Top 3-5 critical issues
- Recommended next steps

### Detailed Findings by Severity

Tag every issue with **P0-P3 severity**:

- **P0 Blocking**: prevents page from shipping (broken layout, WCAG A failure, em-dashes, absolute detector finding) — fix immediately.
- **P1 Major**: WCAG AA violation, strong detector finding, on-brand voice failure — fix before client review.
- **P2 Minor**: advisory detector finding, minor inconsistency — fix in next pass.
- **P3 Polish**: nice-to-fix — fix if time permits.

For each issue, document: name, location (file/line or selector), category, impact, standard violated (if any), recommendation, suggested command.

### Patterns & Systemic Issues

Flag recurring problems that indicate the source pipeline missed something — for example, "Gradient text appears on 3 of 8 active client pages, suggesting `analyze-design-spec` isn't stripping it during distillation." These get fed back to Chris for upstream fixes, not patched per-page.

### Positive Findings

What's working. Specifically.

## Recommended Actions

List recommended commands in priority order:

1. **[P?] `/critique`** — UX review of [specific area]
2. **[P?] `/clarify`** — Rewrite [specific copy that failed Moonraker voice]
3. **[P?] `/harden`** — Edge cases for [specific component, e.g., long therapist names]
4. **[P?] `/polish`** — Final pass before client review

End with `/polish` as the final step if any fixes were recommended. After fixes, re-run `/audit` to verify findings drop to zero (or operator-acknowledged).

After presenting the summary, tell the user:

> Run these one at a time, all at once, or in any order. Re-run `/audit` after fixes to verify the score.

**NEVER**:

- Report a detector finding without checking the selector / location yourself; the detector occasionally false-positives on `<pre>` blocks and code samples.
- Skip the source-site cross-check for active clients; if a finding shows up on a client page, look at `design_specs` to see whether the pattern was inherited.
- Generate generic recommendations. Be specific: name the file, the selector, the fix.
- Forget to prioritize. Everything cannot be P0.
