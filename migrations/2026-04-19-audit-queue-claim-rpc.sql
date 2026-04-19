-- 2026-04-19 — Atomic claim for entity_audits queue (cron audit Phase 2).
--
-- Fixes the same TOCTOU race as migrations/2026-04-19-queue-claim-rpcs.sql
-- but adds an explicit intermediate status 'dispatching' so that the
-- process-audit-queue Step 0 requeue path (which flips agent_running rows
-- back to queued when agent /health reports 0 active tasks) cannot race
-- against an in-flight dispatch.
--
-- Status lifecycle:
--   queued → (RPC claim) → dispatching
--   dispatching → (agent ACK)   → agent_running  (with real agent_task_id)
--   dispatching → (agent NACK)  → agent_error
--   dispatching (stale >2min)   → queued         (Step 0 requeue)
--
-- Applied via MCP apply_migration: audit_queue_claim_rpc

CREATE OR REPLACE FUNCTION claim_next_audit()
RETURNS SETOF entity_audits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE entity_audits
  SET status = 'dispatching',
      updated_at = now()
  WHERE id = (
    SELECT id
    FROM entity_audits
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;
