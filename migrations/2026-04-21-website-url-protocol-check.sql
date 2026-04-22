-- 2026-04-21: website_url / homepage_url protocol enforcement
--
-- Enforce https?:// prefix on website URL columns so protocol-less values
-- cannot reach downstream consumers (Surge, GBP audits, template
-- renderers). Zero violations at apply time after sweeping 7 contacts
-- earlier today and fixing one post-sweep prospect (tricia-robinson,
-- d4be0b8a-328d-44d3-bad0-c2d23e7e9df5) inline with this migration.
--
-- CHECK constraint behavior: NULL always passes, empty string fails
-- (does not match ^https?://), so callers that want to clear a URL
-- should set NULL, not ''.
--
-- Idempotent: drop-if-exists before add so replay is a no-op.

ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_website_url_protocol_check;

ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_website_url_protocol_check
  CHECK (website_url IS NULL OR website_url ~* '^https?://');

ALTER TABLE public.entity_audits
  DROP CONSTRAINT IF EXISTS entity_audits_homepage_url_protocol_check;

ALTER TABLE public.entity_audits
  ADD CONSTRAINT entity_audits_homepage_url_protocol_check
  CHECK (homepage_url IS NULL OR homepage_url ~* '^https?://');
