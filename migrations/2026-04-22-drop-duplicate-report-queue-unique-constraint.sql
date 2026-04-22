-- Drop the duplicate UNIQUE constraint on report_queue(client_slug, report_month).
-- Applied via Supabase MCP: drop_duplicate_report_queue_unique_constraint_2026_04_22
--
-- Two identical UNIQUE constraints existed:
--   report_queue_client_month_uq               (explicit named)
--   report_queue_client_slug_report_month_key  (auto-generated from inline UNIQUE)
--
-- Both backed identical btree indexes. Having two unique indexes on the
-- same columns meant every INSERT/UPDATE checked uniqueness twice.
-- Detected by the supabase database-linter duplicate_index WARN.
--
-- ON CONFLICT clauses in API code reference columns, not constraint
-- names, so dropping either side is safe. Kept the descriptive name
-- (report_queue_client_month_uq) and dropped the auto-generated _key
-- form.
--
-- Rollback: ALTER TABLE public.report_queue
--            ADD CONSTRAINT report_queue_client_slug_report_month_key
--            UNIQUE (client_slug, report_month);

ALTER TABLE public.report_queue
  DROP CONSTRAINT report_queue_client_slug_report_month_key;
