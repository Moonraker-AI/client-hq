Strengthen Moonraker pages against edge cases, errors, and real-world data scenarios that break idealized designs. Run after `/audit` and `/critique`, before `/polish`.

## What "real-world" means for Moonraker

Most pages we ship are filled by Pagemaster from `design_specs` and `content_pages`. Real-world data means:

- Therapist names with hyphens, accents, multiple credentials, suffix punctuation.
- Bios that range from 80 words ("I help people feel better") to 1,800 words.
- Service lists with one item, fifteen items, or none yet.
- Testimonials with zero, one, or thirty entries; some long, some short, some with no attribution.
- Photos that are missing, low-resolution, square, portrait, or landscape.
- Google reviews that haven't pulled yet, returning empty.
- Brand colors that distill to near-pastels or near-neutrals.
- Voice DNA that distills empty for sparse source sites.

Designs that only work for the demo case will silently break on half the client base.

## Assess Hardening Needs

Before changing anything, identify weaknesses systematically.

### 1. Test with extreme inputs

For each component on the page, mentally substitute:

- Therapist name: 4 chars (`Anna`) and 80 chars (`Dr. Anna-Marie Goldsmith-Petersen, LMFT, EMDR-Certified, AAMFT-S`).
- Headline: 15 chars and 150 chars.
- Bio paragraph: empty, 30 words, 800 words.
- Service list: 0 items, 1 item, 12 items.
- Testimonials: 0, 1, 1 with no name, 30.
- Image: missing entirely; very wide; very tall; low-res.
- Phone number: 7 digits, 10 digits, 14 digits with country code.

For each, predict what breaks. Then verify by editing the rendered preview or temporarily swapping data via `/api/admin/design-spec` (read-only check first, never write to a live client).

### 2. Test error scenarios

- Network failures: page loaded with no internet (PWA-like graceful messaging? probably overkill for static pages, but check).
- Image fails to load: alt text shown, layout doesn't break.
- Booking link target down (msg.moonraker.ai outage): page doesn't break, but the user experience is just a dead button — that's acceptable; not our responsibility to fix here.
- Pagemaster pipeline partial: `capture_status: 'partial'`, some `capture_errors[]` entries — does the page degrade gracefully or look obviously broken?
- Theme switch mid-render: any flicker, FOUC, or layout shift.

### 3. Test browser / device variations

- Mobile Safari (most therapy prospects are on iPhone).
- Mobile Chrome on Android.
- Desktop Chrome, Firefox, Safari.
- Reduced motion preference enabled.
- Large font preference (browser zoom 200%).
- Dark mode at OS level (separate from our `moonraker-theme` toggle).

## Hardening Dimensions

### Text Overflow & Wrapping

The single most common Moonraker hardening miss is therapist names overflowing in the H1.

```css
/* Headlines that hold long names */
.therapist-name {
  word-wrap: break-word;
  overflow-wrap: break-word;
  hyphens: auto;
}

/* Card titles that may carry credentials */
.card-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Bio paragraphs that may run very long */
.therapist-bio {
  /* Either let it run, with proper line length: */
  max-width: 65ch;
  /* Or clamp with read-more affordance: */
  /* implemented via JS, see _templates/page-types/about.html */
}
```

Flex/grid items that hold long text need `min-width: 0` to allow shrinking below content size, otherwise they overflow their container.

### Bio length handling

Three viable patterns. Pick one per template; stay consistent across clients.

1. **Always full**: bio runs unclamped. Best for `about` page; needs `max-width: 65ch` so long bios stay readable.
2. **Clamp + read more**: homepage typically clamps to ~150 words with a "Read more about [Name]" link to the about page.
3. **Excerpt only**: card-style bio surfaces are 2-line clamped with the full version one click away.

Currently `_templates/page-types/homepage.html` uses pattern 2; verify the clamp count holds up when a therapist's first paragraph alone exceeds 150 words.

### Image handling

- Always set `width` + `height` (or `aspect-ratio`) to prevent CLS.
- Always set `alt` — for therapist photos, `alt="${therapist_name}"` is fine; for stock-style imagery, describe what's shown.
- Provide a fallback when the image is missing. Two options: hide the figure entirely (if optional), or show a tinted placeholder with the therapist's initials.
- If R2-deployed images: verify the image URL pattern still resolves after a re-render.

### Empty states

For every list-rendering surface, decide what happens with zero items.

- **Services**: if `content_pages.services` is empty, the section should hide entirely on homepage; on the services page it should show a "Services coming soon" placeholder rather than an empty container.
- **Testimonials**: hide the entire section. Don't show "No reviews yet" — that signals a problem.
- **Blog posts**: same as testimonials. Empty hub page is bad; hide the link until there's at least one post.
- **Google reviews**: if `google_reviews_pulled_at` is null or stale, hide the section. Re-trigger pull rather than show stale data.

### Responsive resilience

- Test at 320px (smallest realistic mobile width). Modern clients usually start at 375px, but iPhone SE 1st gen still appears in analytics.
- Test landscape on iPhone (height ~390px): is the hero CTA visible without scrolling, or does the page feel broken?
- Test with system font scaling (iOS Settings → Display → Larger Text): does the hero still fit?

### Internationalization

Not currently relevant — all Moonraker clients are English-speaking US/Canada — but build with logical properties (`margin-inline-start` not `margin-left`) so we're not painted into a corner if a French-Canadian therapist signs on.

### Accessibility resilience

- All functionality reachable by keyboard.
- Modals (intake forms, booking embeds when we use them) trap focus and return focus on close.
- ARIA live regions for any dynamic content (form validation, loading states).
- Reduced motion: theme toggle's `startViewTransition` should be skipped (we already do this; verify after any motion change).

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Form & input hardening

For any embedded contact form (some clients have them in addition to the booking link):

- All inputs labeled (placeholders are not labels).
- Submit button disabled while in flight; re-enabled on response.
- Network failure shows "We couldn't send that — please try again or email [therapist email]" with the email as a fallback.
- Validation timing on blur, errors inline, never modal.

### Performance resilience

- Slow 3G simulation: does the hero image arrive before the user gives up? Lazy-load below-fold; eager-load hero.
- Memory: long pages with many images should release off-screen images on mobile (browser handles automatically with `loading="lazy"`).
- No layout thrash: avoid reading `offsetWidth` then writing inline styles in a loop.

## Verify Hardening

Test with the actual edge cases:

- **Long names**: temporarily edit `design_specs.therapist_name` to a long string, re-render, verify; restore.
- **No testimonials**: render a page where `testimonials` is empty.
- **Missing image**: rename the photo file in R2 (or block the URL), reload.
- **Reduced motion**: toggle in OS settings, verify page still works.
- **Keyboard only**: tab through every interactive element; verify focus visible, order logical, no traps.
- **Mobile**: load on an actual iPhone (Safari on iOS handles things differently than DevTools mobile mode, especially around `100vh` and safe area insets).

## Verify with the detector

Hardening changes are most easily regressed by responsive issues. After changes:

```bash
curl -s -X POST https://clients.moonraker.ai/api/design-audit \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url":"<rendered-preview-url>","viewport_width":380,"viewport_height":800}' \
  | python3 -m json.tool
```

Look specifically for:

- `category: overflow_horizontal`
- `category: touch_target` (anything < 44px)
- `category: contrast` (regressions on hover states)
- `category: text_overflow`

**NEVER**:

- Assume perfect data. Validate everything.
- Leave error messages generic ("Error occurred").
- Trust client-side validation alone (server-side always validates).
- Use fixed widths on text containers.
- Ignore the keyboard-only path.
- Block the entire page when one component errors. Isolate failures.

Remember: hardening is for production reality, not demo perfection. Real therapists have long names, short bios, missing photos, and visitors on flaky connections at 11pm.
