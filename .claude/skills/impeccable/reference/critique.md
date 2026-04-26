UX design review of a Moonraker client page. Audit covers technical quality (accessibility, performance, theming, responsive, anti-patterns); critique covers the harder, more subjective dimensions: hierarchy, clarity, emotional resonance, persona-fit. Run audit first if you haven't.

> **Additional context needed before starting**: which client is this for, and which page (homepage, services, about, blog post)? The persona and emotional context shift dramatically between, say, a therapist's homepage (anxious first-time visitor) and an admin dashboard (Chris under time pressure).

## Gather Assessments

Run two independent assessments. **Neither may see the other's output** — that isolation is what makes the combined verdict honest. Don't shortcut for speed.

If subagent spawning is available (Claude Code's `Agent` tool), delegate. Otherwise run sequentially in-head, but write Assessment A's findings to a scratch file before reading Assessment B's output.

### Assessment A: LLM Design Review

Read the source files (HTML template + any client-specific overrides + the rendered output via `/api/render-page-preview`). Then think like a design director who has reviewed a thousand therapy practice websites.

**AI Slop Detection (CRITICAL)**: Does this look like every other AI-generated page? Run the slop test from the parent skill: if shown to a stranger with the caption "AI made this," would they believe it instantly? Specifically check:

- The two **absolute bans**: indented colored vertical bars, gradient text via `background-clip: text`.
- All **strong bans** from the parent skill (loaded in this context).
- Generic-feeling hero sections with a big headline + subhead + button stack.
- Identical card grids ("Our Services" with three icon-heading-text cards).
- Stock-photo-feeling imagery where a real photo of the therapist would build more trust.

**Holistic Design Review**:

- **Visual hierarchy**: where does the eye go first? Is the primary action clear? On a therapist homepage the primary action is almost always "book a free consultation" — does the design support that, or compete with it?
- **Information architecture**: do sections flow in the order a worried prospective client would want? Typical good order: who I help → how I help → meet me → how to book.
- **Emotional resonance**: does it feel safe, warm, professional? Or clinical, generic, salesy?
- **Discoverability**: are the booking link, contact methods, and credentials all surfaced without hunting?
- **Composition**: balance, whitespace, rhythm.
- **Typography**: hierarchy reads at a glance, line lengths in the 45-75 char band, no walls of text.
- **Color**: purposeful use; the brand color earns its placement; nothing accidental.
- **States & edge cases**: what does this look like when the therapist's bio is 600 words? When they have one testimonial? When they have none?
- **Microcopy**: warm, plain-English. No em-dashes (commas/colons/restructure instead). No therapy jargon that scares newcomers (e.g., "psychodynamic intersubjective" without translation).

**Cognitive Load** (Moonraker-specific application):

- Visible options at the primary CTA: should be one. If there are four ways to "get in touch" stacked together, that is the problem, not the styling.
- Form length on the booking handoff: the link goes to msg.moonraker.ai, which we don't control here, but the page-level CTA shouldn't itself be a 6-field form.
- Information density: a therapist's prospect is often anxious and short on bandwidth. Progressive disclosure (FAQ accordions, "read more" on bio) beats a single 2,000-word page.

**Emotional Journey**:

- What feeling does the page evoke in the first three seconds? Should be calm, competent, "I could see myself talking to this person."
- **Peak-end rule**: does the page end on something warm (a personal note from the therapist, a quote, a clear "here's what happens next")? Or does it dribble out at a footer of legal text?
- **Anxiety spikes**: pricing pages, intake forms, cancellation policies. Are these handled with reassurance copy and clear next steps?

**Nielsen's 10 heuristics**: score each 0-4. Most pages score 24-32/40 honestly.

Write Assessment A to scratch with: AI slop verdict, heuristic scores, cognitive load assessment, what's working (2-3 items), priority issues (3-5 with what/why/fix), minor observations, provocative questions.

### Assessment B: Automated Detection

Run the deterministic detector via `/api/design-audit`:

```bash
curl -s -X POST https://clients.moonraker.ai/api/design-audit \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"<rendered-preview-url>","viewport_width":1440}' \
  | python3 -m json.tool
```

Then re-run with `viewport_width: 380` for mobile.

The detector runs the upstream impeccable JS detector via Playwright against the live URL. It's stateless. It returns `findings[]` (each with `severity`, `category`, `detail`, `selector`) and a `summary`.

Note false positives. Common ones: code samples in `<pre>` flagged as "low contrast," icon fonts flagged as "small text." Verify before reporting up.

If browser automation is available (Claude Code's browser tools), also load the rendered preview in a tab to verify the detector's selector hits visually.

## Generate Combined Critique Report

Synthesize. Don't concatenate. Note where LLM and detector agree, where the detector caught something the LLM missed, and where the detector is wrong.

### Design Health Score

Nielsen's 10 heuristics, scored 0-4:

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | ? | |
| 2 | Match System / Real World | ? | |
| 3 | User Control and Freedom | ? | |
| 4 | Consistency and Standards | ? | |
| 5 | Error Prevention | ? | |
| 6 | Recognition Rather Than Recall | ? | |
| 7 | Flexibility and Efficiency | ? | |
| 8 | Aesthetic and Minimalist Design | ? | |
| 9 | Error Recovery | ? | |
| 10 | Help and Documentation | ? | |
| **Total** | | **??/40** | **[Rating band]** |

Rating bands: 36-40 Excellent, 28-35 Good, 20-27 Acceptable, 12-19 Poor, 0-11 Critical.

Be honest. A 4 means genuinely excellent. Most real pages score 22-32.

### Anti-Patterns Verdict

**Start here.** Does this look AI-generated?

- **LLM assessment**: your read on slop tells, layout sameness, generic composition, missed personality.
- **Deterministic scan**: detector counts (`absolute: N, strong: N, advisory: N`), with the worst 3-5 findings called out by selector and category. Note false positives.
- **Mobile vs desktop**: differences worth flagging.

### Overall Impression

A brief gut reaction: what works, what doesn't, the single biggest opportunity.

### What's Working

2-3 specific things done well. Be specific about why they work.

### Priority Issues

The 3-5 most impactful problems, ordered by importance.

For each: **[P?] What** | **Why it matters** | **Fix** | **Suggested command** (`/polish`, `/clarify`, `/harden`, etc.).

### Persona Red Flags

For Moonraker client pages, default to these personas. Use the ones relevant to the page type.

**Anna's Anxious Prospect** (homepage, services, about, blog).
First-time therapy seeker. Browses on her phone in bed at 11pm. Anxious, skeptical of online therapy ads, wants to know "is this person real and would they get me?" Red flags:

- Stock-photo therapist (kills trust instantly).
- Booking CTA below the fold on mobile.
- Jargon in the H1 ("integrative attachment-informed psychodynamic therapy").
- No mention of fees, sliding scale, or insurance anywhere visible.
- Generic AI-feeling hero ("Find your best self").

**Returning Searcher** (services, blog).
Has tried therapy before, is comparing two or three therapists. Knows what they want. Red flags:

- Service pages that don't say what specific issues the therapist works with.
- Bio that's all credentials and no voice.
- No way to tell if this person takes their insurance / has weekend slots.

**Karen Doing Quality Review** (any client page, internal use).
Our CSM checking that the page is on-brand and ready to ship. Red flags:

- Em-dashes anywhere in the copy.
- Inconsistent voice between sections (warm in one, corporate in the next).
- Loose copy ("we believe in helping you grow" — what does that mean?).

**Chris Under Time Pressure** (admin pages only).
Founder, primary dev. Needs to find a thing fast and act on it. Red flags:

- Unclear hierarchy on dashboards.
- Required clicks to perform routine actions.
- Hidden states (a status that means "needs Chris" but isn't surfaced).

If `design_specs.brand_voice` exists for this client, layer in 1-2 client-specific personas based on their stated audience.

Be specific. Name the exact element or interaction that fails each persona.

### Minor Observations

Smaller issues worth fixing eventually.

### Questions to Consider

Provocative questions that might unlock better solutions: "What if the primary CTA were the only button above the fold?" "Does this need a hero section at all, or would the headline + photo suffice?"

## Ask the User

After presenting findings, ask 2-4 targeted questions based on what was actually found. Never generic.

1. **Priority direction**: based on issues found, which category matters most right now? Offer the top 2-3 issue categories.
2. **Design intent**: if there's a tonal mismatch, was it deliberate? Offer 2-3 directions.
3. **Scope**: address all N issues, or focus on the top 3?
4. **Constraints** (only if relevant): is anything off-limits?

If findings are simple (1-2 clear issues), skip questions and go straight to Recommended Actions.

## Recommended Actions

After the user answers, present a prioritized action summary.

1. **`/clarify`**: rewrite [specific copy] (specific context from critique)
2. **`/typeset`**: fix [specific typography issue]
3. **`/harden`**: cover edge cases for [specific component]
4. **`/polish`**: final pass

Order by user priorities first, then by impact. Each item should carry enough context that the command knows what to focus on. End with `/polish` if any fixes were recommended.

After presenting:

> You can run these one at a time, all at once, or in any order. Re-run `/critique` after fixes to verify the score.

**Rules**:

- Be direct. Vague feedback wastes time.
- Be specific. "The booking button," not "the CTA."
- Say what's wrong AND why it matters to the actual user (Anna's Anxious Prospect, not "the user").
- Give concrete suggestions, not "consider exploring..."
- Prioritize ruthlessly. If everything is important, nothing is.
- Don't soften. Therapists are paying us for honest design judgment.
