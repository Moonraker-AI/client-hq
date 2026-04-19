// api/_lib/action-schema.js
// Per-table permission manifest for /api/action.
//
// Decision 3 from docs/phase-4-design.md (Option C: shape-aware middleware).
// Keeps the generic action endpoint but adds per-table coarse-grained
// permissions. Session 5 ships this in permissive mode — everything currently
// in the allowlist stays writable/deletable. Session 6 tightens the few
// tables that store money or signed legal artifacts.
//
// Each entry can specify:
//   read:          true | false              — allow read_records?
//   write:         true | false              — allow create/update/bulk_update?
//   delete:        true | false              — allow delete_record?
//   require_role:  'owner' | undefined       — if set, only admins with this
//                                              role can mutate. Read is always
//                                              allowed regardless of role.
//
// The default (for any table not listed) is read+write+delete = true — same
// as today's behavior. The point of listing a table explicitly is to declare
// intent: "yes, we audited this; yes, admin mutation is appropriate."
//
// To tighten a table later: set write: false (makes it read-only) or
// require_role: 'owner' (locks mutations to Chris).

// The full allowlist copied from api/action.js (the single source of truth for
// which tables the admin UI + chat assistant are ever allowed to touch). Any
// new table must be added here AND to api/action.js's allowlist.
var PERMISSIVE = { read: true, write: true, delete: true };

var TABLES = {
  // Core client/lifecycle tables
  contacts:                { read: true, write: true, delete: true },
  practice_details:        { read: true, write: true, delete: true },
  onboarding_steps:        { read: true, write: true, delete: true },
  intro_call_steps:        { read: true, write: true, delete: true },

  // Delivery / workflow
  deliverables:            { read: true, write: true, delete: true },
  checklist_items:         { read: true, write: true, delete: true },
  performance_guarantees:  { read: true, write: true, delete: true },

  // Reporting
  report_snapshots:        { read: true, write: true, delete: true },
  report_highlights:       { read: true, write: true, delete: true },
  report_configs:          { read: true, write: true, delete: true },
  report_queue:            { read: true, write: true, delete: true },
  tracked_keywords:        { read: true, write: true, delete: true },

  // Audits
  entity_audits:           { read: true, write: true, delete: true },
  audit_followups:         { read: true, write: true, delete: true },
  content_audit_batches:   { read: true, write: true, delete: true },

  // Content
  content_pages:           { read: true, write: true, delete: true },
  content_page_versions:   { read: true, write: true, delete: true },
  content_chat_messages:   { read: true, write: true, delete: true },
  design_specs:            { read: true, write: true, delete: true },
  neo_images:              { read: true, write: true, delete: true },
  bio_materials:           { read: true, write: true, delete: true },
  endorsements:            { read: true, write: true, delete: true },
  social_platforms:        { read: true, write: true, delete: true },
  directory_listings:      { read: true, write: true, delete: true },

  // Proposals
  proposals:               { read: true, write: true, delete: true },
  proposal_followups:      { read: true, write: true, delete: true },

  // Newsletter
  newsletters:             { read: true, write: true, delete: true },
  newsletter_subscribers:  { read: true, write: true, delete: true },
  newsletter_sends:        { read: true, write: true, delete: true },
  newsletter_stories:      { read: true, write: true, delete: true },

  // Infra / config
  settings:                { read: true, write: true, delete: true },
  client_sites:            { read: true, write: true, delete: true },
  site_deployments:        { read: true, write: true, delete: true },

  // Observability (read-mostly; mutations here would be unusual but permitted
  // for now since legacy admin code may still insert error rows manually).
  activity_log:            { read: true, write: true, delete: true },
  error_log:               { read: true, write: true, delete: true },

  // ── Sensitive tables — Session 6 tighten-up (partial, 2026-04-18) ─────
  //
  // M3 decision captured in docs/api-audit-2026-04.md:
  //   signed_agreements → read-only. CSA rows flow in via the onboarding
  //                       page-token path (onboarding.html + onboarding-action.js),
  //                       not the admin UI. Admin dashboards read for display only.
  //   payments          → read-only. Stripe webhook is the sole writer via a
  //                       direct sb.mutate call; admin.js paths never create
  //                       payment rows manually.
  //   workspace_credentials → stays admin-writable. Scott writes encrypted Gmail
  //                       credentials through the admin UI during workspace
  //                       setup. If that workflow later moves to the page-token
  //                       onboarding flow, tighten to require_role: 'owner'.
  //
  // Both read:true because admin dashboards display signed agreements and
  // payment history for support/debugging.
  signed_agreements:       { read: true, write: false, delete: false },
  payments:                { read: true, write: false, delete: false },
  workspace_credentials:   { read: true, write: true,  delete: true  }
};

// Resolve a table entry. Unknown tables get permissive defaults — the caller
// (api/action.js) still enforces its own top-level allowlist, so this function
// never sees a table that wasn't already vetted.
function entry(table) {
  return TABLES[table] || PERMISSIVE;
}

// Check whether a given action against a given table is permitted for this
// user role. Returns { allowed, reason }. Caller should 403 on !allowed.
//
//   action:  'read_records' | 'create_record' | 'update_record' |
//            'bulk_update'  | 'delete_record'
//   table:   table name (already top-level-allowlisted by caller)
//   role:    'owner' | 'admin' (from admin_profiles.role)
function check(table, action, role) {
  var e = entry(table);

  if (action === 'read_records') {
    if (!e.read) return { allowed: false, reason: 'Reads not permitted on ' + table };
    return { allowed: true };
  }

  if (action === 'create_record' || action === 'update_record' || action === 'bulk_update') {
    if (!e.write) return { allowed: false, reason: 'Writes not permitted on ' + table };
    if (e.require_role && role !== e.require_role) {
      return { allowed: false, reason: 'Writes to ' + table + ' require role=' + e.require_role };
    }
    return { allowed: true };
  }

  if (action === 'delete_record') {
    if (!e.delete) return { allowed: false, reason: 'Deletes not permitted on ' + table };
    if (e.require_role && role !== e.require_role) {
      return { allowed: false, reason: 'Deletes on ' + table + ' require role=' + e.require_role };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: 'Unknown action: ' + action };
}

module.exports = {
  TABLES: TABLES,
  check:  check
};
