# Impeccable integration

Status: Step 1 + Step 2 complete (2026-04-26). Steps 3-5 deferred.

## What this is

[`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) is a vendored
design skill that gives Claude opinionated, anti-pattern-aware guidance for
producing distinctive frontend output. We use it for two surfaces:

1. **Internal admin + public Moonraker site** — design work in this repo
   should consult the skill via Claude Code.
2. **Pagemaster client templates** — the skill's anti-patterns are baked
   into the Pagemaster generation prompt so every client page benefits
   without per-render tool calls.

Upstream is Apache 2.0 and itself builds on Anthropic's `frontend-design`
skill. See `.claude/skills/impeccable/NOTICE.md` for attribution.

## What was added

### `.claude/skills/impeccable/`

- `SKILL.md` — Moonraker-flavored entry point. Drops upstream's
  `PRODUCT.md` / `DESIGN.md` / `load-context.mjs` machinery. Uses our
  Supabase `design_specs` table as the per-client design context source.
  Overrides upstream's reflex-font reject list for Moonraker brand fonts
  (Outfit + Inter) on internal surfaces. Per-client font selections in
  `design_specs` take precedence over the reflex list on Pagemaster
  templates.
- `reference/*.md` — 7 reference files copied unchanged from upstream:
  typography, color-and-contrast, spatial-design, motion-design,
  interaction-design, responsive-design, ux-writing.
- `NOTICE.md` — license attribution.

### `api/_lib/design-bans.js`

Single source of truth for prompt-time design guidance. Exports
`MOONRAKER_DESIGN_BANS`, a string block that gets appended to system
prompts in HTML-generating routes. Contains:

- **Absolute bans**: side-stripe colored borders >1px, gradient text via
  `background-clip: text`.
- **Strong bans**: pure `#000`/`#fff`, gray-on-color, glassmorphism,
  decorative sparklines, nested cards, identical card grids, hero-metric
  template, AI-default color palettes, bounce/elastic easing.
- **Required practices**: OKLCH, tinted neutrals, 4pt scale, gap not
  margin, 65-75ch line length, light-on-dark line-height adjustment,
  `:focus-visible`, transform/opacity-only animation, motion duration
  ladder, `prefers-reduced-motion`.
- **Button copy rules**: no "OK"/"Submit"/"Yes"/"Click here", verb +
  object always.
- **The AI slop test**: final self-check.

### `api/generate-content-page.js`

Two-line patch: require `./_lib/design-bans`, append
`MOONRAKER_DESIGN_BANS` at the end of `buildSystemPrompt` so it is the
last context Claude sees before generating. Applies to both Wix
(explicit-styles) and hybrid-styling branches.

`api/analyze-design-spec.js` was deliberately NOT patched — that route
analyzes a client's existing site to extract their design DNA. It should
report what is there, not what we wish were there.

## What is deferred

### Step 3: render-time design checker
Port the upstream `npx impeccable detect` regex rules into
`api/_lib/design-checker.js`, run after `render-page-preview.js` produces
HTML, surface findings in the admin preview UI as a non-blocking warning
panel. Targets the absolute bans + 5-10 strong bans.

### Step 4: apply impeccable to the homepage template
Audit `_templates/page-types/homepage.html` against the skill, then
patch:
- swap any side-stripe borders to background tints / full borders / no
  indicator;
- replace any pure `#000`/`#fff` with tinted variants;
- ensure all interactive elements have `:focus-visible`;
- verify the eight interactive states on every button;
- align motion durations to the 100/300/500 ladder.

### Step 5: Claude Code workflow loop
Wire upstream's `/audit`, `/critique`, `/polish` slash commands into
`client-hq/.claude/commands/`, adapted to know about our file layout
(`_templates/`, `/admin/design`, `design_specs`).

## How to use it now

**For new design work in Claude Code**: the skill auto-loads when working
in this repo. Reference the relevant `reference/*.md` file when the
topic comes up.

**For Pagemaster generation**: nothing to do. Every call to
`/api/generate-content-page` now includes the bans automatically.

**For audits and critiques**: still manual. Read the relevant reference
file, audit the surface, report findings.

## Override hierarchy

When rules conflict, this is the precedence order:

1. Per-client `design_specs` — for Pagemaster client templates only.
   Client-specific fonts, colors, voice DNA always win.
2. Moonraker brand decisions — Outfit + Inter + #00D47E for internal
   surfaces. Always wins over the upstream reflex-font list and
   reflex-color cautions.
3. Upstream impeccable rules — apply when 1 and 2 don't speak.
4. Upstream "always apply" principles — apply unconditionally
   (OKLCH, tinted neutrals, 4pt scale, etc.).
5. Upstream **absolute bans** — apply unconditionally and override
   everything else. No client-specific design spec authorizes
   side-stripe borders or gradient text.

## When to update

- When upstream `pbakaus/impeccable` ships a new reference file or
  meaningfully revises an existing one, refresh `reference/`.
- When we discover a new Moonraker-specific anti-pattern in client
  output, add it to `MOONRAKER_DESIGN_BANS`.
- When we onboard a new internal surface (e.g. a new admin page type),
  audit it against the skill before shipping.
