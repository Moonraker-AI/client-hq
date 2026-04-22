-- 2026-04-22 Strategy Call pricing
-- Mirrored from MCP apply_migration 'add_strategy_call_pricing'.
--
-- Strategy Call product: $150 paid 1-hour call with Scott.
-- Public landing at /strategy-call; lead-gen for prospects not ready for CORE.
-- Two tiers: ACH (no fee) and Card (+3.5% surcharge), both one-off payments.
--
-- Leaves the legacy addons/paid_strategy_call row untouched (it's already
-- inactive). Future add-on purchases from within the client deep-dive won't
-- hit this new product_key.

INSERT INTO pricing_products (product_key, name)
VALUES ('strategy_call', 'Paid Strategy Call')
ON CONFLICT (product_key) DO NOTHING;

INSERT INTO pricing_tiers (product_key, tier_key, display_name, amount_cents, payment_method, active, sort_order, detail)
VALUES
  ('strategy_call', 'paid_strategy_call_ach',  '1-Hour Strategy Call',  15000, 'ach',  true, 10, 'Bank transfer - no fee'),
  ('strategy_call', 'paid_strategy_call_cc',   '1-Hour Strategy Call',  15525, 'card', true, 20, 'Credit card +3.5% fee')
ON CONFLICT DO NOTHING;
