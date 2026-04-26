# NOTICE

This directory contains a vendored, adapted copy of `pbakaus/impeccable`:
https://github.com/pbakaus/impeccable

Licensed under Apache License, Version 2.0:
http://www.apache.org/licenses/LICENSE-2.0

`pbakaus/impeccable` itself builds on Anthropic's `frontend-design` skill:
https://github.com/anthropics/skills/tree/main/skills/frontend-design

## What was copied unchanged

The 7 reference files in `reference/`:
- typography.md
- color-and-contrast.md
- spatial-design.md
- motion-design.md
- interaction-design.md
- responsive-design.md
- ux-writing.md

## What was modified

`SKILL.md` is a Moonraker-specific rewrite. Upstream's `PRODUCT.md` /
`DESIGN.md` / `load-context.mjs` context-loading machinery was dropped in
favor of our existing Supabase `design_specs` infrastructure. The
upstream "reflex font" reject list is overridden for Moonraker's brand
fonts (Outfit + Inter) on internal surfaces. Per-client font overrides
on Pagemaster client templates take precedence over the reflex list.

## What was not copied

- The 18 slash commands (`/audit`, `/critique`, `/polish`, etc.) — deferred to a follow-up integration step.
- The standalone CLI detector (`npx impeccable detect`) — to be ported as `api/_lib/design-checker.js` in a follow-up.
- The build scripts (`load-context.mjs`, etc.) — not needed for our integration shape.

Vendored on 2026-04-26.
