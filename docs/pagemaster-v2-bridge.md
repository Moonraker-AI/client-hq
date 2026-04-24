# Pagemaster v1 → v2 Bridge Plan

Audit of current Pagemaster surface, gap analysis vs the new content-system design, and migration sequence.

## What exists today

### Tables (and what they hold)

- **`content_pages`** (7 rows). The current "page" entity. Stores `generated_html` as a single text blob. Carries `surge_data`, `rtpba`, `schema_recommendations`, `target_keyword`, `target_url`, `bio_material_id`, `tracked_keyword_id`, `entity_audit_id`, `batch_id`, `addon_order_id`. Already has `page_type` (homepage/service/location/faq/bio).
- **`content_page_versions`** (0 rows). Append-only HTML history. Reset on every chatbot edit. Fine for v2.
- **`content_page_images`** (0 rows). Per-page image refs. Has `image_role`, `source_type` (stock/drive/upload/neo), `stock_image_id`, `drive_file_id`, `hosted_url`, `alt_text`, `sort_order`. Already structured the way v2 wants.
- **`content_chat_messages`** (0 rows). Conversation history per page. Same pattern as proposal_chatbot.
- **`design_specs`** (1 row). A1 design analysis: typography, color_palette, layout_patterns, button_styles, voice_dna, screenshots. Created once per client, referenced by all builds.
- **`neo_images`** (3 rows). Standalone NEO image entities with `hosted_url` (client domain), metadata (prompt, model, content_page_id). Disconnected from `content_page_images` — they live separately and the page references them by URL, not FK.
- **`client_sites`** (76 rows). Hosting record. `domain`, `hosting_type` (moonraker/wordpress/squarespace/wix/etc), Cloudflare custom hostname IDs, DNS verification.
- **`site_deployments`** (0 rows). Deploy log: `(site_id, page_path) UNIQUE`, `r2_key`, `content_hash`, `deployed_at`. Idempotent upsert pattern already in place.
- **`cms_scouts`** (1 row). Agent-generated CMS detection per client.
- **`site_maps`** + **`site_map_pages`** (5 / 515 rows). The configurator. Already produces the page list that needs to flow into `content_pages`.
- **`bio_materials`** (47 rows). Per-clinician onboarding data. Already has `headshot_url` and full bio fields. Bio pages link via `content_pages.bio_material_id`.
- **`content_audit_batches`** (0 rows). Multi-page Surge batch audit container. Empty but wired.

### Routes (Pagemaster surface)

- `api/seed-content-pages.js` (291 lines) — Creates `content_pages` rows from keywords + bios. Idempotent. Today's bridge from elsewhere into Pagemaster.
- `api/generate-content-page.js` (504 lines) — Calls Claude Opus 4.6 with design_specs + RTPBA + practice context, gets a single HTML blob, stores in `content_pages.generated_html`. Streaming NDJSON.
- `api/generate-neo-image.js` (184 lines) — Calls Gemini 2.0 Flash image generation, uploads to Supabase Storage, creates `neo_images` row. Hardcoded prompt builder, no GBP/QR/logo compositing yet.
- `api/analyze-design-spec.js` + `ingest-design-assets.js` + `trigger-design-capture.js` — A1 design pipeline. Captures CSS/screenshots/voice, populates `design_specs`.
- `api/content-chat.js` (295 lines) — Streaming chatbot. Reads page+contact+spec+practice. System prompt allows arbitrary HTML edits via Claude returning new HTML.
- `api/deploy-content-preview.js` (73 lines) — Deploys the preview template to `<slug>/content-preview/`.
- `api/admin/deploy-to-r2.js` (108 lines) — Pushes HTML to Cloudflare R2 via `client-sites-worker`. Idempotent upsert into `site_deployments`. Only fires for `hosting_type='moonraker'`.
- `api/admin/manage-site.js` (327 lines) — `client_sites` CRUD: domain, Cloudflare custom hostname provisioning, DNS verification.
- `api/trigger-batch-audit.js` + `ingest-batch-audit.js` + `process-batch-synthesis.js` + `cron/process-batch-pages.js` — Multi-page Surge audit pipeline writing into `content_audit_batches` + `content_pages.surge_*`.
- `api/seed-content-pages.js` — Seeds page records.

### Templates

- `_templates/content-preview.html` (276 lines) — Client-facing preview with chatbot. Renders from `content_pages.generated_html` directly, no template layer.

### Admin UI

- `admin/clients/index.html` Content tab already has structure: Hosting (top), Design Spec (collapsible), Keywords, Service Pages (with batch audit), Clinicians (bio pages), NEO. This is already roughly the shape we discussed. Needs reorganization, not rebuild.

## The fundamental gap

Today's model: **content_pages.generated_html is the source of truth.** Everything else is metadata around a string of HTML.

V2 model: **structured content + template = HTML.** `content_pages` should hold structured `content_jsonb` (sections, copy, image refs, FAQs, schema). Template per page type renders to HTML on demand.

Why this matters:
1. **Chatbot scope** — today, Claude can rewrite anything in the HTML blob. We can't enforce "client can edit copy but not nav, schema, NEO." With structured content, the chatbot edits specific JSONB paths.
2. **Live preview** — today, preview = saved HTML. Edit means regenerate the whole HTML. With structured content + template, edit = re-render (fast, deterministic).
3. **Multi-deploy targets** — today, HTML is generated for one platform context. With template + content, the same content can render for R2, WordPress export, Squarespace export, etc.
4. **NEO and images** — today, `neo_images` is disconnected from `content_page_images`. Need to unify so the page's image set is queryable as one thing.
5. **Nav engine** — needs structured page metadata (`nav_visible`, `nav_label`, `nav_section`, `nav_order`) to derive nav. Schema doesn't have these fields yet.

## The bridge plan

Three principles:

1. **Don't break v1.** The 7 existing `content_pages` rows + their `generated_html` keep working through v2 launch. New pages built in v2 mode use the new path.
2. **Extend, don't replace.** Add fields to existing tables, add new tables for v2-only concerns. Keep v1 columns intact.
3. **One client first.** Build v2 against one new pilot client end-to-end before backfilling.

### Schema deltas

**Add to `content_pages`:**
- `template_version` text default 'v1' — 'v1' = use generated_html, 'v2' = render from content_jsonb
- `content_jsonb` jsonb — structured page content per template schema
- `schema_jsonb` jsonb — JSON-LD schema, structured (separate from old `schema_recommendations` which was AI suggestions)
- `faqs` jsonb — array of {question, answer, sort_order} (per-page FAQs, separate from general FAQ page)
- `nav_visible` boolean default true
- `nav_label` text — override for nav display name
- `nav_section` text — 'services' / 'about' / 'locations' / 'resources' / 'utility' / null
- `nav_order` integer
- `footer_visible` boolean default true
- `footer_section` text — 'main' / 'legal' / null
- `neo_image_id` uuid → neo_images.id (replaces metadata-side linkage)

**Add page types to enum/check** (today: homepage/service/location/faq/bio):
- `about_us` (group practices only)
- `contact`
- `privacy`
- `tos`
- `custom` (resource pages)

**Add to `bio_materials`:**
- already has `headshot_url`. Add nothing — onboarding upload writes here.

**Add to `client_sites`:**
- already has the right shape. No deltas.

**Add to `neo_images`:**
- `gbp_data` jsonb — captured at generation time (name, plus_code, share_url)
- `qr_code_url` text — generated QR PNG ref
- `logo_url` text — logo source used
- `keyword` text — page keyword the image was made for
- `composite_status` text — 'raw' | 'composited' (raw = Nano Banana output, composited = with logo + QR + caption overlay)

**New table `nav_overrides`:**
- One row per client. JSONB blob holding manual reorder/force-include/force-exclude rules that aren't expressible per-page. Optional — most clients use the auto-derived nav.

**No new table for page templates** — templates are code, live in `_templates/page-types/{home,service,bio,location,about_us,general_faq,contact,privacy,tos,custom}.html` + a render function.

### Migration of existing data

For the 7 existing `content_pages`:
- Leave `template_version='v1'`. Renderer falls back to `generated_html` for v1 rows.
- Backfill `nav_visible=true`, `footer_visible=true`, derive `nav_section` from `page_type`.
- No content_jsonb migration. If a client wants v2 features on a v1 page, regenerate.

### Route deltas

**Keep:**
- `seed-content-pages.js` — works for both v1 and v2. Add `template_version` parameter (default v2 for new clients).
- `analyze-design-spec.js` and the design pipeline — feeds template rendering (color tokens etc.).
- `deploy-to-r2.js` + `manage-site.js` — already platform-correct.
- `content-chat.js` — refactor to operate on JSONB paths in v2 mode, keep HTML-edit path for v1 fallback.

**New:**
- `api/render-page-preview.js` — Takes `content_page_id`, loads structured content, renders via template, returns HTML. Single source of truth for preview, client review, and deploy.
- `api/generate-page-content.js` — Replaces (or wraps) `generate-content-page.js`. Same Claude prompt, but Claude returns structured JSON matching the template schema, not HTML.
- `api/composite-neo-image.js` — Takes `neo_images.id`, composites Nano Banana output + logo + QR + caption per the reference layout. Writes back composited image to Storage.
- `api/nav.js` — Returns derived nav for a client. Cached.

**Refactor (keep working, add v2 path):**
- `generate-content-page.js` — Add `mode` param. `mode=v1` keeps current behavior. `mode=v2` calls `generate-page-content` then `render-page-preview`.
- `generate-neo-image.js` — Wire in GBP fetch, logo from Drive, QR generation. Write structured fields to `neo_images`. Trigger composite step.

## Build sequence

1. **Schema migration.** All deltas above. Test backfill on the 7 v1 rows. No code changes yet — old code keeps reading what it always did.
2. **Template registry.** Write the template files + render function. Render `service` type first. `/api/render-page-preview` works end-to-end.
3. **Other templates.** home, bio, location, about_us, general_faq, contact, privacy, tos, custom.
4. **`generate-page-content.js`.** Claude returns structured JSON. Save to `content_jsonb`. Render via template. Compare to v1 output for one client.
5. **NEO generator v2.** GBP + logo + QR + composite. Write to `neo_images` with full metadata. Hook to service pages.
6. **Nav + footer engines.** `/api/nav` derives from `content_pages` rows. Footer same.
7. **Admin Content tab restructure.** Master-detail Pages UI. Hosting moves to its own tab.
8. **Client review chatbot v2.** Edits scoped to JSONB paths (copy, FAQs). Locked: nav, schema, NEO, structure.
9. **Deploy adapter.** R2 export from rendered HTML (works today). CMS push deferred.

## Open questions for Chris

1. **Template format.** Plain string templates with `{{var}}` interpolation? Mustache/Handlebars? My preference: literal string templates with a tiny render function (`render(template, data)`), no library, matches the no-build-step convention. Confirm?
2. **Existing 7 content_pages** — any of them production-deployed or all test data? If production, the v1 fallback path matters more. If test, I can delete and start fresh.
3. **`addon_orders`-driven pages** (the `addon_order_id` field on content_pages) — does this need to keep working through migration? Used today?
4. **`generated_html` deprecation** — once v2 ships and everyone's regenerated, do we drop the column or keep forever as v1 fallback?
