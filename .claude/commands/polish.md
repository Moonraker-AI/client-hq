---
description: Final polish pass on a Moonraker page before client review. Design system alignment, IA, typography, color, interaction states, copy, edge cases. Includes the audit-validate loop — work isn't done until the detector comes back clean.
---

Run the polish workflow defined in `.claude/skills/impeccable/reference/polish.md` against the target the user specified ($ARGUMENTS).

Start with design system discovery. For client-facing pages, fetch `design_specs` for the client. For admin UI, fetch `/admin/design`. Name every drift by root cause (missing token, one-off implementation, conceptual misalignment) before fixing.

Work through the polish dimensions methodically. Run the polish checklist top to bottom.

Then run the audit-validate loop: render the page via `/api/render-page-preview`, POST the URL to `/api/design-audit` at viewports 1440 and 380, and do not declare done until `summary.by_severity.absolute === 0` and `summary.by_severity.strong === 0`. Advisory findings are acceptable only with explicit justification.
