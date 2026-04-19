// shared/admin-auth.js
// Include on all /admin/* pages (except login).
//
// How it works:
// 1. Synchronously reads Supabase session from localStorage (instant, no async wait)
// 2. Patches window.fetch to auto-inject Authorization header on /api/* calls
// 3. Async verifies the session + admin profile in background
// 4. Redirects to /admin/login if no session or not an admin
//
// Multi-tab safety:
// - Supabase JS v2 handles cross-tab session sync via BroadcastChannel.
// - Synchronous gate only redirects if there is NO stored session at all.
//   If an access token is expired but a refresh token exists, the async path
//   handles the refresh (avoids premature redirect on tab switch).
//
// Usage:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js"></script>
//   <script src="/shared/admin-auth.js"></script>

(function() {
  var SB_URL = 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbW13Y2poZHJodnh4a2hjdXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjM1NTcsImV4cCI6MjA4OTg5OTU1N30.zMMHW0Fk9ixWjORngyxJTIoPOfx7GFsD4wBV4Foqqms';
  var STORAGE_KEY = 'sb-ofmmwcjhdrhvxxkhcuww-auth-token';

  // ── Step 1: Synchronous token read from localStorage ───────────
  // Only redirect if there is NO stored session at all (no refresh token).
  // If the access token is expired but a session exists, let the async
  // init() handle the refresh instead of bailing immediately.
  var _accessToken = null;
  var _hasStoredSession = false;
  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      var parsed = JSON.parse(stored);
      _hasStoredSession = !!(parsed.refresh_token);
      // Use the access token if it's still valid (60s buffer)
      if (parsed.expires_at && parsed.expires_at > Math.floor(Date.now() / 1000) + 60) {
        _accessToken = parsed.access_token;
      } else if (_hasStoredSession) {
        // Token expired but refresh token exists. Use the expired token
        // temporarily for the fetch interceptor; async init will refresh it.
        _accessToken = parsed.access_token;
      }
    }
  } catch (e) {}

  // Only redirect if there is truly nothing to work with
  if (!_hasStoredSession) {
    window.location.href = '/admin/login';
    document.documentElement.style.display = 'none';
  }

  // Directory cache keys that must be invalidated on any mutation so edits
  // show up immediately on the next directory visit (instead of staying stale
  // for up to the cache TTL).
  var _DIR_CACHE_KEYS = ['mr-cache-clients-dir', 'mr-cache-audits-dir', 'mr-cache-deliverables-dir'];
  function _invalidateDirectoryCaches() {
    try { _DIR_CACHE_KEYS.forEach(function(k) { sessionStorage.removeItem(k); }); } catch (_) {}
  }
  window.adminInvalidateDirCaches = _invalidateDirectoryCaches;

  // ── Step 2: Patch window.fetch to inject auth on /api/* and Supabase REST calls ──
  var _origFetch = window.fetch;
  var _anonBearer = 'Bearer ' + SB_ANON;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var method = (init && init.method ? String(init.method) : (input && input.method ? String(input.method) : 'GET')).toUpperCase();

    if (_accessToken) {
      // Inject auth header on /api/* calls (serverless routes)
      if (url.indexOf('/api/') === 0) {
        init = init || {};
        if (typeof init.headers === 'object' && !(init.headers instanceof Headers)) {
          if (!init.headers['Authorization'] && !init.headers['authorization']) {
            init.headers['Authorization'] = 'Bearer ' + _accessToken;
          }
        } else if (!init.headers) {
          init.headers = { 'Authorization': 'Bearer ' + _accessToken };
        }
      }

      // Swap anon key for JWT on direct Supabase REST calls.
      // This upgrades admin reads from the anon role to the authenticated role,
      // enabling proper RLS admin policies. The apikey header stays as the anon
      // key (PostgREST needs it for project identification).
      if (url.indexOf(SB_URL + '/rest/v1/') === 0) {
        init = init || {};
        if (typeof init.headers === 'object' && !(init.headers instanceof Headers)) {
          var authVal = init.headers['Authorization'] || init.headers['authorization'] || '';
          if (authVal === _anonBearer) {
            init.headers['Authorization'] = 'Bearer ' + _accessToken;
          }
        }
      }
    }

    // We need to retry on 401, so snapshot the args before firing.
    var retryInput = input;
    var retryInit = init ? Object.assign({}, init) : undefined;

    var p = _origFetch.call(window, input, init);

    // On 401 (token expired mid-session), try a silent refresh + one retry.
    // Only retries authenticated calls; skips refresh for anon endpoints.
    var shouldAttempt401Refresh =
      (url.indexOf('/api/') === 0 || url.indexOf(SB_URL + '/rest/v1/') === 0) &&
      !_isRefreshing;
    if (shouldAttempt401Refresh) {
      p = p.then(function(resp) {
        if (resp.status !== 401) return resp;
        return _refreshSessionOnce().then(function(ok) {
          if (!ok) { goLogin(); return resp; }
          // Re-inject the fresh token on the retry attempt.
          var newInit = retryInit || {};
          if (typeof newInit.headers === 'object' && !(newInit.headers instanceof Headers)) {
            newInit.headers['Authorization'] = 'Bearer ' + _accessToken;
          } else if (!newInit.headers) {
            newInit.headers = { 'Authorization': 'Bearer ' + _accessToken };
          }
          return _origFetch.call(window, retryInput, newInit).then(function(retryResp) {
            if (retryResp.status === 401) goLogin();
            return retryResp;
          });
        });
      });
    }

    // Mutation path: clear directory caches so next directory load is fresh.
    var isMutation = (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE');
    var isMutableTarget = (url.indexOf('/api/action') === 0) || (url.indexOf(SB_URL + '/rest/v1/') === 0);
    if (isMutation && isMutableTarget) {
      p.then(function(resp) { if (resp && resp.ok) _invalidateDirectoryCaches(); }, function() { /* network error, ignore */ });
    }

    return p;
  };

  // De-dupe concurrent refresh attempts: all 401s during a refresh share one promise.
  var _isRefreshing = false;
  var _refreshPromise = null;
  function _refreshSessionOnce() {
    if (_refreshPromise) return _refreshPromise;
    if (!_client) return Promise.resolve(false);
    _isRefreshing = true;
    _refreshPromise = _client.auth.getSession().then(function(res) {
      var session = res && res.data && res.data.session;
      if (session && session.access_token) {
        _session = session;
        _accessToken = session.access_token;
        return true;
      }
      return false;
    }).catch(function() { return false; }).then(function(ok) {
      _isRefreshing = false;
      _refreshPromise = null;
      return ok;
    });
    return _refreshPromise;
  }

  // ── Step 3: Async verification + session management ────────────
  var _user = null;
  var _session = null;
  var _readyCallbacks = [];
  var _resolved = false;
  var _client = null;

  function goLogin() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    // Best-effort cookie clear — the server-side endpoint is the authoritative
    // clearer but fire-and-forget here to shorten the cookie's lifetime when
    // the user is bouncing back to /admin/login after an explicit logout.
    try {
      fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' }).catch(function() {});
    } catch (_) {}
    window.location.href = '/admin/login';
  }

  // Mirror the current Supabase access token into the mr_admin_sess HttpOnly
  // cookie via /api/auth/session. Called on init and on every TOKEN_REFRESHED
  // event so the cookie stays in lockstep with the SDK's in-memory session.
  function syncSessionCookie(accessToken) {
    if (!accessToken) return;
    return _origFetch.call(window, '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ access_token: accessToken })
    }).catch(function(e) {
      console.error('[admin-auth] session cookie sync failed:', e && e.message);
    });
  }

  function resolveReady() {
    _resolved = true;
    for (var i = 0; i < _readyCallbacks.length; i++) {
      try { _readyCallbacks[i](_session, _user); } catch (e) { console.error('[admin-auth]', e); }
    }
    _readyCallbacks = [];
  }

  async function init() {
    try {
      _client = window.supabase.createClient(SB_URL, SB_ANON);

      var result = await _client.auth.getSession();
      if (!result.data.session) { goLogin(); return; }

      _session = result.data.session;
      _accessToken = _session.access_token;
      syncSessionCookie(_accessToken);

      // Verify admin profile (using original fetch to avoid interceptor)
      var resp = await _origFetch(SB_URL + '/rest/v1/admin_profiles?id=eq.' + _session.user.id + '&select=id,email,display_name,role&limit=1', {
        headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + _session.access_token }
      });
      var profiles = await resp.json();

      if (!Array.isArray(profiles) || profiles.length === 0) {
        await _client.auth.signOut();
        goLogin();
        return;
      }

      _user = {
        id: profiles[0].id,
        email: profiles[0].email,
        name: profiles[0].display_name,
        role: profiles[0].role
      };

      // Show the page (in case it was hidden)
      document.documentElement.style.display = '';

      resolveReady();

      // Listen for token refresh and sync across tabs. Re-mint the
      // mr_admin_sess cookie on every refresh so the server keeps accepting
      // requests after Supabase rotates the access token (default: every 1h).
      _client.auth.onAuthStateChange(function(event, session) {
        if (event === 'SIGNED_OUT') { goLogin(); }
        else if (event === 'TOKEN_REFRESHED' && session) {
          _session = session;
          _accessToken = session.access_token;
          syncSessionCookie(_accessToken);
        }
      });

    } catch (e) {
      console.error('[admin-auth] Init error:', e);
      goLogin();
    }
  }

  // ── Public API ─────────────────────────────────────────────────
  window.adminAuth = {
    ready: function(cb) {
      if (_resolved) { cb(_session, _user); }
      else { _readyCallbacks.push(cb); }
    },
    token: function() { return _accessToken; },
    user: function() { return _user; },
    signOut: async function() {
      if (_client) await _client.auth.signOut();
      goLogin();
    },
    SB_URL: SB_URL,
    SB_ANON: SB_ANON
  };

  // Start async verification
  if (typeof window.supabase !== 'undefined') {
    init();
  } else {
    // Supabase JS not loaded yet, wait for it
    window.addEventListener('load', init);
  }

  // Safety timeout: if the CDN script never loads and init never resolves,
  // don't leave the page stuck behind display:none indefinitely.
  setTimeout(function() {
    if (_resolved) return;
    if (typeof window.supabase === 'undefined') {
      console.error('[admin-auth] Supabase JS failed to load within 10s; redirecting to login');
      goLogin();
    }
  }, 10000);
})();
