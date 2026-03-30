// /api/digest.js - Team Digest email sender via Resend
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var resendKey = process.env.RESEND_API_KEY;
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  try {
    var body = req.body;
    var from = body.from;
    var to = body.to;
    var recipients = body.recipients;

    if (!from || !to || !recipients || !recipients.length) {
      return res.status(400).json({ error: 'from, to, and recipients required' });
    }

    var headers = {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + serviceKey,
      'Content-Type': 'application/json'
    };

    var fromStart = from + 'T00:00:00Z';
    var toEnd = to + 'T23:59:59Z';

    // Fetch activity log
    var actUrl = supabaseUrl + '/rest/v1/activity_log?select=*&created_at=gte.' + fromStart + '&created_at=lte.' + toEnd + '&order=created_at.desc';
    var actRes = await fetch(actUrl, { headers: headers });
    var activities = await actRes.json();

    // Fetch contacts for new clients
    var ctUrl = supabaseUrl + '/rest/v1/contacts?select=slug,practice_name,status,created_at&created_at=gte.' + fromStart + '&created_at=lte.' + toEnd + '&order=practice_name';
    var ctRes = await fetch(ctUrl, { headers: headers });
    var newClients = await ctRes.json();

    // Fetch all contacts for name lookups
    var allCtUrl = supabaseUrl + '/rest/v1/contacts?select=id,slug,practice_name';
    var allCtRes = await fetch(allCtUrl, { headers: headers });
    var allContacts = await allCtRes.json();
    var contactMap = {};
    allContacts.forEach(function(c) { contactMap[c.slug] = c.practice_name; contactMap[c.id] = c.practice_name; });

    // Group activities by client
    var byClient = {};
    activities.forEach(function(a) {
      var key = a.client_slug || 'unknown';
      if (!byClient[key]) byClient[key] = [];
      byClient[key].push(a);
    });

    // Count stats
    var totalChanges = activities.length;
    var delCompleted = activities.filter(function(a) { return a.table_name === 'deliverables' && a.new_value === 'delivered'; }).length;
    var tasksCompleted = activities.filter(function(a) { return a.table_name === 'checklist_items' && a.new_value === 'complete'; }).length;

    // Build HTML email
    var html = buildDigestEmail({
      from: from,
      to: to,
      totalChanges: totalChanges,
      delCompleted: delCompleted,
      tasksCompleted: tasksCompleted,
      clientsActive: Object.keys(byClient).length,
      newClients: newClients,
      byClient: byClient,
      contactMap: contactMap
    });

    // Send via Resend
    var emailPayload = {
      from: 'Client HQ <notifications@clients.moonraker.ai>',
      to: recipients,
      subject: 'Team Digest: ' + from + ' to ' + to + ' (' + totalChanges + ' changes)',
      html: html
    };

    console.log('Sending digest to:', recipients, 'from:', emailPayload.from);

    var sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailPayload)
    });

    var sendText = await sendRes.text();
    console.log('Resend response:', sendRes.status, sendText);

    var sendResult;
    try { sendResult = JSON.parse(sendText); } catch(e) { sendResult = { raw: sendText }; }

    if (!sendRes.ok) {
      return res.status(500).json({ error: 'Resend error', status: sendRes.status, detail: sendResult });
    }

    return res.status(200).json({ success: true, messageId: sendResult.id, stats: { totalChanges, delCompleted, tasksCompleted, newClients: newClients.length } });

  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};

function buildDigestEmail(data) {
  var h = '';
  h += '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>';
  h += '<body style="margin:0;padding:0;background:#f4f7f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">';
  h += '<div style="max-width:640px;margin:0 auto;padding:24px;">';

  // Header
  h += '<div style="text-align:center;padding:24px 0 16px;">';
  h += '<img src="https://moonraker.ai/wp-content/uploads/2023/10/Moonraker-Logo-Transparent.png" alt="Moonraker" style="height:32px;opacity:.7;">';
  h += '<h1 style="font-size:22px;color:#1E2A5E;margin:12px 0 4px;">Team Digest</h1>';
  h += '<p style="font-size:14px;color:#6B7599;margin:0;">' + esc(data.from) + ' to ' + esc(data.to) + '</p>';
  h += '</div>';

  // Stats bar
  h += '<div style="display:flex;gap:12px;margin-bottom:20px;">';
  var stats = [
    { val: data.totalChanges, label: 'Total Changes' },
    { val: data.delCompleted, label: 'Delivered' },
    { val: data.tasksCompleted, label: 'Tasks Done' },
    { val: data.clientsActive, label: 'Clients Active' },
    { val: data.newClients.length, label: 'New Clients' }
  ];
  stats.forEach(function(s) {
    h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:12px 16px;text-align:center;flex:1;">';
    h += '<div style="font-size:24px;font-weight:700;color:#1E2A5E;">' + s.val + '</div>';
    h += '<div style="font-size:11px;color:#6B7599;text-transform:uppercase;letter-spacing:.5px;">' + s.label + '</div>';
    h += '</div>';
  });
  h += '</div>';

  // New clients
  if (data.newClients.length > 0) {
    h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin-bottom:16px;">';
    h += '<h3 style="font-size:15px;color:#1E2A5E;margin:0 0 8px;">New Clients</h3>';
    data.newClients.forEach(function(c) {
      h += '<div style="padding:4px 0;font-size:13px;color:#333F70;">';
      h += '<span style="background:rgba(245,158,11,.1);color:#D97706;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-right:6px;">NEW</span>';
      h += esc(c.practice_name || c.slug) + ' <span style="color:#6B7599;">(' + c.status + ')</span>';
      h += '</div>';
    });
    h += '</div>';
  }

  // Per-client activity
  var slugs = Object.keys(data.byClient).sort();
  slugs.forEach(function(slug) {
    var entries = data.byClient[slug];
    var name = data.contactMap[slug] || slug;
    h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin-bottom:12px;">';
    h += '<h3 style="font-size:15px;color:#1E2A5E;margin:0 0 8px;">' + esc(name) + ' <span style="font-size:11px;font-weight:400;color:#6B7599;">(' + entries.length + ' changes)</span></h3>';
    entries.forEach(function(e) {
      var date = new Date(e.created_at);
      var dateStr = (date.getMonth() + 1) + '/' + date.getDate();
      var badgeColor = e.table_name === 'deliverables' ? 'rgba(59,130,246,.1);color:#3B82F6' : 'rgba(0,212,126,.1);color:#00b86c';
      var label = e.table_name === 'deliverables' ? 'DELIVERABLE' : e.table_name === 'checklist_items' ? 'AUDIT TASK' : e.table_name.toUpperCase();
      h += '<div style="padding:4px 0;font-size:13px;color:#333F70;display:flex;align-items:center;gap:6px;">';
      h += '<span style="color:#6B7599;font-size:12px;min-width:36px;">' + dateStr + '</span>';
      h += '<span style="background:' + badgeColor + ';font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;">' + label + '</span>';
      h += '<span>' + esc(e.field_name) + ': ' + esc(e.old_value || '-') + ' &rarr; ' + esc(e.new_value || '-') + '</span>';
      h += '</div>';
    });
    h += '</div>';
  });

  // Footer
  h += '<div style="text-align:center;padding:16px 0;color:#6B7599;font-size:12px;">';
  h += 'Sent from <a href="https://clients.moonraker.ai/admin/reports" style="color:#00D47E;">Client HQ</a>';
  h += '</div>';

  h += '</div></body></html>';
  return h;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

