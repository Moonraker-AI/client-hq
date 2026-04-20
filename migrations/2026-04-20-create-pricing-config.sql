-- 2026-04-20-create-pricing-config.sql
-- Mirror of Supabase migration `create_pricing_config`. Applied via MCP on
-- 2026-04-20. See api/_lib/action-schema.js for admin write policy.
--
-- pricing_config: key-value table for pricing rules that aren't tiers.
-- First row: cc_surcharge_pct = 3.5 (the credit-card processing markup
-- baked into every _cc tier's amount_cents). Read by csa-content.js to
-- render the CSA's "Credit card payments add a 3.5% processing fee" line
-- dynamically instead of hardcoding.
--
-- Note: this table is INFORMATIONAL. Changing cc_surcharge_pct here does
-- NOT automatically recompute _cc tier amounts in pricing_tiers.

CREATE TABLE IF NOT EXISTS public.pricing_config (
  key          TEXT PRIMARY KEY,
  value        NUMERIC NOT NULL,
  unit         TEXT,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.pricing_config (key, value, unit, description) VALUES
  ('cc_surcharge_pct', 3.5, '%', 'Credit card processing surcharge baked into every _cc tier amount. Change the CC tier amounts in pricing_tiers when you change this.')
ON CONFLICT (key) DO NOTHING;
