Final pass on a Moonraker client page before it goes to client review. Catch every detail that separates "shipped" from "polished." This is what the client sees in their first reaction; first reactions don't get re-rolled.

> **Additional context needed before starting**: which client and which page; whether prior `/audit` and `/critique` have been run; what's the ship deadline.

## Design System Discovery (not optional)

Polish without alignment is decoration on top of drift. Discovery comes before any other polish work.

Moonraker has two surfaces and the discovery step is different for each:

### Client-facing pages (`_templates/page-types/`, rendered via Pagemaster)

Tokens come from `design_specs` for the specific client.

- **Color palette**: `design_specs.color_palette` (post-clamp values; the contrast clamp at `api/_lib/contrast.js` already enforced WCAG AA).
- **Typography**: `design_specs.typography`.
- **Voice**: `design_specs.voice_dna`.
- **Status**: confirm `analyze_status = 'complete'` and there are no entries in `capture_errors`. If the design spec is incomplete, polish the spec first, not the page.

Pull the spec:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://clients.moonraker.ai/api/admin/design-spec?slug=<client-slug>" \
  | python3 -m json.tool
```

### Admin / internal UI (`admin/`)

Tokens come from `/admin/design`. Always fetch the live reference before changing anything:

```bash
curl -s https://clients.moonraker.ai/admin/design/
```

Primary `#00D47E` (stable in light + dark). Outfit headings (700/600), Inter body (400/500/600). Card radius 14px, row 8px, button 6-8px. Dark mode via `localStorage moonraker-theme`, read before first paint. Theme toggle uses `document.startViewTransition()`.

### Identify drift, name the root cause

For every deviation, classify:

- **Missing token**: the value should exist in the spec/system but doesn't. Fix: add the token upstream (in `design_specs` or `/admin/design`), don't hardcode.
- **One-off implementation**: a shared component already exists but wasn't used. Fix: swap to the shared version.
- **Conceptual misalignment**: the page's flow / IA / hierarchy doesn't match neighboring pages. Fix: rework the flow.

Fixing the symptom without naming the cause is how drift compounds.

**Ambiguous about a system principle? Ask Chris. Don't guess.**

## Pre-Polish Assessment

1. **Is it functionally complete?** If not, stop. Polish is the last step, not the first.
2. **Quality bar**: Moonraker client pages always ship at flagship quality. Therapists are paying for distinctive design; "good enough" doesn't apply here. Internal admin pages can ship at MVP quality if there's a deadline, but the consistency bar across the admin still applies.
3. **Experience first**: walk the path from the actual user (the prospective client browsing at 11pm, or Karen reviewing in the morning) before opening DevTools.
4. **Triage cosmetic vs functional**: functional issues ship first if time is tight; cosmetic ones can land in a follow-up. Quality must be even — never perfect one section while leaving another rough.

## Polish Systematically

### Visual Alignment & Spacing

- Pixel-perfect alignment to grid.
- All spacing from token scale (no random 13px gaps).
- Optical alignment for icons (visual centering, not mathematical).
- Spacing/alignment holds at 380px, 768px, 1440px.
- Baseline grid adherence on long-form copy (blog posts especially).

### Information Architecture & Flow

The page's *shape* must match the rest of the client's site (and Moonraker conventions) — not just the surface.

- **Progressive disclosure**: a homepage with 12 sections is drift if neighboring pages reveal 3-4 at a time. Use FAQ accordions, "read more" on bios, etc.
- **Established flows**: book-a-call goes to msg.moonraker.ai (always link, never embed). Don't invent a different booking flow on a different page.
- **Hierarchy**: primary CTA on every client page is "book consultation" — visual weight reflects that across all pages.
- **Empty / loading / arrival**: how content arrives matches how it does on neighboring pages. Pagemaster blog posts shouldn't fade in if the homepage doesn't.
- **Naming and mental model**: "free consultation" stays "free consultation" everywhere. Not "intro session" on one page and "first appointment" on another.

### Typography Refinement

- Hierarchy consistent: same elements, same size + weight throughout.
- Line length 45-75 characters for body text (especially blog posts).
- Line height appropriate for size.
- No widows or orphans on important headings.
- Headlines in Outfit 700/600, body in Inter 400/500/600 — verify nothing has drifted to system fonts.
- Font loading: `font-display: swap`, no FOIT, no big layout shift on font swap.

### Color & Contrast

- All colors from tokens. No hex literals on client pages — the contrast clamp pipeline only enforces this if values pass through `design_specs`.
- Same color means same thing throughout (brand color = primary action; never accent text).
- Focus indicators: visible, sufficient contrast.
- No pure `#000` / `#fff`. Tinted neutrals only (chroma 0.01+).
- No gray text on colored backgrounds. Use a shade of the background color or transparency.
- Re-verify with the detector at `/api/design-audit` — anything `category: contrast` is a hard fix.

### Interaction States

Every interactive element needs all states:

- Default, hover, focus, active, disabled, loading, error, success.
- Inline `onclick` handlers (Moonraker pattern) still need keyboard equivalents — keydown for Enter/Space.
- Dropdowns and links inside clickable rows: `onclick="event.stopPropagation()"` to avoid bubbling.

### Micro-interactions & Transitions

- All state changes 150-300ms.
- Easing: ease-out-quart/quint/expo. Never bounce or elastic.
- 60fps: only `transform` and `opacity`.
- Theme toggle uses `document.startViewTransition()` (0.25s).
- Respects `prefers-reduced-motion`.

### Content & Copy

This is where Moonraker pages most often need polish.

- **No em-dashes**. Anywhere. Replace with commas, periods, colons, or restructure. This is non-negotiable per coding conventions.
- **Voice**: warm, plain English, therapist-audience appropriate. Cross-check against `design_specs.voice_dna`.
- **Consistent terminology**: "free consultation" stays "free consultation." "Session" stays "session." Pick one term per concept, lock it in.
- **Capitalization**: Title Case vs sentence case applied consistently per surface (admin uses sentence case; client pages typically Title Case for headlines).
- **No typos**.
- **Length**: not too wordy, not so terse it's cold. Therapist bios should feel like a conversation, not a CV.
- **Punctuation**: periods on full sentences, no periods on labels (unless every label has them).

### Icons & Images

- Icons from a single family (consistent stroke width, fill style).
- Sized consistently per context.
- Optical alignment with adjacent text.
- All images have descriptive alt text — for therapy pages, especially photos of the therapist.
- No layout shift on image load: explicit `width`/`height` or `aspect-ratio`.
- Retina assets where the photographer provided them.

### Forms & Inputs

- All inputs labeled. Placeholders are not labels.
- Required indicators clear and consistent.
- Error messages helpful (read `/clarify` if any feel generic).
- Tab order logical.
- Validation timing consistent (we typically validate on blur).

### Edge Cases & Error States

This is where therapist pages break in production. Specific cases to test:

- **Long therapist names**: "Dr. Anna-Marie Goldsmith-Petersen, LMFT, EMDR-Certified" — does the H1 wrap cleanly?
- **Long bios**: 800+ words. Does it stay readable, or become a wall?
- **Single testimonial / no testimonials**: does the section gracefully disappear, or leave a sad empty area?
- **No services listed yet** (early lifecycle): Pagemaster placeholder behavior.
- **Image not uploaded**: fallback or skeleton, never a broken image icon.

### Responsiveness

- 380px (mobile), 768px (tablet), 1440px (desktop) all clean.
- Touch targets 44×44px minimum.
- Body text never below 14px on mobile.
- No horizontal scroll.
- Reflow logical (don't squish, restructure).

### Performance

- Critical path optimized.
- No layout shift on load (CLS < 0.1).
- Images appropriately sized and lazy-loaded.
- Inline scripts that touch a defer-loaded helper use `ready()`-guard from `docs/client-page-helper-protocol.md`. **CI lint enforces this** — `scripts/lint-client-page-helpers.js`.

### Code Quality

- No `console.log` in production.
- No commented-out code blocks.
- No unused imports or dead helpers.
- Sanitizer at source: `sanitizer.sanitizeText(value, maxLen)` when first read from DB / input, not at every interpolation.
- 5xx responses: generic user-facing string; detail to `monitor.logError`.

## Polish Checklist

Run this top to bottom before declaring done:

- [ ] Aligned to design system; drift named and resolved by root cause.
- [ ] IA and flow shape match neighboring pages.
- [ ] Visual alignment perfect at 380px, 768px, 1440px.
- [ ] Spacing uses tokens consistently.
- [ ] Typography hierarchy consistent; Outfit + Inter, no drift to system fonts.
- [ ] All interactive states implemented.
- [ ] Transitions smooth, 60fps, ease-out only.
- [ ] Copy clean. No em-dashes. Consistent terminology. On-voice.
- [ ] Icons consistent and aligned.
- [ ] All images have alt text and explicit dimensions.
- [ ] Forms properly labeled and validated.
- [ ] Error states helpful.
- [ ] Loading states clear.
- [ ] Empty states welcoming.
- [ ] Touch targets ≥ 44px.
- [ ] Contrast ≥ WCAG AA (verified via `/api/design-audit`).
- [ ] Keyboard navigation works end-to-end.
- [ ] Focus indicators visible.
- [ ] No console errors or warnings.
- [ ] No layout shift on load.
- [ ] Respects `prefers-reduced-motion`.
- [ ] `ready()`-guard pattern on any inline script touching defer-loaded helpers (lint passes).
- [ ] Code clean: no TODOs, console.logs, dead code.

## Audit-Validate Loop

Polish work isn't done until the audit comes back clean.

1. After applying polish, render the page via `/api/render-page-preview`.
2. POST the rendered URL to `/api/design-audit` at viewport 1440 and again at 380.
3. Read `summary.by_severity`. **If `absolute > 0` or `strong > 0` you are not done** — go back to the relevant section above and fix.
4. `advisory > 0` is acceptable only with explicit justification noted in the polish summary.
5. Re-run `/audit` for the score; aim for 18-20.

## Final Verification

Before marking done:

- **Use it yourself**: actually click through the page on a phone.
- **Test on a real device**, not just DevTools' device emulator.
- **Show Karen or Scott**: fresh eyes catch things.
- **Compare to design spec**: does it match the brand voice and palette captured during onboarding?
- **All states**: not just the happy path.

## Clean Up

- Replace any custom one-offs with the shared component if the design system has one.
- Delete unused styles, helpers, scratch files (especially anything in `_audit-staging/`).
- Consolidate any new tokens — if you introduced a new value, it probably belongs in `design_specs` or `/admin/design`.
- Verify DRY-ness: anything duplicated during polish gets pulled out.

**NEVER**:

- Polish before functional completeness.
- Polish without aligning to the design system.
- Guess at design system principles. Ask Chris.
- Spend hours on polish when ship is in 30 min (triage).
- Introduce bugs while polishing (test).
- Ignore systematic issues (fix the system, not just one screen).
- Perfect one section while leaving another rough.
- Hard-code values that should be tokens.
- Introduce new patterns or flows that diverge from established ones.
- Use em-dashes. Ever.

Remember: polish until it feels effortless, looks intentional, works flawlessly. The therapist client will see this page once before it goes live. That first impression sets their trust in everything we ship after.
