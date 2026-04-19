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
    scope: scope
  };

  // Kick off the mint immediately so by the time the user acts on the page the
  // cookie is already in place. Errors are surfaced on .ready() when awaited.
  if (scope) window.mrPageToken.ready().catch(function(e) {
    console.error('[mrPageToken] initial mint failed:', e && e.message);
  });
})();
