-- migrations/2026-04-17-trigger-campaign-dates-on-active.sql
--
-- Adds a BEFORE UPDATE trigger on contacts that auto-sets campaign_start
-- and campaign_end when a contact's status transitions to 'active'. Plays
-- nicely alongside the existing auto_promote_to_active trigger (which
-- fires from onboarding_steps and flips contacts.status to 'active'):
-- this trigger then reacts to that status flip and populates the dates.
--
-- Rules:
--   - campaign_start: set to today when null
--   - campaign_end:   set to campaign_start + plan_type interval when null
--                     (quarterly=3mo, annual=12mo, monthly=12mo default,
--                      null plan_type=12mo default)
--
-- Only touches the dates that are currently null; any existing values are
-- preserved so manual overrides aren't clobbered.
--
-- Idempotent via DROP TRIGGER IF EXISTS + CREATE OR REPLACE FUNCTION.

CREATE OR REPLACE FUNCTION set_campaign_dates_on_active()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'UPDATE'
      AND OLD.status IS DISTINCT FROM 'active'
      AND NEW.status = 'active') THEN

    IF NEW.campaign_start IS NULL THEN
      NEW.campaign_start := CURRENT_DATE;
    END IF;

    IF NEW.campaign_end IS NULL THEN
      -- plan_type -> months mapping is also encoded in JS at
      -- api/_lib/contract.js (deriveContractMonths) and in
      -- migrations/2026-04-17-backfill-campaign-end.sql.
      -- If you add a plan_type value, update all three sites.
      NEW.campaign_end := NEW.campaign_start + CASE COALESCE(NEW.plan_type, 'annual')
        WHEN 'quarterly' THEN INTERVAL '3 months'
        WHEN 'annual'    THEN INTERVAL '12 months'
        WHEN 'monthly'   THEN INTERVAL '12 months'
        ELSE INTERVAL '12 months'
      END;
    END IF;

  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_campaign_dates_on_active()
  IS 'Auto-populates contacts.campaign_start and contacts.campaign_end when status transitions to active. Respects existing values (null-coalesces only). Drives engagement-length math on the campaign-summary report.';

DROP TRIGGER IF EXISTS set_campaign_dates_on_active ON contacts;
CREATE TRIGGER set_campaign_dates_on_active
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_campaign_dates_on_active();
