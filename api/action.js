// /api/action.js - Execute confirmed AI actions against Supabase
//
// Per-table permission check via _lib/action-schema.
// Injection-safe filters via _lib/postgrest-filter.
// Every mutation writes field-level rows to activity_log.

var sb         = require('./_lib/supabase');
var crypt      = require('./_lib/crypto');
var auth       = require('./_lib/auth');
var schema     = require('./_lib/action-schema');
var pgFilter   = require('./_lib/postgrest-filter');

// Top-level table allowlist — the outer gate. action-schema.js is the
// per-table policy layer; this list just says "known tables only, period."
// Keep in sync with action-schema.js TABLES.
var ALLOWED_TABLES = [
  'contacts','practice_details','onboarding_steps','deliverables','checklist_items',
  'report_snapshots','report_highlights','report_configs','bio_materials','signed_agreements',
  'activity_log','settings','entity_audits','payments',
  'intro_call_steps','tracked_keywords','report_queue','performance_guarantees','proposals',
  'proposal_followups','audit_followups','workspace_credentials','social_platforms',
  'directory_listings','content_pages','content_page_versions','content_chat_messages',
  'design_specs','neo_images','endorsements','error_log','newsletters','newsletter_subscribers',
  'newsletter_sends','content_audit_batches','newsletter_stories','client_sites','site_deployments',
  'pricing_tiers','client_attribution_insights',
  // Page stage chain (audit→critique→polish→harden→clarify) tables.
  'page_stage_runs','client_design_contracts','page_review_queue'
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  // Require authenticated admin
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  try {
    var body    = req.body || {};
    var action  = body.action;
    var table   = body.table;
    var filters = body.filters;
    var data    = body.data;

    if (!action || !table) return res.status(400).json({ error: 'action and table required' });
    if (ALLOWED_TABLES.indexOf(table) === -1) {
      return res.status(400).json({ error: 'Table not allowed: ' + table });
    }

    // Per-table policy check (permissive by default in Session 5; Session 6
    // tightens signed_agreements/payments/workspace_credentials).
    var policy = schema.check(table, action, user.role);
    if (!policy.allowed) return res.status(403).json({ error: policy.reason });

    var isCredentials = (table === 'workspace_credentials');
    var baseUrl = sb.url() + '/rest/v1/' + table;
    var headers = sb.headers('return=representation');

    // ── read_records ──────────────────────────────────────────────
    if (action === 'read_records') {
      var select = body.select || '*';
      var fp0;
      try { fp0 = filters ? pgFilter.buildFilter(filters) : ''; }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }

      var url0 = baseUrl + '?select=' + encodeURIComponent(select) + (fp0 ? '&' + fp0 : '') +
                 '&limit=' + (body.limit || 50);
      var r0 = await fetch(url0, { method: 'GET', headers: headers });
      var result0 = await r0.json();
      if (!r0.ok) return res.status(r0.status).json({ error: 'Supabase error', detail: result0 });
      if (isCredentials) result0 = crypt.decryptFields(result0, crypt.SENSITIVE_FIELDS);
      return res.status(200).json({
        success: true, action: 'read', data: result0,
        count: Array.isArray(result0) ? result0.length : 0
      });
    }

    // ── create_record ─────────────────────────────────────────────
    if (action === 'create_record') {
      if (!data) return res.status(400).json({ error: 'data required' });
      var writeData = isCredentials ? crypt.encryptFields(data, crypt.SENSITIVE_FIELDS) : data;

      var r = await fetch(baseUrl, { method: 'POST', headers: headers, body: JSON.stringify(writeData) });
      var result = await r.json();
      if (!r.ok) { console.error('action create error:', JSON.stringify(result)); return res.status(r.status).json({ error: 'Database write failed' }); }
      var resultForClient = isCredentials ? crypt.decryptFields(result, crypt.SENSITIVE_FIELDS) : result;

      // Audit: one summary row per created record.
      await logActivity(table, 'create', toArray(result), null, user).catch(warnAudit);

      return res.status(201).json({ success: true, action: 'created', data: resultForClient });
    }

    // ── update_record / bulk_update ───────────────────────────────
    if (action === 'update_record' || action === 'bulk_update') {
      if (!filters || !data) return res.status(400).json({ error: 'filters and data required' });

      var fp;
      try { fp = pgFilter.buildFilter(filters); }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }

      // Fetch BEFORE state so activity_log has real old_value per field.
      // One extra round-trip (~30ms). Acceptable for audit fidelity.
      var beforeRows = [];
      try {
        var selectCols = 'id,' + Object.keys(data).filter(function(k){ return isSafeCol(k); }).join(',');
        var beforeResp = await fetch(baseUrl + '?select=' + encodeURIComponent(selectCols) + '&' + fp, {
          method: 'GET', headers: headers
        });
        if (beforeResp.ok) beforeRows = await beforeResp.json();
      } catch (e) { /* best-effort — don't block the mutation on audit fetch */ }

      var writeData2 = isCredentials ? crypt.encryptFields(data, crypt.SENSITIVE_FIELDS) : data;

      var r2 = await fetch(baseUrl + '?' + fp, { method: 'PATCH', headers: headers, body: JSON.stringify(writeData2) });
      var result2 = await r2.json();
      if (!r2.ok) { console.error('action update error:', JSON.stringify(result2)); return res.status(r2.status).json({ error: 'Database update failed' }); }
      var resultForClient2 = isCredentials ? crypt.decryptFields(result2, crypt.SENSITIVE_FIELDS) : result2;

      await logActivity(table, 'update', toArray(result2), beforeRows, user, data).catch(warnAudit);

      return res.status(200).json({
        success: true,
        action: action === 'bulk_update' ? 'bulk_updated' : 'updated',
        count: Array.isArray(result2) ? result2.length : 1,
        data: resultForClient2
      });
    }

    // ── delete_record ─────────────────────────────────────────────
    if (action === 'delete_record') {
      if (!filters) return res.status(400).json({ error: 'filters required for delete' });

      var fp2;
      try { fp2 = pgFilter.buildFilter(filters); }
      catch (e) { return res.status(400).json({ error: 'Bad filter: ' + e.message }); }

      // Fetch rows before delete so activity_log can record what disappeared.
      var deletedRows = [];
      try {
        var beforeDel = await fetch(baseUrl + '?select=*&' + fp2, { method: 'GET', headers: headers });
        if (beforeDel.ok) deletedRows = await beforeDel.json();
      } catch (e) { /* best-effort */ }

      var r3 = await fetch(baseUrl + '?' + fp2, { method: 'DELETE', headers: headers });
      if (!r3.ok) return res.status(r3.status).json({ error: 'Supabase error' });

      await logActivity(table, 'delete', [], deletedRows, user).catch(warnAudit);

      return res.status(200).json({ success: true, action: 'deleted' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('Action error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

// ── activity_log writer ─────────────────────────────────────────────
//
// op:         'create' | 'update' | 'delete'
// afterRows:  rows returned by the PostgREST mutation (representation=return)
// beforeRows: rows fetched before the mutation (update/delete only)
// user:       { id, email, role, name } from requireAdmin
// changedFields: only for 'update' — the `data` object from the request.
//                We only write audit rows for fields the request tried to
//                change, not every column on the row.
//
// Writes are best-effort (non-blocking on failure). A single batched POST
// keeps latency at ~30ms regardless of row count.
async function logActivity(table, op, afterRows, beforeRows, user, changedFields) {
  var entries = [];
  var who = user && user.email ? user.email : 'admin';

  if (op === 'create') {
    afterRows.forEach(function(row) {
      entries.push({
        table_name: table,
        record_id:  String(row.id || ''),
        field_name: '__created__',
        old_value:  null,
        new_value:  compactJson(row),
        changed_by: who,
        contact_id: row.contact_id || row.id_contact || null,
        client_slug: row.client_slug || row.slug || null,
        record_label: recordLabel(table, row)
      });
    });
  }

  else if (op === 'delete') {
    beforeRows.forEach(function(row) {
      entries.push({
        table_name: table,
        record_id:  String(row.id || ''),
        field_name: '__deleted__',
        old_value:  compactJson(row),
        new_value:  null,
        changed_by: who,
        contact_id: row.contact_id || null,
        client_slug: row.client_slug || row.slug || null,
        record_label: recordLabel(table, row)
      });
    });
  }

  else if (op === 'update') {
    // Index beforeRows by id for easy diff lookup.
    var beforeById = {};
    beforeRows.forEach(function(r) { if (r && r.id != null) beforeById[String(r.id)] = r; });

    var fieldNames = changedFields ? Object.keys(changedFields).filter(isSafeCol) : [];

    afterRows.forEach(function(row) {
      var before = beforeById[String(row.id)] || {};
      fieldNames.forEach(function(field) {
        var oldV = before[field];
        var newV = row[field];
        // Skip no-op updates — PostgREST returns the row even if nothing changed.
        if (jsonEq(oldV, newV)) return;
        entries.push({
          table_name: table,
          record_id:  String(row.id || ''),
          field_name: field,
          old_value:  oldV == null ? null : String(oldV).slice(0, 10000),
          new_value:  newV == null ? null : String(newV).slice(0, 10000),
          changed_by: who,
          contact_id: row.contact_id || null,
          client_slug: row.client_slug || row.slug || null,
          record_label: recordLabel(table, row)
        });
      });
    });
  }

  if (entries.length === 0) return;

  // Single batched POST. sb.mutate wraps fetch + error handling.
  try {
    await sb.mutate('activity_log', 'POST', entries, 'return=minimal');
  } catch (e) {
    warnAudit(e);
  }
}

// ── helpers ──────────────────────────────────────────────────────────
function toArray(r) { return Array.isArray(r) ? r : (r == null ? [] : [r]); }

function isSafeCol(k) { return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k); }

function compactJson(row) {
  try {
    // Strip giant fields so activity_log rows stay reasonable.
    var clone = {};
    for (var k in row) {
      if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
      var v = row[k];
      if (typeof v === 'string' && v.length > 2000) clone[k] = v.slice(0, 2000) + '…[truncated]';
      else clone[k] = v;
    }
    return JSON.stringify(clone).slice(0, 10000);
  } catch (e) { return null; }
}

// Best-effort human-readable label for the admin "recent activity" view.
// Falls back gracefully if a table has none of the common name columns.
function recordLabel(table, row) {
  if (!row) return null;
  return row.title || row.name ||
         row.practice_name ||
         row.display_name ||
         (row.first_name && row.last_name ? row.first_name + ' ' + row.last_name : null) ||
         row.slug || null;
}

function jsonEq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}

function warnAudit(e) {
  // Don't fail the admin action because audit write failed. Log loudly.
  console.error('[action] activity_log write failed:', e && e.message ? e.message : e);
}
