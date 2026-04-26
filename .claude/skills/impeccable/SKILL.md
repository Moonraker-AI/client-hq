---
name: impeccable
description: "Design and iterate production-grade frontend interfaces. Use when building, critiquing, polishing, auditing, or refactoring any UI surface in client-hq, the public Moonraker website, or Pagemaster client templates. Covers typography, color, spacing, motion, interaction, responsive behavior, and UX writing. Vendored from pbakaus/impeccable, adapted for Moonraker."
license: "Apache 2.0. Based on pbakaus/impeccable, which builds on Anthropic's frontend-design skill. See NOTICE.md for attribution."
---

# Impeccable for Moonraker

Distinctive, production-grade frontend output. Avoid generic AI aesthetics.

## Moonraker-specific overrides

These supersede the upstream rules. The upstream skill is opinionated about avoiding "default" choices; we have brand decisions that override that.

**Internal surfaces (clients.moonraker.ai admin, public moonraker.ai):**
- **Outfit headings (700/600), Inter body (400/500/600).** Outfit is on the upstream "reflex font" reject list. We override. Brand consistency wins.
- **Primary green: #00D47E.** Stable across light and dark modes.
- **Card radius 14px, row radius 8px, button radius 6-8px.**
- **Theme via `localStorage moonraker-theme`** read before first paint.
- Live design tokens reference: `https://clients.moonraker.ai/admin/design/`. Fetch this before modifying any internal surface.

**Pagemaster client templates (`_templates/page-types/*.html`):**
- Per-client `design_specs` table is the source of truth. It plays the role the upstream skill assigns to `PRODUCT.md` + `DESIGN.md`.
- When `design_specs.typography.heading_font` / `body_font` is set for a client, use those. The upstream reflex-font reject list applies ONLY when no client-specific font has been chosen.
- When `design_specs.color_palette` is set for a client, use those colors. Apply OKLCH conversion + tinted neutrals (see color reference) on top.
- `design_specs.voice_dna` overrides upstream UX-writing tone defaults. Therapy clients are warm + non-clinical; do not adopt corporate-app voice.

## Required context before designing

For internal surfaces: read `https://clients.moonraker.ai/admin/design/` for the live token reference.

For client templates: load the client's `design_specs` row from Supabase. The fields are documented in `docs/phase-4-design.md`.

For brand voice on therapist-facing copy: warm, plain English. No emdashes (use commas, periods, colons, or restructure). No corporate jargon.

## Aesthetic direction

Commit to a clear conceptual direction and execute with precision. Bold maximalism and refined minimalism both work; the failure mode is timid middle ground.

For Moonraker internal: refined, calm, professional, with #00D47E as a controlled accent (10% of visual weight, not 30%).

For therapy practice client sites: warm, approachable, non-clinical. Avoid the "wellness app aesthetic" (sage green + cream + Cormorant Garamond — that is itself a generic AI default). Each client's `design_specs` is meant to produce a distinct site.

## Reference files

The deep material lives in `reference/`. Consult them when the topic comes up:

- [typography](reference/typography.md) — modular scales, font pairing, OpenType, web font loading
- [color-and-contrast](reference/color-and-contrast.md) — OKLCH, tinted neutrals, dark mode, accessibility
- [spatial-design](reference/spatial-design.md) — 4pt scale, container queries, hierarchy, optical adjustments
- [motion-design](reference/motion-design.md) — 100/300/500 durations, exponential easing, perceived performance
- [interaction-design](reference/interaction-design.md) — eight states, focus rings, popover/anchor positioning, undo > confirm
- [responsive-design](reference/responsive-design.md) — mobile-first, pointer/hover queries, safe areas, srcset
- [ux-writing](reference/ux-writing.md) — button labels, error formula, empty states, terminology consistency

## Always-apply principles (do not consult, just do)

These come from upstream and apply without exception unless a Moonraker override above contradicts.

**Typography:**
- Modular scale, fluid clamp on marketing/content pages, fixed rem on dashboards.
- Cap line length at 65-75ch on body text.
- Line-height +0.05-0.1 when light text on dark background.
- Fewer sizes with more contrast (1.25 ratio minimum between steps).

**Color:**
- OKLCH not HSL. Reduce chroma as lightness approaches 0 or 100.
- Tint neutrals 0.005-0.015 toward the project's brand hue. Pure gray is dead.
- 60-30-10 by visual weight, not pixel count. Accents work because they're rare.
- Never pure `#000` or `#fff`.

**Layout:**
- 4pt scale: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- `gap` for sibling spacing, not margin.
- `repeat(auto-fit, minmax(280px, 1fr))` for breakpoint-free responsive grids.
- Container queries for components, viewport queries for page layout.

**Motion:**
- 100-150ms for instant feedback, 200-300ms for state changes, 300-500ms for layout, 500-800ms for entrance.
- Exit duration ~75% of enter.
- Animate transform and opacity only. For height, use `grid-template-rows: 0fr → 1fr`.
- Exponential easing curves, not `ease`. Never bounce or elastic.
- `prefers-reduced-motion` is not optional.

**Interaction:**
- Every interactive element has all eight states: default, hover, focus, active, disabled, loading, error, success.
- `:focus-visible` for keyboard rings, never bare `outline: none`.
- Skeleton screens, not generic spinners.
- Undo toast, not confirmation dialog (except for truly irreversible actions).

**Responsive:**
- Mobile-first. `min-width` queries, never `max-width` first.
- Use `(pointer: fine)` / `(pointer: coarse)` and `(hover: hover)` / `(hover: none)` — screen size doesn't tell you input method.
- `viewport-fit=cover` + `env(safe-area-inset-*)` for notched devices.

**UX writing:**
- No "OK" / "Submit" / "Yes/No" — use verb + object ("Save changes", "Delete project").
- Errors answer: what + why + fix. Don't blame the user.
- Empty states: acknowledge + value + action.
- Pick one term and stick with it (Delete OR Remove, not both).

## Absolute bans (match-and-refuse)

If you find yourself about to write any of these, stop and rewrite with a different structure entirely. These are hard rules — no exceptions in any Moonraker surface.

**BAN 1: Side-stripe borders on cards/list items/callouts/alerts.**
- Pattern: `border-left:` or `border-right:` with width > 1px, regardless of color (hex, var, oklch).
- Why: the most overused "design touch" in admin and dashboard UIs. Never looks intentional.
- Rewrite: full borders, background tints, leading icons/numbers, or no visual indicator.

**BAN 2: Gradient text via `background-clip: text`.**
- Pattern: `background-clip: text` (or `-webkit-background-clip: text`) with a `linear-gradient` / `radial-gradient` / `conic-gradient` background.
- Why: top-three AI design tell. Decorative without meaning.
- Rewrite: solid color. For emphasis use weight or size.

## Strong bans (use only with explicit reason)

- Pure `#000` / `#fff`. Always tint.
- Gray text on colored backgrounds. Use a shade of the background instead.
- Glassmorphism / glass cards / decorative blur.
- Sparklines as decoration. Tiny charts that look sophisticated but say nothing.
- Generic rounded rectangle + drop shadow. Forgettable.
- Cards inside cards. Flatten the hierarchy.
- Identical card grid (same-sized cards, icon + heading + text, repeated).
- Hero metric template (big number, small label, supporting stats, gradient accent).
- Modals when undo + toast would work.
- Dark mode by default with neon accents "to look cool." Light mode by default "to be safe." Both are reflex defaults.
- Cyan-on-dark, purple-to-blue gradients.

## The AI slop test

Show the interface to someone and say "AI made this." Would they believe you instantly? If yes, that's the problem. A distinctive interface makes someone ask "how was this made?" — not "which AI made this?"

The DON'Ts above are the fingerprints of AI-generated work from 2024-2025. Rewriting to avoid them is the work.

## When invoked with no further direction

Default behavior: read the relevant reference file(s) for the surface in question, audit the surface against the always-apply principles and bans, and report findings. Don't make changes without confirmation unless the user explicitly asked you to fix things.

---

## Notes on this vendoring

This is `pbakaus/impeccable` adapted for Moonraker. The reference files in `reference/` are unmodified from upstream. The SKILL.md is rewritten to drop upstream's `PRODUCT.md` / `DESIGN.md` / `load-context.mjs` machinery (we use Supabase `design_specs` instead) and to override the reflex-font reject list for our brand fonts.

Upstream commands like `/audit`, `/critique`, `/polish` are not yet wired into this vendoring. To be added in a follow-up step.

See `docs/impeccable-integration.md` for the integration plan and what's deferred.
