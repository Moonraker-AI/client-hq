// /api/setup-admin.js
// One-time bootstrap: creates admin users in Supabase Auth + admin_profiles.
// Protected by ADMIN_SETUP_SECRET env var. Delete this file after initial setup.
//
// POST { secret: "...", users: [{ email, password, display_name, role }] }

var sb = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var setupSecret = process.env.ADMIN_SETUP_SECRET;
  if (!setupSecret) return res.status(500).json({ error: 'ADMIN_SETUP_SECRET not configured. Set it in Vercel env vars.' });

  var body = req.body || {};
  if (body.secret !== setupSecret) return res.status(403).json({ error: 'Invalid setup secret' });

  var users = body.users;
  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'users array required: [{ email, password, display_name, role }]' });
  }

  // Safety: check if admin_profiles already has rows
  var existing = await sb.query('admin_profiles?select=id&limit=1');
  if (Array.isArray(existing) && existing.length > 0) {
    return res.status(409).json({ error: 'Admin users already exist. Delete existing profiles first or remove this check.' });
  }

  var results = [];
  var sbUrl = sb.url();
  var svcKey = sb.key();

  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (!u.email || !u.password || !u.display_name) {
      results.push({ email: u.email || '?', error: 'email, password, and display_name required' });
      continue;
    }

    try {
      // Create user via Supabase Auth Admin API
      var authResp = await fetch(sbUrl + '/auth/v1/admin/users', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + svcKey,
          'apikey': svcKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: u.email,
          password: u.password,
          email_confirm: true,
          user_metadata: { display_name: u.display_name, role: u.role || 'admin' }
        })
      });

      var authData = await authResp.json();
      if (!authResp.ok) {
        results.push({ email: u.email, error: authData.msg || authData.message || JSON.stringify(authData) });
        continue;
      }

      var userId = authData.id;

      // Insert admin_profiles row
      await sb.mutate('admin_profiles', 'POST', {
        id: userId,
        email: u.email,
        display_name: u.display_name,
        role: u.role || 'admin'
      }, 'return=minimal');

      results.push({ email: u.email, id: userId, status: 'created' });

    } catch (e) {
      results.push({ email: u.email, error: e.message });
    }
  }

  return res.status(200).json({ success: true, results: results });
};
