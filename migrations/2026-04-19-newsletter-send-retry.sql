-- 2026-04-19 — Newsletter send retry tracking (cron audit H3).
--
-- process-scheduled-sends previously flipped rows to status='failed' with no
-- retry, no backoff, no error detail. Transient Resend failures (429, 5xx)
-- became permanent losses.
--
-- Strategy matches entity_audits.agent_error_retriable:
--   - Transient errors (Resend 429/5xx, timeouts) leave send_retriable=true
--     with a backed-off send_next_attempt_at.
--   - Max 3 attempts. On 3rd failure, send_retriable=false and
--     monitor.critical fires to alert the team.
--   - Permanent errors (invalid payload, missing newsletter) short-circuit
--     to send_retriable=false immediately.
--
-- Partial index stays tiny because only failed+retriable rows are queried
-- during each cron pass; sent/delivered rows accumulate indefinitely.
--
-- Applied via MCP apply_migration: newsletter_send_retry_columns

ALTER TABLE newsletters
  ADD COLUMN IF NOT EXISTS send_attempt_count   integer   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_send_error      text,
  ADD COLUMN IF NOT EXISTS send_retriable       boolean   NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS send_next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS newsletters_send_retry_idx
  ON newsletters (send_next_attempt_at)
  WHERE status = 'failed'
    AND send_retriable = true;
