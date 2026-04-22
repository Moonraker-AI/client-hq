-- Close the two security advisor warnings surfaced after today's
-- grant-hygiene sweep.
-- Applied via Supabase MCP: advisor_cleanup_cron_alerts_sent_policy_and_fn_search_path_2026_04_22
--
--   1. rls_enabled_no_policy on public.cron_alerts_sent — RLS was
--      enabled in 2026-04-22-cron-alerts-sent-table.sql but no admin
--      policy was ever added, leaving the table inaccessible from
--      future admin UI via JWT. service_role bypass still works, so
--      the cron alerting flow was never broken in practice, but the
--      authenticated admin path would 0-row for no reason. Add the
--      standard authenticated_admin_full policy matching the
--      convention from batch3 (rate_limits, gbp_daily, etc.).
--
--   2. function_search_path_mutable on
--      public.pricing_tiers_touch_updated_at — the last remaining
--      function without an explicit search_path. The 25 functions
--      covered by batch_h2 on 2026-04-18 left only this trigger
--      function unpinned because it was added after. Pin it to
--      'public, pg_catalog' per the same convention.
--
-- Rollback: DROP POLICY authenticated_admin_full ON public.cron_alerts_sent;
--           ALTER FUNCTION public.pricing_tiers_touch_updated_at() RESET search_path;

-- 1. cron_alerts_sent admin policy
CREATE POLICY authenticated_admin_full ON public.cron_alerts_sent
  FOR ALL TO authenticated
  USING      (is_admin())
  WITH CHECK (is_admin());

-- 2. Pin search_path on the last mutable-search_path function
ALTER FUNCTION public.pricing_tiers_touch_updated_at()
  SET search_path = public, pg_catalog;
