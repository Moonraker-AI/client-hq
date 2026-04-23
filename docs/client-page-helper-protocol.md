# Client Page Helper Protocol

**Last updated:** April 23, 2026

## What this covers

Every client-facing HTML page in this repo (`_templates/*.html`, `agreement/index.html`, `entity-audit/index.html`) is static HTML with one or more inline `<script>` blocks running an IIFE. Those IIFEs sometimes call into helpers loaded from `/shared/*.js`. This doc is the canonical rule for how to wire those helpers so the page's first paint and first API call both succeed on a cold load. The rules are machine-enforced by `scripts/lint-client-page-helpers.js`, which runs on every PR.

## The helpers

| Helper | Global(s) | How it loads | Notes |
|---|---|---|---|
| `/shared/page-token.js` | `window.mrPageToken` | **synchronous (no `defer`)** | Mints the HttpOnly page-token cookie for write endpoints and page-token-gated reads. Scope-aware. |
| `/shared/csa-content.js` | `window.renderCSA`, `window.loadCSAPricing` | sync | Renders the CSA into the signing block. |
| `/shared/guarantee-content.js` | `window.buildGuaranteeHtml` | sync | Renders the Performance Guarantee document. |
| `/shared/offline-banner.js` | — (side effects) | `defer` | Shows a banner when navigator.onLine flips. |
| `/shared/*-chatbot.js` | varies | sync | Per-page chat widgets. |

## The trap (and why `page-token.js` must load sync)

Inline `<script>` blocks execute as soon as the parser reaches them. A `<script src="..." defer>` executes **after** the HTML is fully parsed, right before `DOMContentLoaded`. That means an inline script earlier in the body runs before a deferred external, even if the deferred `<script>` tag appears above it in the source.

`page-token.js` does two things on load:

1. Installs `window.mrPageToken` with `.ready()`, `.refresh()`, `.fetch()`.
2. Kicks off `POST /api/page-token/request` immediately to mint the `mr_pt_<scope>` HttpOnly cookie.

If the script is deferred, neither has happened when inline init code runs. The inline code then fires its first API call **without** a valid cookie:

- No prior cookie in the browser → `401` (page-token missing).
- Stale cookie from a visit to a **different** client (cookies are Path=/) → `403` (slug does not match contact_id bound to the cookie).

A hard refresh makes it work because by the second page load the deferred script has executed on a prior tick and the cookie is fresh. This is exactly the bug we shipped on 2026-04-22 and the second variant on 2026-04-23.

**Fix: load `page-token.js` synchronously** — no `defer`, no `async`. The file is ~110 lines of pure JS with no DOM dependencies, so the cost is a single ~1 RTT script fetch on first load (cached on every subsequent load).

## The canonical pattern

```html
<script>window.__MR_PAGE_SCOPE__ = 'onboarding';</script>
<script src="/shared/page-token.js"></script>
```

Then, anywhere downstream — at page init or in a click handler — you can rely on `window.mrPageToken` already being installed and the mint POST already in flight:

```js
window.mrPageToken.ready()
  .catch(function() { /* surface as HTTP error below if mint failed */ })
  .then(function() {
    return fetch('/api/whatever', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  })
  .then(function(r) { ... });
```

What each piece does:

- **`window.mrPageToken.ready()`** returns a promise that resolves once the `mr_pt_<scope>` cookie has been set on the response to the mint POST. Awaiting it guarantees the cookie is in place for the next request.
- **`.catch()` on the mint** — if the mint itself fails (server 500, rate limited, network), don't crash the chain. The next fetch will still go out; it'll just 401 and the page can render an error.
- **Native `fetch` with `credentials: 'same-origin'`** — sends the `mr_pt_<scope>` cookie automatically. Do NOT use `window.mrPageToken.fetch(...)`; that wrapper does a one-shot 401-retry that can mask genuine auth regressions.

## Required on every template that uses page-token

Declare the scope before the helper loads. Without the scope, `.ready()` silently rejects and every subsequent call no-ops.

```html
<script>window.__MR_PAGE_SCOPE__ = 'onboarding';</script>
<script src="/shared/page-token.js"></script>
```

Valid scopes live in `api/_lib/page-token.js` under `SCOPES` — see that file for the current list.

## Lint rules

`scripts/lint-client-page-helpers.js` enforces three rules on every PR:

| Rule | Violates | Fix |
|---|---|---|
| R1 | Any active-code `mrPageToken.fetch(` | Use native `fetch` with `credentials: 'same-origin'` after `window.mrPageToken.ready()`. |
| R3 | `page-token.js` loaded OR `mrPageToken` used but no `window.__MR_PAGE_SCOPE__` declared | Add `<script>window.__MR_PAGE_SCOPE__ = '<scope>';</script>` above the `<script src=".../page-token.js">` tag. |
| R4 | `page-token.js` loaded with `defer` or `async` | Remove the attribute. This helper must install synchronously. |

R2 (required ternary guard) was retired in v2 — the synchronous load removes the cold-load race that made the guard necessary.

Comments (both `//` and `/* */`) are stripped before matching, so historical notes about deprecated patterns are safe to leave in place.

## Running the lint locally

```bash
node scripts/lint-client-page-helpers.js
```

Zero output + exit 0 = clean. Any violation prints `file:line [rule] message` and exits 1.

No dependencies, no build step. Just Node.

## History

- **2026-04-22 (v1)** — onboarding page stuck on "Loading…" for Brave mobile incognito users. Root cause: `mrPageToken.fetch()` called in a `.then` after the ready() guard; wrapper needs `mrPageToken` to be defined, which it wasn't on cold load. Fixed by switching to native `fetch` with `credentials: 'same-origin'`. Commits `592c9649` (partial), `7ac83d1e` (complete). Protocol v1 and the ternary ready()-guard were introduced here.
- **2026-04-23 (v2)** — onboarding page returned 401/403 on every first visit, worked on hard refresh. Root cause: the v1 ternary guard allowed the fetch to short-circuit to `Promise.resolve()` when `window.mrPageToken` hadn't loaded yet (defer timing), so the read fired without a valid cookie. Vercel logs confirmed ~20% of `/api/public-onboarding-data` requests returned 403. Fixed by loading `page-token.js` synchronously so `window.mrPageToken` and its in-flight mint are both installed before any inline script runs. Lint R2 retired, R4 inverted. Ternary guard replaced with a direct `window.mrPageToken.ready()` call.
