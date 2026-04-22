-- Revoke anon write grants on public.entity_audits.
--
-- Applied via Supabase MCP: revoke_anon_writes_on_entity_audits_2026_04_22
--
-- Context: RLS was already blocking anon writes. The only anon-facing
-- policy is anon_read_entity_audits (SELECT only), which is in
-- legitimate use by /<slug>/entity-audit for the client-facing
-- scorecard read. The INSERT/UPDATE/DELETE policies were removed in
-- migration 20260418192957_batch_h5_drop_unused_anon_audit_insert_policy
-- on 2026-04-18, but the underlying table-level grants were left in
-- place. That left two client-side writers in checkout/success/index.html
-- silently failing (RLS returned empty arrays without raising).
--
-- Those writers were removed in commit 74762d1162 (2026-04-22).
-- This migration revokes the now-dead table grants so any future
-- accidental anon-write attempt fails at the grant layer with a clear
-- permission error instead of a silent no-op.
--
-- Mirrors the pattern of revoke_anon_update_on_contacts_2026_04_22
-- applied earlier today.
--
-- Rollback: GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--           ON public.entity_audits TO anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.entity_audits FROM anon;

-- SELECT is intentionally NOT revoked. The anon_read_entity_audits RLS
-- policy covers it, and /<slug>/entity-audit reads audit rows directly
-- from PostgREST via the anon key.
