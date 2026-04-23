-- 2026-04-23 — report_queue send retry tracking (cron audit CR-H3).
--
-- process-queue previously flipped rows to status='failed' with no retry,
-- no backoff, no error classification. Transient compile failures (Anthropic
-- 429, 503, fetch timeouts) became permanent losses. Mirrors the canonical
-- pattern from 2026-04-19-newsletter-send-retry.sql with a report_ prefix.
--
-- Retry policy (enforced in api/cron/process-queue.js):
--   - MAX_ATTEMPTS=3. Backoff 15min → 60min → 240min.
--   - Transient (408/429/5xx, network, timeout, non-JSON): bump attempt,
--     extend report_next_attempt_at. report_retriable stays true.
--   - Permanent (400/401/403/404 from compile-report): short-circuit to
--     report_retriable=false immediately.
--   - After MAX_ATTEMPTS on a transient path: report_retriable=false and
--     monitor.critical fires.
--
-- Partial index stays tiny because only failed+retriable rows are queried
-- each cron pass; completed/pending rows accumulate via the existing idx.
--
-- Applied via MCP apply_migration: report_queue_retry_columns

ALTER TABLE public.report_queue
  ADD COLUMN IF NOT EXISTS report_attempt_count   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_report_error      TEXT,
  ADD COLUMN IF NOT EXISTS report_retriable       BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS report_next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS report_queue_retry_idx
  ON public.report_queue (report_next_attempt_at)
  WHERE status = 'failed'
    AND report_retriable = true;
