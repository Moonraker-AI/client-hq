-- 2026-04-20-drop-pricing-config.sql
-- Mirror of Supabase migration `drop_pricing_config`. Applied via MCP on
-- 2026-04-20.
--
-- Reason: CC surcharge is locked to 3.5% indefinitely. Admin UI for it was
-- removed; the value now lives only in shared/csa-content.js CONFIG_DEFAULTS.
-- If we ever need to change the surcharge, edit CONFIG_DEFAULTS directly
-- (and update all _cc tier amounts in pricing_tiers by hand).
--
-- Supersedes 2026-04-20-create-pricing-config.sql (same-day reversal after
-- deciding the value didn't need admin editability).

DROP TABLE IF EXISTS public.pricing_config;
