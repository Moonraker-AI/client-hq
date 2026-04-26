---
description: UX design review of a Moonraker client page. Two-assessment process: LLM design review + deterministic detector. Produces Nielsen-10 scores, persona red flags, and prioritized recommendations.
---

Run the critique workflow defined in `.claude/skills/impeccable/reference/critique.md` against the target the user specified ($ARGUMENTS).

Resolve the target the same way `/audit` does (file path, slug+page, or URL). Then run both assessments — LLM review and the deterministic detector via `/api/design-audit` — keeping them isolated.

Synthesize into the combined report from `critique.md`: design health score, anti-patterns verdict, what's working, priority issues, persona red flags (Anna's Anxious Prospect, Returning Searcher, Karen, Chris under time pressure), minor observations, provocative questions.

Then ask the user 2-4 targeted follow-up questions before recommending commands.
