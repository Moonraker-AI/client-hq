-- 2026-04-22: enforce agent_task_id uniqueness on entity_audits
--
-- Partial unique index: non-null values must be unique across the table;
-- NULL values (the vast majority — audits not currently in flight) are
-- unconstrained. Postgres UNIQUE normally treats NULLs as distinct so a
-- plain UNIQUE would behave the same; the partial index makes that
-- semantics explicit and saves index space.
--
-- Motivation: at least one historical observation of agent_task_id
-- bleed-over between clients (Jeanene's task matched a prior Attune
-- task UUID). Root cause not reproducible in current data (0 duplicates
-- at apply time across all 94 rows). Adding this constraint converts
-- any future recurrence from a silent overwrite into a loud PATCH
-- failure in the dispatch cron — the second dispatcher sees a 23505
-- unique_violation, backs off, and retries on the next tick. The row
-- it was trying to claim remains in 'dispatching' until the stale-
-- dispatching sweep in Step 0 requeues it ~2 min later.
--
-- Assumption: the agent generates unique task IDs per dispatch. If this
-- ever becomes false (e.g. the agent legitimately recycles task IDs
-- across container restarts), drop this index and design a different
-- correlation mechanism.

CREATE UNIQUE INDEX IF NOT EXISTS entity_audits_agent_task_id_unique
  ON public.entity_audits (agent_task_id)
  WHERE agent_task_id IS NOT NULL;
