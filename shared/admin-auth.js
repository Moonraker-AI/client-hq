// shared/admin-auth.js
// Include on all /admin/* pages (except login).
// Checks for a valid Supabase Auth session, redirects to login if missing.
// Exposes window.adminAuth for use by page scripts.
//
// Usage in admin pages:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//   <script src="/shared/admin-auth.js"></script>
//   <script>
//     adminAuth.ready(function(session, user) {
//       // session.access_token is available for API calls
//       // user = { id, email, role, name }
//     });
//   </script>

(function() {
  var SB_URL = 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbW13Y2poZHJodnh4a2hjdXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjM1NTcsImV4cCI6MjA4OTg5OTU1N30.zMMHW0Fk9ixWjORngyxJTIoPOfx7GFsD4wBV4Foqqms';

  var client = window.supabase.createClient(SB_URL, SB_ANON);
  var _session = null;
  var _user = null;
  var _readyCallbacks = [];
  var _resolved = false;

  function goLogin() {
    window.location.href = '/admin/login';
  }

  // Get the current session, refresh if needed
  async function init() {
    try {
      var result = await client.auth.getSession();
      if (!result.data.session) { goLogin(); return; }

      _session = result.data.session;

      // Verify admin profile
      var resp = await fetch(SB_URL + '/rest/v1/admin_profiles?id=eq.' + _session.user.id + '&select=id,email,display_name,role&limit=1', {
        headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + _session.access_token }
      });
      var profiles = await resp.json();

      if (!Array.isArray(profiles) || profiles.length === 0) {
        await client.auth.signOut();
        goLogin();
        return;
      }

      _user = {
        id: profiles[0].id,
        email: profiles[0].email,
        name: profiles[0].display_name,
        role: profiles[0].role
      };

      _resolved = true;
      for (var i = 0; i < _readyCallbacks.length; i++) {
        _readyCallbacks[i](_session, _user);
      }
      _readyCallbacks = [];

    } catch (e) {
      console.error('[admin-auth] Init failed:', e);
      goLogin();
    }
  }

  // Listen for token refresh
  client.auth.onAuthStateChange(function(event, session) {
    if (event === 'SIGNED_OUT') {
      goLogin();
    } else if (event === 'TOKEN_REFRESHED' && session) {
      _session = session;
    }
  });

  // Public API
  window.adminAuth = {
    // Register a callback for when auth is ready
    ready: function(cb) {
      if (_resolved) { cb(_session, _user); }
      else { _readyCallbacks.push(cb); }
    },

    // Get current access token (for API calls)
    token: function() { return _session ? _session.access_token : null; },

    // Get current user info
    user: function() { return _user; },

    // Get the Supabase client (for direct queries with user's JWT)
    supabase: client,

    // Sign out and redirect
    signOut: async function() {
      await client.auth.signOut();
      goLogin();
    },

    // Helper: make authenticated API call
    apiFetch: function(url, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      if (_session) {
        opts.headers['Authorization'] = 'Bearer ' + _session.access_token;
      }
      if (!opts.headers['Content-Type'] && opts.body) {
        opts.headers['Content-Type'] = 'application/json';
      }
      return fetch(url, opts);
    },

    // Helper: make authenticated Supabase read (uses user's JWT, not service key)
    sbFetch: function(path) {
      return fetch(SB_URL + '/rest/v1/' + path, {
        headers: {
          'apikey': SB_ANON,
          'Authorization': 'Bearer ' + (_session ? _session.access_token : SB_ANON)
        }
      }).then(function(r) { return r.json(); });
    }
  };

  // Start auth check
  init();
})();
