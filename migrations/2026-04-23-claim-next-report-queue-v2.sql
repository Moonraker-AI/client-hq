-- 2026-04-23 — Extend claim_next_report_queue to include retriable failed rows (CR-H3).
--
-- The original RPC (2026-04-19-queue-claim-rpcs.sql) only claimed rows where
-- status='pending' AND scheduled_for<=now. After CR-H3 introduces retry
-- tracking columns on report_queue (report_attempt_count, report_retriable,
-- report_next_attempt_at), the claim must ALSO include:
--
--   status='failed'
--     AND report_retriable = true
--     AND report_attempt_count < 3
--     AND report_next_attempt_at <= now
--
-- PostgREST rpc call stays a zero-arg POST — backoff threshold is baked into
-- the row's report_next_attempt_at column, not a parameter. MAX_ATTEMPTS=3
-- is hardcoded here (matching the cron handler). Changing it requires a
-- migration bump, which is the correct blast radius for that kind of knob.
--
-- Claim flips status='processing' (pending→processing for new rows,
-- failed→processing for retries). process-queue handler is responsible for
-- writing the terminal state (complete / failed + retry columns) on return.
--
-- Applied via MCP apply_migration: claim_next_report_queue_v2

CREATE OR REPLACE FUNCTION public.claim_next_report_queue()
RETURNS SETOF public.report_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.report_queue
     SET status = 'processing',
         started_at = now(),
         attempt = attempt + 1
   WHERE id = (
     SELECT id
       FROM public.report_queue
      WHERE (
              status = 'pending'
              AND scheduled_for <= now()
            )
         OR (
              status = 'failed'
              AND report_retriable = true
              AND report_attempt_count < 3
              AND report_next_attempt_at IS NOT NULL
              AND report_next_attempt_at <= now()
            )
      ORDER BY scheduled_for ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_next_report_queue()
  FROM anon, authenticated, PUBLIC;

COMMENT ON FUNCTION public.claim_next_report_queue() IS
  'Atomic claim for report_queue cron (CR-H3). Claims pending rows whose scheduled_for has passed OR retriable failed rows whose backoff has elapsed. Flips to processing under FOR UPDATE SKIP LOCKED.';
