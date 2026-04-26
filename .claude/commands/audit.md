---
description: Run the impeccable audit on a Moonraker page or component. Technical quality scan across accessibility, performance, theming, responsive design, and anti-patterns. Documents issues, doesn't fix them.
---

Run the audit workflow defined in `.claude/skills/impeccable/reference/audit.md` against the target the user specified ($ARGUMENTS).

Resolve the target before scanning:

- A file path means audit source (read the file, no detector).
- A client slug + page name means audit the rendered preview at `/api/render-page-preview?slug=<slug>&page=<page>`.
- A bare URL means audit that URL directly.
- No argument: ask which page, which client.

Once resolved, follow the procedure in `audit.md`: detector first via `/api/design-audit`, then the 5-dimension scan, then the report.

After the report, recommend specific commands (`/critique`, `/clarify`, `/harden`, `/polish`) for the issues found. End with `/polish` if any fixes are recommended.
