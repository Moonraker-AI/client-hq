-- 2026-04-23 — Atomic Step 0.5 requeue for entity_audits (cron audit CR-H1).
--
-- Folds process-audit-queue.js Step 0.5 into a SECURITY DEFINER RPC. The
-- previous loop:
--
--   SELECT id FROM entity_audits
--     WHERE status='agent_error' AND agent_error_retriable=true
--           AND (last_agent_error_at IS NULL OR last_agent_error_at < cutoff)
--   THEN PATCH each row individually: status='queued'
--
-- races Step 1's claim_next_audit() under concurrent cron invocations — two
-- ticks could observe the same agent_error row, PATCH it, then both claim it
-- from 'queued' (SKIP LOCKED only helps once the row is in 'queued'). The
-- gap between Step 0.5's loop PATCH and Step 1's claim is the racy window.
--
-- This RPC collapses select + update into one statement with FOR UPDATE
-- SKIP LOCKED on the inner SELECT so concurrent invocations partition the
-- rows. Five-minute backoff preserved: the cron passes p_backoff_cutoff,
-- matching the existing 5 * 60 * 1000 ms window.
--
-- Status lifecycle unchanged:
--   agent_error (retriable=true, backoff elapsed) → queued
--
-- Applied via MCP apply_migration: requeue_retriable_agent_errors_rpc

CREATE OR REPLACE FUNCTION public.requeue_retriable_agent_errors(
  p_backoff_cutoff timestamptz,
  p_limit int DEFAULT 50
)
RETURNS SETOF public.entity_audits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.entity_audits
     SET status = 'queued',
         agent_task_id = NULL,
         updated_at = now()
   WHERE id IN (
     SELECT id
       FROM public.entity_audits
      WHERE status = 'agent_error'
        AND agent_error_retriable = true
        AND (last_agent_error_at IS NULL OR last_agent_error_at < p_backoff_cutoff)
      ORDER BY COALESCE(last_agent_error_at, to_timestamp(0)) ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.requeue_retriable_agent_errors(timestamptz, int)
  FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION public.requeue_retriable_agent_errors(timestamptz, int) IS
  'Atomic Step 0.5 requeue for process-audit-queue cron (CR-H1). Flips retriable agent_error rows back to queued inside FOR UPDATE SKIP LOCKED so concurrent cron ticks do not race against Step 1 claim_next_audit.';
