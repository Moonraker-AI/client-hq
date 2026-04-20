// /shared/page-token.js
// Client helper for the HttpOnly page-token cookie (C6 clean cutover).
//
// Deployed client pages no longer bake tokens into HTML. Instead, each page
// declares its scope (see data-page-scope attribute OR window.__MR_PAGE_SCOPE__)
// and this helper asks /api/page-token/request to mint a scoped HttpOnly cookie
// on the client's path prefix.
//
// Usage (from any page template):
//   <script>window.__MR_PAGE_SCOPE__ = 'onboarding';</script>
//   <script src="/shared/page-token.js" defer></script>
//
// Then, before any write fetch:
//   await window.mrPageToken.ready();
//   fetch('/api/whatever', { method: 'POST', body: ..., credentials: 'same-origin' });
//
// The cookie is sent automatically on same-origin fetches. Write endpoints read
// it via pageToken.getTokenFromRequest(req, 'scope') on the server.
//
// Defense-in-depth: long-lived pages (onboarding can be open 90 days) may see
// the page-token cookie expire between renders and actions. Templates SHOULD
// route write fetches through window.mrPageToken.fetch(url, init), which is a
// drop-in wrapper around fetch() that:
//   1. Awaits the initial mint via .ready() before the first call.
//   2. On a 401 response, calls .refresh() exactly once to re-mint the cookie,
//      then retries the fetch exactly once.
//   3. A second 401 is returned to the caller unchanged (no infinite loop).

(function() {
  if (window.mrPageToken) return;

  function extractSlug() {
    // First path segment under clients.moonraker.ai is always the slug.
    var parts = (location.pathname || '').replace(/^\/+|\/+$/g, '').split('/');
    return parts[0] || '';
  }

  function requestCookie(scope) {
    var slug = extractSlug();
    if (!slug || !scope) return Promise.reject(new Error('missing slug or scope'));
    return fetch('/api/page-token/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ slug: slug, scope: scope })
    }).then(function(r) {
      if (!r.ok) return r.json().then(function(j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
      return true;
    });
  }

  var scope = window.__MR_PAGE_SCOPE__ || (document.documentElement && document.documentElement.getAttribute('data-page-scope')) || '';
  var _readyPromise = null;

  window.mrPageToken = {
    // Returns a promise that resolves once the HttpOnly cookie has been set
    // (or rejects if the mint failed). Safe to await multiple times — the
    // underlying request is made at most once per page load.
    ready: function() {
      if (_readyPromise) return _readyPromise;
      if (!scope) {
        _readyPromise = Promise.reject(new Error('window.__MR_PAGE_SCOPE__ not set'));
      } else {
        _readyPromise = requestCookie(scope);
      }
      return _readyPromise;
    },
    // Force a fresh mint (e.g. after a 401 from a write endpoint indicates the
    // cookie expired mid-session).
    refresh: function() {
      _readyPromise = scope ? requestCookie(scope) : Promise.reject(new Error('no scope'));
      return _readyPromise;
    },
    // Drop-in fetch wrapper with bounded one-shot 401 retry.
    //
    // Flow:
    //   - Wait for ready() so the first write on a cold page is minted first.
    //   - Always use credentials:'same-origin' so the cookie goes out.
    //   - If the response is 401, call refresh() once, retry the fetch once.
    //   - A second 401 returns to the caller unchanged (no infinite loop).
    //
    // Any error from ready() / refresh() is surfaced via the returned promise;
    // callers can still show their own error UI. Non-401 responses are returned
    // verbatim with no retry, so 4xx/5xx semantics are preserved.
    fetch: function(url, init) {
      var self = this;
      var opts = Object.assign({ credentials: 'same-origin' }, init || {});
      // Clone body so we can retry if it is a string/FormData (most writes are
      // JSON strings — safe). If body is a ReadableStream, retry will fail on
      // the 2nd call; callers should avoid streams when using this wrapper.
      return self.ready().then(function() {
        return fetch(url, opts);
      }).then(function(resp) {
        if (resp.status !== 401) return resp;
        return self.refresh().then(function() {
          return fetch(url, opts); // one retry, no further retries
        });
      });
    },
    scope: scope
  };

  // Kick off the mint immediately so by the time the user acts on the page the
  // cookie is already in place. Errors are surfaced on .ready() when awaited.
  if (scope) window.mrPageToken.ready().catch(function(e) {
    console.error('[mrPageToken] initial mint failed:', e && e.message);
  });
})();
