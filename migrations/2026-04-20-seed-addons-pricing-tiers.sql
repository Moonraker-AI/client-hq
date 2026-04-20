-- 2026-04-20-seed-addons-pricing-tiers.sql
-- Mirror of Supabase migration `seed_addons_pricing_tiers`. Applied via MCP
-- on 2026-04-20.
--
-- Addons product: one-off services sold outside the CORE Marketing Campaign.
-- Payment method 'any' because these are flat prices that can be paid either
-- way (no ACH/CC pairing, no 3.5% surcharge). Prices from csa-content.js.

INSERT INTO public.pricing_tiers
  (product_key, tier_key, display_name, amount_cents, period, detail, payment_method, billing_term, billing_cadence, active, sort_order)
VALUES
  ('addons', 'additional_service_page',   'Additional Service Page',   30000, 'per page',    'Beyond the 5 included in the CORE Marketing Campaign',                    'any', NULL, NULL, true, 10),
  ('addons', 'additional_press_release',  'Additional Press Release',  30000, 'per release', 'Available to anyone, including prospects and former clients',              'any', NULL, NULL, true, 20),
  ('addons', 'content_edit_republish',    'Content Edit & Republish',  30000, 'per change',  'Citation rebuild included; available to anyone with live citations',       'any', NULL, NULL, true, 30),
  ('addons', 'paid_strategy_call',        'Paid Strategy Call',        15000, 'per call',    'One-hour session with Scott Pope; available to anyone',                    'any', NULL, NULL, true, 40),
  ('addons', 'standalone_website_page',   'Standalone Website',        60000, 'per page',    'Sitemap planning, design, copywriting, Surge audit for each page built',   'any', NULL, NULL, true, 50)
ON CONFLICT (product_key, tier_key) DO NOTHING;
