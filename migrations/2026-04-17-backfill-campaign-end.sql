-- migrations/2026-04-17-backfill-campaign-end.sql
--
-- Backfills contacts.campaign_end for active/onboarding/prospect clients
-- where it's currently null. Derives the end date from campaign_start +
-- a plan_type-based interval:
--
--   plan_type = 'quarterly' -> 3 months
--   plan_type = 'annual'    -> 12 months
--   plan_type = 'monthly'   -> 12 months (no fixed contract end; treat as
--                                         annual for reporting purposes)
--   plan_type IS NULL       -> 12 months (default assumption)
--
-- Skips any row where campaign_start is null (cannot derive an end without
-- a start). Skips any row where campaign_end is already set (idempotent).
-- Operates only on active/onboarding/prospect contacts; leads and lost
-- clients don't need a campaign end.

WITH updated AS (
  UPDATE contacts
  SET campaign_end = campaign_start + CASE COALESCE(plan_type, 'annual')
    WHEN 'quarterly' THEN INTERVAL '3 months'
    WHEN 'annual'    THEN INTERVAL '12 months'
    WHEN 'monthly'   THEN INTERVAL '12 months'
    ELSE INTERVAL '12 months'
  END
  WHERE campaign_end IS NULL
    AND campaign_start IS NOT NULL
    AND status IN ('active', 'onboarding', 'prospect')
    AND COALESCE(lost, false) = false
  RETURNING slug, campaign_start, campaign_end, plan_type, status
)
SELECT
  status,
  COALESCE(plan_type, '(null)') AS plan_type,
  COUNT(*) AS backfilled
FROM updated
GROUP BY status, plan_type
ORDER BY status, plan_type;
