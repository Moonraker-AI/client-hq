---
description: Strengthen a Moonraker page against edge cases — long therapist names, empty testimonials, missing photos, slow networks, keyboard-only navigation. Production-reality hardening, not demo-perfect.
---

Run the harden workflow defined in `.claude/skills/impeccable/reference/harden.md` against the target the user specified ($ARGUMENTS).

Identify weaknesses by mentally substituting extreme values (long names, empty lists, missing images, very long bios) for every component on the page. Then apply the hardening dimensions: text overflow, image handling, empty states, responsive resilience, accessibility resilience, form hardening, performance.

After changes, verify with the detector at `viewport_width: 380` looking specifically for `overflow_horizontal`, `touch_target`, `contrast`, and `text_overflow` regressions.
