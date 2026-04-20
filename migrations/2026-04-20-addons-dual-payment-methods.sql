-- 2026-04-20-addons-dual-payment-methods.sql
-- Mirror of Supabase migration `addons_dual_payment_methods`. Applied via MCP
-- on 2026-04-20.
--
-- Converts add-on tiers to the dual _ach / _cc pattern used by CORE.
--
-- NOTE: payment_method column uses 'card' not 'cc' per the CHECK constraint.
-- The tier_key suffix is `_cc` (the canonical pattern used throughout the
-- codebase and by create-session.js's payment_method_types lock).
--
-- 1. Deactivate paid_strategy_call — moving to its own standalone lead-gen
--    landing page at /paid-strategy-call. Row preserved for reactivation.
--
-- 2. Rename existing three active tiers (which were `payment_method='any'`)
--    to the `_ach` suffix pattern and explicitly mark them as 'ach'. Amounts
--    unchanged at $300.
--
-- 3. Insert matching _cc tiers at amount_ach × 1.035 ($310.50 = 31050 cents),
--    with payment_method='card'. sort_order interleaved so ACH comes before
--    its CC sibling within each product group (10/11, 20/21, 30/31).

UPDATE public.pricing_tiers
SET active = false, updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'paid_strategy_call';

UPDATE public.pricing_tiers
SET tier_key = 'additional_service_page_ach', payment_method = 'ach', sort_order = 10, updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'additional_service_page';

UPDATE public.pricing_tiers
SET tier_key = 'additional_press_release_ach', payment_method = 'ach', sort_order = 20, updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'additional_press_release';

UPDATE public.pricing_tiers
SET tier_key = 'nap_update_ach', payment_method = 'ach', sort_order = 30, updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'nap_update';

INSERT INTO public.pricing_tiers
  (product_key, tier_key, display_name, amount_cents, period, detail, sort_order, active, payment_method)
VALUES
  ('addons', 'additional_service_page_cc',   'Additional Service Page',  31050, 'per page',    'Add a service page beyond the 5 included in your CORE Marketing Campaign.', 11, true, 'card'),
  ('addons', 'additional_press_release_cc',  'Additional Press Release', 31050, 'per release', 'Syndicate a press release across 500+ national and international news outlets beyond the one included in your campaign.', 21, true, 'card'),
  ('addons', 'nap_update_cc',                'NAP Update',               31050, 'per change',  'Update your practice name, address, or phone across your website, local directories, and citation data aggregators. Citation rebuild included.', 31, true, 'card');
