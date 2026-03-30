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

    // Calculate previous period for comparison
    var fromDate = new Date(from);
    var toDate = new Date(to);
    var periodMs = toDate - fromDate;
    var prevTo = new Date(fromDate.getTime() - 86400000);
    var prevFrom = new Date(prevTo.getTime() - periodMs);
    var prevFromStart = prevFrom.toISOString().split('T')[0] + 'T00:00:00Z';
    var prevToEnd = prevTo.toISOString().split('T')[0] + 'T23:59:59Z';

    // Fetch current period activity
    var actRes = await sbGet(supabaseUrl, headers, 'activity_log?select=*&created_at=gte.' + fromStart + '&created_at=lte.' + toEnd + '&order=created_at.desc');

    // Fetch previous period activity for comparison
    var prevActRes = await sbGet(supabaseUrl, headers, 'activity_log?select=*&created_at=gte.' + prevFromStart + '&created_at=lte.' + prevToEnd + '&order=created_at.desc');

    // Fetch contacts created in current period
    var newCtRes = await sbGet(supabaseUrl, headers, 'contacts?select=slug,practice_name,status,created_at&created_at=gte.' + fromStart + '&created_at=lte.' + toEnd + '&order=practice_name');

    // Fetch all contacts for name lookups
    var allCtRes = await sbGet(supabaseUrl, headers, 'contacts?select=id,slug,practice_name,status');
    var contactMap = {};
    allCtRes.forEach(function(c) { contactMap[c.slug] = c.practice_name; contactMap[c.id] = c.practice_name; });

    // Compute stats
    var stats = computeStats(actRes);
    var prevStats = computeStats(prevActRes);

    // Classify new contacts
    var proposals = newCtRes.filter(function(c) { return c.status === 'prospect' || c.status === 'lead'; });
    var signups = newCtRes.filter(function(c) { return c.status === 'onboarding' || c.status === 'active'; });

    // Group activities by client
    var byClient = {};
    actRes.forEach(function(a) {
      var key = a.client_slug || 'unknown';
      if (!byClient[key]) byClient[key] = [];
      byClient[key].push(a);
    });

    // Generate insights
    var insights = generateInsights(stats, prevStats, proposals, signups, byClient);

    // Build HTML email
    var html = buildDigestEmail({
      from: from, to: to, stats: stats, prevStats: prevStats,
      proposals: proposals, signups: signups, byClient: byClient,
      contactMap: contactMap, insights: insights
    });

    // Send via Resend
    console.log('Sending digest to:', recipients);
    var sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Client HQ <notifications@clients.moonraker.ai>',
        to: recipients,
        subject: 'Team Digest: ' + from + ' to ' + to,
        html: html
      })
    });

    var sendText = await sendRes.text();
    console.log('Resend response:', sendRes.status, sendText);
    var sendResult;
    try { sendResult = JSON.parse(sendText); } catch(e) { sendResult = { raw: sendText }; }
    if (!sendRes.ok) {
      return res.status(500).json({ error: 'Resend error', status: sendRes.status, detail: sendResult });
    }

    return res.status(200).json({
      success: true, messageId: sendResult.id,
      stats: { total: stats.totalChanges, deliverables: stats.delCompleted, tasks: stats.tasksCompleted, proposals: proposals.length, signups: signups.length }
    });

  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};

async function sbGet(url, headers, path) {
  var r = await fetch(url + '/rest/v1/' + path, { headers: headers });
  return await r.json();
}

function computeStats(activities) {
  return {
    totalChanges: activities.length,
    delCompleted: activities.filter(function(a) { return a.table_name === 'deliverables' && a.new_value === 'delivered'; }).length,
    tasksCompleted: activities.filter(function(a) { return a.table_name === 'checklist_items' && a.new_value === 'complete'; }).length,
    clientsActive: Object.keys(activities.reduce(function(acc, a) { if (a.client_slug) acc[a.client_slug] = true; return acc; }, {})).length
  };
}

function generateInsights(curr, prev, proposals, signups, byClient) {
  var insights = [];

  if (prev.totalChanges > 0) {
    var pct = Math.round(((curr.totalChanges - prev.totalChanges) / prev.totalChanges) * 100);
    if (pct > 0) insights.push('Activity is up ' + pct + '% compared to the previous period (' + curr.totalChanges + ' vs ' + prev.totalChanges + ' changes).');
    else if (pct < 0) insights.push('Activity is down ' + Math.abs(pct) + '% compared to the previous period (' + curr.totalChanges + ' vs ' + prev.totalChanges + ' changes).');
    else insights.push('Activity held steady at ' + curr.totalChanges + ' changes, same as last period.');
  } else if (curr.totalChanges > 0) {
    insights.push(curr.totalChanges + ' total changes this period (no previous period data to compare).');
  }

  if (curr.delCompleted > 0) {
    var d = curr.delCompleted + ' deliverable' + (curr.delCompleted !== 1 ? 's' : '') + ' marked done.';
    if (prev.delCompleted > 0) d += ' Previous period: ' + prev.delCompleted + '.';
    insights.push(d);
  }

  if (curr.tasksCompleted > 0) {
    var t = curr.tasksCompleted + ' audit task' + (curr.tasksCompleted !== 1 ? 's' : '') + ' completed.';
    if (prev.tasksCompleted > 0) t += ' Previous period: ' + prev.tasksCompleted + '.';
    insights.push(t);
  }

  if (proposals.length > 0) insights.push(proposals.length + ' new proposal' + (proposals.length !== 1 ? 's' : '') + ' sent.');
  if (signups.length > 0) insights.push(signups.length + ' new client' + (signups.length !== 1 ? 's' : '') + ' signed up!');

  var topSlug = null, topCount = 0;
  for (var slug in byClient) {
    if (byClient[slug].length > topCount) { topCount = byClient[slug].length; topSlug = slug; }
  }
  if (topSlug && topCount > 1) insights.push('Most active: ' + topSlug + ' (' + topCount + ' changes).');

  if (insights.length === 0) insights.push('Quiet period with no recorded activity.');
  return insights;
}

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

  // Key Insights
  h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;margin-bottom:16px;border-left:3px solid #00D47E;">';
  h += '<h3 style="font-size:14px;color:#1E2A5E;margin:0 0 8px;">Key Insights</h3>';
  data.insights.forEach(function(i) {
    h += '<p style="font-size:13px;color:#333F70;margin:4px 0;line-height:1.5;">' + esc(i) + '</p>';
  });
  h += '</div>';

  // Stats
  h += '<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">';
  var statItems = [
    { val: data.stats.totalChanges, label: 'Total Changes', prev: data.prevStats.totalChanges },
    { val: data.stats.delCompleted, label: 'Deliverables Done', prev: data.prevStats.delCompleted },
    { val: data.stats.tasksCompleted, label: 'Audit Tasks Done', prev: data.prevStats.tasksCompleted },
    { val: data.stats.clientsActive, label: 'Clients Active', prev: data.prevStats.clientsActive },
  ];
  statItems.forEach(function(s) {
    var arrow = '';
    if (s.prev > 0) {
      if (s.val > s.prev) arrow = ' <span style="color:#00D47E;font-size:11px;">&#9650;</span>';
      else if (s.val < s.prev) arrow = ' <span style="color:#EF4444;font-size:11px;">&#9660;</span>';
    }
    h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:12px 16px;text-align:center;flex:1;min-width:120px;">';
    h += '<div style="font-size:24px;font-weight:700;color:#1E2A5E;">' + s.val + arrow + '</div>';
    h += '<div style="font-size:10px;color:#6B7599;text-transform:uppercase;letter-spacing:.5px;">' + s.label + '</div>';
    h += '</div>';
  });
  h += '</div>';

  // Pipeline
  if (data.signups.length > 0 || data.proposals.length > 0) {
    h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin-bottom:16px;">';
    h += '<h3 style="font-size:15px;color:#1E2A5E;margin:0 0 12px;">Pipeline</h3>';
    if (data.signups.length > 0) {
      h += '<div style="font-size:11px;font-weight:600;color:#00b86c;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Clients Signed (' + data.signups.length + ')</div>';
      data.signups.forEach(function(c) {
        h += '<div style="padding:3px 0;font-size:13px;color:#333F70;"><span style="background:rgba(0,212,126,.1);color:#00b86c;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-right:6px;">SIGNED</span>' + esc(c.practice_name || c.slug) + '</div>';
      });
      if (data.proposals.length > 0) h += '<div style="height:10px;"></div>';
    }
    if (data.proposals.length > 0) {
      h += '<div style="font-size:11px;font-weight:600;color:#3B82F6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Proposals Sent (' + data.proposals.length + ')</div>';
      data.proposals.forEach(function(c) {
        h += '<div style="padding:3px 0;font-size:13px;color:#333F70;"><span style="background:rgba(59,130,246,.1);color:#3B82F6;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-right:6px;">PROPOSAL</span>' + esc(c.practice_name || c.slug) + '</div>';
      });
    }
    h += '</div>';
  }

  // Activity by client
  var slugs = Object.keys(data.byClient).sort();
  if (slugs.length > 0) {
    h += '<h3 style="font-size:15px;color:#1E2A5E;margin:16px 0 8px;">Activity by Client</h3>';
    slugs.forEach(function(slug) {
      var entries = data.byClient[slug];
      var name = data.contactMap[slug] || slug;
      h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin-bottom:12px;">';
      h += '<h4 style="font-size:14px;color:#1E2A5E;margin:0 0 8px;">' + esc(name) + ' <span style="font-size:11px;font-weight:400;color:#6B7599;">(' + entries.length + ')</span></h4>';
      entries.forEach(function(e) {
        var date = new Date(e.created_at);
        var dateStr = (date.getMonth() + 1) + '/' + date.getDate();
        var badgeColor, label;
        if (e.table_name === 'deliverables') { badgeColor = 'rgba(59,130,246,.1);color:#3B82F6'; label = 'DELIVERABLE'; }
        else if (e.table_name === 'checklist_items') { badgeColor = 'rgba(0,212,126,.1);color:#00b86c'; label = 'AUDIT TASK'; }
        else { badgeColor = 'rgba(245,158,11,.1);color:#D97706'; label = e.table_name.replace(/_/g,' ').toUpperCase(); }
        h += '<div style="padding:3px 0;font-size:13px;color:#333F70;display:flex;align-items:center;gap:6px;">';
        h += '<span style="color:#6B7599;font-size:12px;min-width:36px;">' + dateStr + '</span>';
        h += '<span style="background:' + badgeColor + ';font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;">' + label + '</span>';
        h += '<span>' + esc(e.field_name) + ': ' + esc(e.old_value || '-') + ' &rarr; ' + esc(e.new_value || '-') + '</span>';
        h += '</div>';
      });
      h += '</div>';
    });
  }

  // Footer
  h += '<div style="text-align:center;padding:16px 0;color:#6B7599;font-size:12px;">';
  h += 'Sent from <a href="https://clients.moonraker.ai/admin/reports" style="color:#00D47E;">Client HQ</a>';
  h += '</div></div></body></html>';
  return h;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
