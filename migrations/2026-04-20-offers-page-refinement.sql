-- 2026-04-20-offers-page-refinement.sql
-- Mirror of Supabase migration `offers_page_refinement`. Applied via MCP on
-- 2026-04-20.
--
-- Refines the addons catalog for the /offers page:
--
-- 1. Deactivate standalone_website_page — moving to its own dedicated page
--    as a separate project (landing + calculator + scope intake). Not
--    deleting the row so we can reactivate or repurpose later.
--
-- 2. Rename content_edit_republish → nap_update with a clearer description
--    that matches what the service actually covers (NAP propagation across
--    website, directories, data aggregators).
--
-- 3. Strip "Available to..." audience language from the remaining 4 active
--    tiers — /offers is now existing-clients-only, so audience differentiation
--    is irrelevant on that page. CSA text (csa-content.js) is untouched
--    except for the NAP line which tracks the tier rename.

UPDATE public.pricing_tiers
SET active = false, updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'standalone_website_page';

UPDATE public.pricing_tiers
SET tier_key = 'nap_update',
    display_name = 'NAP Update',
    period = 'per change',
    detail = 'Update your practice name, address, or phone across your website, local directories, and citation data aggregators. Citation rebuild included.',
    sort_order = 30,
    updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'content_edit_republish';

UPDATE public.pricing_tiers
SET detail = 'Add a service page beyond the 5 included in your CORE Marketing Campaign.',
    updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'additional_service_page';

UPDATE public.pricing_tiers
SET detail = 'Syndicate a press release across 500+ national and international news outlets beyond the one included in your campaign.',
    updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'additional_press_release';

UPDATE public.pricing_tiers
SET detail = 'One-hour strategy session with Scott Pope to work through specific questions, priorities, or issues.',
    updated_at = now()
WHERE product_key = 'addons' AND tier_key = 'paid_strategy_call';
