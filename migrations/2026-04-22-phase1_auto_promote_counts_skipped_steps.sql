-- Phase 1 of performance-guarantee UX redesign.
--
-- Before: auto_promote_to_active required every onboarding_steps row to reach
-- status='complete'. With the new design, step 9 (performance_guarantee) may
-- be seeded or flipped to 'skipped' for clients without a 12-month commitment
-- (where the guarantee is a reference/upsell rather than a binding step).
--
-- After: the trigger counts 'complete' and 'skipped' equivalently for the
-- purpose of promoting onboarding -> active, and fires on transitions into
-- either terminal status.
--
-- Applied via Supabase MCP apply_migration (live) on 2026-04-22.

CREATE OR REPLACE FUNCTION public.auto_promote_to_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  total_steps int;
  finished_steps int;
  contact_status text;
  contact_slug text;
BEGIN
  IF NEW.status IN ('complete', 'skipped')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('complete', 'skipped')) THEN

    SELECT c.status, c.slug INTO contact_status, contact_slug
    FROM contacts c WHERE c.id = NEW.contact_id;

    IF contact_status = 'onboarding' THEN
      SELECT COUNT(*),
             COUNT(*) FILTER (WHERE os.status IN ('complete', 'skipped'))
      INTO total_steps, finished_steps
      FROM onboarding_steps os WHERE os.contact_id = NEW.contact_id;

      IF total_steps > 0 AND finished_steps = total_steps THEN
        UPDATE contacts SET status = 'active', updated_at = now()
        WHERE id = NEW.contact_id;

        PERFORM net.http_post(
          url := 'https://clients.moonraker.ai/api/notify-team',
          body := jsonb_build_object('event', 'onboarding_complete', 'slug', contact_slug),
          headers := jsonb_build_object('Content-Type', 'application/json')
        );
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
