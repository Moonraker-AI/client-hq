-- Add 'dispatching' to entity_audits status CHECK constraint.
--
-- The claim_next_audit() RPC (commit 5080d9bc "Atomic claim for entity_audits
-- queue") flips queued -> dispatching via SKIP LOCKED. That status was never
-- added to the CHECK constraint, so every call to the RPC from
-- api/cron/process-audit-queue.js:291 has been failing with a 23514 check
-- constraint violation since the atomic-claim refactor.
--
-- The process-audit-queue cron's Step 0 also PATCHes rows from 'dispatching'
-- back to 'queued' when a dispatch crashes between claim and agent call;
-- that code path likewise has never been exercisable.
--
-- Applied via Supabase MCP on 2026-04-21.

ALTER TABLE entity_audits
  DROP CONSTRAINT entity_audits_status_check;

ALTER TABLE entity_audits
  ADD CONSTRAINT entity_audits_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'queued'::text,
    'dispatching'::text,
    'processing'::text,
    'agent_running'::text,
    'agent_error'::text,
    'complete'::text,
    'delivered'::text
  ]));
