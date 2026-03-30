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

    // Classify new contacts - three-tier pipeline
    var leads = newCtRes.filter(function(c) { return c.status === 'lead'; });
    var proposals = newCtRes.filter(function(c) { return c.status === 'prospect'; });
    var signups = newCtRes.filter(function(c) { return c.status === 'onboarding' || c.status === 'active'; });

    // Group activities by client
    var byClient = {};
    actRes.forEach(function(a) {
      var key = a.client_slug || 'unknown';
      if (!byClient[key]) byClient[key] = [];
      byClient[key].push(a);
    });

    // Generate insights
    var insights = generateInsights(stats, prevStats, leads, proposals, signups, byClient);

    // Build HTML email
    var html = buildDigestEmail({
      from: from, to: to, stats: stats, prevStats: prevStats,
      leads: leads, proposals: proposals, signups: signups, byClient: byClient,
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
        subject: 'Team Digest: ' + formatDateRange(from, to),
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
      stats: { total: stats.totalChanges, deliverables: stats.delCompleted, tasks: stats.tasksCompleted, leads: leads.length, proposals: proposals.length, signups: signups.length }
    });

  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
};

function formatDateRange(fromStr, toStr) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var f = new Date(fromStr + 'T00:00:00Z');
  var t = new Date(toStr + 'T00:00:00Z');
  if (f.getUTCMonth() === t.getUTCMonth() && f.getUTCFullYear() === t.getUTCFullYear()) {
    return months[f.getUTCMonth()] + ' ' + f.getUTCDate() + ' - ' + t.getUTCDate();
  } else if (f.getUTCFullYear() === t.getUTCFullYear()) {
    return months[f.getUTCMonth()] + ' ' + f.getUTCDate() + ' - ' + months[t.getUTCMonth()] + ' ' + t.getUTCDate();
  }
  return months[f.getUTCMonth()] + ' ' + f.getUTCDate() + ', ' + f.getUTCFullYear() + ' - ' + months[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear();
}

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

function generateInsights(curr, prev, leads, proposals, signups, byClient) {
  var insights = [];

  // Pipeline summary first
  var pipelineTotal = leads.length + proposals.length + signups.length;
  if (pipelineTotal > 0) {
    var parts = [];
    if (signups.length > 0) parts.push(signups.length + ' signed');
    if (proposals.length > 0) parts.push(proposals.length + ' proposal' + (proposals.length !== 1 ? 's' : ''));
    if (leads.length > 0) parts.push(leads.length + ' new lead' + (leads.length !== 1 ? 's' : ''));
    insights.push('Pipeline: ' + parts.join(', ') + '.');
  }

  // Work volume comparison
  var workItems = curr.delCompleted + curr.tasksCompleted;
  var prevWork = prev.delCompleted + prev.tasksCompleted;
  if (workItems > 0 && prevWork > 0) {
    var pct = Math.round(((workItems - prevWork) / prevWork) * 100);
    if (pct > 0) insights.push('Work output up ' + pct + '% vs last period (' + workItems + ' items completed vs ' + prevWork + ').');
    else if (pct < 0) insights.push('Work output down ' + Math.abs(pct) + '% vs last period (' + workItems + ' completed vs ' + prevWork + ').');
  } else if (workItems > 0) {
    insights.push(workItems + ' item' + (workItems !== 1 ? 's' : '') + ' completed this period.');
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

  // Individual pipeline items already covered in summary above
  if (curr.clientsActive > 0 && prev.clientsActive > 0 && curr.clientsActive > prev.clientsActive) {
    insights.push('Active client count grew from ' + prev.clientsActive + ' to ' + curr.clientsActive + '.');
  }

  var topSlug = null, topCount = 0;
  for (var slug in byClient) {
    if (byClient[slug].length > topCount) { topCount = byClient[slug].length; topSlug = slug; }
  }
  if (topSlug && topCount > 1) insights.push('Most active: ' + topSlug + ' (' + topCount + ' changes).');

  if (insights.length === 0) insights.push('Quiet period with no recorded activity.');
  return insights;
}

function prettyStatus(val) {
    var map = {
      'not_started': 'Not Started', 'in_progress': 'In Progress',
      'internal_review': 'Internal Review', 'waiting_on_client': 'Waiting on Client',
      'delivered': 'Delivered', 'complete': 'Complete',
      'pending': 'Pending', 'active': 'Active',
      'prospect': 'Prospect', 'onboarding': 'Onboarding', 'lead': 'Lead'
    };
    return map[val] || val;
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
  h += '<p style="font-size:14px;color:#6B7599;margin:0;">' + formatDateRange(data.from, data.to) + '</p>';
  h += '</div>';

  // Key Insights
  h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px 20px;margin-bottom:16px;border-left:3px solid #00D47E;">';
  h += '<h3 style="font-size:14px;color:#1E2A5E;margin:0 0 8px;">Key Insights</h3>';
  data.insights.forEach(function(i) {
    h += '<p style="font-size:13px;color:#333F70;margin:4px 0;line-height:1.5;">' + esc(i) + '</p>';
  });
  h += '</div>';

  // Row 1: Sales pipeline (colored)
  function emailArrow(curr, prev) {
    if (prev > 0 && curr > prev) return ' <span style="color:#00D47E;font-size:11px;">&#9650;</span>';
    if (prev > 0 && curr < prev) return ' <span style="color:#EF4444;font-size:11px;">&#9660;</span>';
    return '';
  }
  h += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr>';
  var salesRow = [
    { val: data.leads.length, label: 'New Leads', bg: '#FFF8EB', nc: '#D97706', bc: '#FDE68A' },
    { val: data.proposals.length, label: 'Proposals Sent', bg: '#EFF6FF', nc: '#3B82F6', bc: '#BFDBFE' },
    { val: data.signups.length, label: 'Clients Signed', bg: '#ECFDF5', nc: '#00b86c', bc: '#A7F3D0' },
  ];
  salesRow.forEach(function(s, i) {
    if (i > 0) h += '<td width="12"></td>';
    h += '<td width="33%" style="background:' + s.bg + ';border:1px solid ' + s.bc + ';border-radius:10px;padding:12px 16px;text-align:center;">';
    h += '<div style="font-size:24px;font-weight:700;color:' + s.nc + ';">' + s.val + '</div>';
    h += '<div style="font-size:10px;color:#6B7599;text-transform:uppercase;letter-spacing:.5px;">' + s.label + '</div></td>';
  });
  h += '</tr></table>';
  // Row 2: Activity (neutral)
  h += '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;"><tr>';
  var actRow = [
    { val: data.stats.delCompleted, label: 'Deliverables Done', prev: data.prevStats.delCompleted },
    { val: data.stats.tasksCompleted, label: 'Audit Tasks Done', prev: data.prevStats.tasksCompleted },
    { val: data.stats.clientsActive, label: 'Clients Active', prev: data.prevStats.clientsActive },
  ];
  actRow.forEach(function(s, i) {
    if (i > 0) h += '<td width="12"></td>';
    h += '<td width="33%" style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:12px 16px;text-align:center;">';
    h += '<div style="font-size:24px;font-weight:700;color:#1E2A5E;">' + s.val + emailArrow(s.val, s.prev) + '</div>';
    h += '<div style="font-size:10px;color:#6B7599;text-transform:uppercase;letter-spacing:.5px;">' + s.label + '</div></td>';
  });
  h += '</tr></table>';

  // Pipeline - three tiers
  if (data.signups.length > 0 || data.proposals.length > 0 || data.leads.length > 0) {
    h += '<div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin-bottom:16px;">';
    h += '<h3 style="font-size:15px;color:#1E2A5E;margin:0 0 12px;">Pipeline</h3>';
    if (data.signups.length > 0) {
      h += '<div style="font-size:11px;font-weight:600;color:#1E2A5E;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Clients Signed (' + data.signups.length + ')</div>';
      data.signups.forEach(function(c) {
        h += '<div style="padding:3px 0;font-size:13px;color:#333F70;"><span style="background:rgba(0,212,126,.1);color:#00b86c;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-right:6px;">SIGNED</span>' + esc(c.practice_name || c.slug) + '</div>';
      });
      h += '<div style="height:10px;"></div>';
    }
    if (data.proposals.length > 0) {
      h += '<div style="font-size:11px;font-weight:600;color:#1E2A5E;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Proposals Sent (' + data.proposals.length + ')</div>';
      data.proposals.forEach(function(c) {
        h += '<div style="padding:3px 0;font-size:13px;color:#333F70;"><span style="background:rgba(59,130,246,.1);color:#3B82F6;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-right:6px;">PROPOSAL</span>' + esc(c.practice_name || c.slug) + '</div>';
      });
      if (data.leads.length > 0) h += '<div style="height:10px;"></div>';
    }
    if (data.leads.length > 0) {
      h += '<div style="font-size:11px;font-weight:600;color:#1E2A5E;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">New Leads (' + data.leads.length + ')</div>';
      data.leads.forEach(function(c) {
        h += '<div style="padding:3px 0;font-size:13px;color:#333F70;"><span style="background:rgba(245,158,11,.1);color:#D97706;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-right:6px;">LEAD</span>' + esc(c.practice_name || c.slug) + '</div>';
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
      h += '<table width="100%" cellpadding="0" cellspacing="0">';
      entries.forEach(function(e) {
        var date = new Date(e.created_at);
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var dateStr = months[date.getMonth()] + ' ' + date.getDate();
        var badgeBg, badgeColor, label;
        if (e.table_name === 'deliverables') { badgeBg = '#EDEDF0'; badgeColor = '#6B7599'; label = 'DELIVERABLE'; }
        else if (e.table_name === 'checklist_items') { badgeBg = '#EDEDF0'; badgeColor = '#6B7599'; label = 'AUDIT TASK'; }
        else { badgeBg = '#FEF3C7'; badgeColor = '#D97706'; label = e.table_name.replace(/_/g,' ').toUpperCase(); }
        h += '<tr>';
        h += '<td style="padding:5px 0;font-size:13px;color:#6B7599;width:50px;vertical-align:top;">' + dateStr + '</td>';
        h += '<td style="padding:5px 4px;vertical-align:top;"><span style="background:' + badgeBg + ';color:' + badgeColor + ';font-size:9px;font-weight:600;padding:2px 6px;border-radius:3px;display:inline-block;">' + label + '</span></td>';
        var entryLabel = e.record_label ? '<strong>' + esc(e.record_label) + '</strong> - ' : '';
        h += '<td style="padding:5px 0;font-size:13px;color:#333F70;">' + entryLabel + esc(e.field_name) + ': ' + prettyStatus(e.old_value || '-') + ' &#8594; ' + prettyStatus(e.new_value || '-') + '</td>';
        h += '</tr>';
      });
      h += '</table>';
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

