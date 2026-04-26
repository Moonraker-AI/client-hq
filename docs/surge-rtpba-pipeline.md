# Surge → RTPBA → Pagemaster Pipeline

This doc describes how Surge audit data flows from the agent VPS into client_hq,
gets parsed into the structures Pagemaster needs, and produces a styled HTML page
plus separate schema for the chain to refine.

## TL;DR

```
Lock target pages
       │
       ├─ Homepage: auto-link existing entity_audit if fresh (≤30d), else queue
       └─ Service pages: queue Surge audit per page (sequential, agent VPS)
                                    │
                                    ▼
                           Surge returns markdown
                                    │
                          surge-parser extracts:
                           • RTPBA (page content seed)
                           • schema_recommendations (JSON-LD blocks)
                           • variance_score / variance_label
                           • blueprint_phases (display-only summary)
                           • cluster_synthesis (interlink hints, optional)
                                    │
                                    ▼
                          Stored on content_pages:
                           • surge_raw_data (verbatim markdown)
                           • surge_data (parsed structure)
                           • rtpba (text)
                           • schema_recommendations (jsonb)
                           • variance_score, variance_label
                           • status → audit_loaded
                                    │
                                    ▼
                    Pagemaster generation (admin button)
                    Reads:
                     • content_pages.rtpba (primary content seed)
                     • content_pages.schema_recommendations
                     • client_design_contracts (if active)
                     • design_specs (if no contract)
                     • contacts, practice_details, bio_materials
                    Outputs (stored separately):
                     • generated_html (no inline JSON-LD)
                     • schema_jsonb (Pagemaster-curated JSON-LD blocks)
                     • status → review
                                    │
                                    ▼
                            Page-stage chain runs
                  audit → critique → polish → harden → clarify → verify
                                    │
                                    ▼
                        Render layer (preview + final)
                  Stitches generated_html + schema_jsonb at serve time
```

## Why we don't create new tables

The `content_pages` table already has every field this pipeline needs:
`surge_raw_data`, `surge_data`, `rtpba`, `schema_recommendations`, `schema_jsonb`,
`variance_score`, `variance_label`, `surge_status`, `target_url`, `target_keyword`,
`agent_task_id`, `batch_id`, `entity_audit_id`. The `content_audit_batches` table
already has `synthesis_raw`, `synthesis_processed`, `pages_total/extracted/processed`.

Earlier work laid this foundation. The remaining work is to fill these fields
properly and have Pagemaster + chain use them.

## Pieces

### 1. surge-parser library — `api/_lib/surge-parser.js`

Pure function. Takes raw Surge output (markdown string, JSON string, or object
envelope) and returns a normalized structure. Handles three input shapes:

- **markdown**: Anna's example doc. The full v3 Surge output with section
  headings, JSON code blocks, and STRUCTURED_SCORES.
- **json**: legacy agent-extracted shape with `opportunities.ready_to_publish`
  and `action_plan.schema_recommendations`.
- **mixed**: JSON envelope with a `raw_text` field holding the markdown.

Extractors are best-effort. Returning null for a field is fine — Pagemaster
degrades gracefully.

The parser is versioned (`PARSER_VERSION`) so we can re-parse old `surge_raw_data`
when the parser improves.

### 2. ingest-surge-content — `api/ingest-surge-content.js` (existing, modify)

Agent callback when a Surge audit completes. Already exists, already updates
`content_pages` with `rtpba` + `schema_recommendations`. Modify to use the new
`surge-parser` so it also writes `variance_score`, `variance_label`,
`surge_data` (parsed structure), and stores `surge_raw_data` (verbatim markdown).

### 3. lock-target-pages endpoint — `api/onboarding/lock-target-pages.js` (new)

The "Lock target pages and fire audits" button posts here. Inputs:
`{ contact_id, page_ids?: [...] }` (page_ids defaults to all eligible pages).

Behavior:

1. Mark `tracked_keywords.is_locked = true` for the contact's keywords (or add
   the column if missing — see migration note below).
2. Create a `content_audit_batches` row to track the campaign's batch.
3. For each `content_pages` row in the batch:
   - **Homepage:** look for the most recent `entity_audits` row for this
     contact_id with `status='complete'` and `created_at >= now() - 30 days`.
     - **Found:** copy `surge_raw_data` and parsed fields into the homepage
       content_page; set `surge_status='complete'` immediately. No agent fire.
     - **Not found or stale:** queue a fresh Surge via the existing
       `trigger-content-audit` flow. (Note: Chris's plan is that signup already
       triggers an entity audit for paid clients, so stale should be rare.)
   - **Service pages:** queue Surge via existing `trigger-content-audit`.
4. Return batch status to the admin so the UI can show progress.

Concurrency: the agent VPS runs one Surge at a time (OOM constraint). The lock
endpoint enqueues all at once but the agent processes sequentially. Wall time
for a 5-page client: ~30-60 minutes of background work.

**Migration check needed:** does `tracked_keywords` already have `is_locked`,
or do we add it? Check before chunk 3.

### 4. Pagemaster overhaul — `api/generate-content-page.js` (existing, modify)

Two changes:

**Change A — read the contract.** Before composing the prompt, look up the
active `client_design_contracts` row for this contact. If found, include the
contract in the system/user prompt as authoritative reference for tokens,
voice, copy_conventions. This is where the speedup on subsequent pages comes
from: Pagemaster doesn't have to rediscover what's already locked in.

**Change B — separate schema from HTML.** Today the generator writes only
`generated_html`. With this change:

- Generator outputs both an HTML body AND a JSON-LD schema array, as separate
  artifacts in the response.
- Save HTML to `generated_html` (no inline `<script type="application/ld+json">`).
- Save schema to `schema_jsonb` (array of JSON-LD blocks: Organization, Person,
  Service per modality, FAQPage, etc., based on `schema_recommendations`).
- This way, when the future client-edit agent rewrites HTML, schema is
  untouched. The render layer stitches them at serve time.

Prompt structure (sketch):

```
SYSTEM: You produce the page HTML body AND the schema blocks as two separate
        outputs. Never embed JSON-LD in the HTML. Schema goes in the schema
        array. Output JSON: { "html": "...", "schema": [ {...}, {...} ] }

USER:   Build a page for this client.
        DESIGN_CONTRACT (or DESIGN_SPEC if no contract): {...}
        PAGE_BRIEF: { type, slug, target_keyword, page_name }
        RTPBA: ...the RTPBA markdown...
        SCHEMA_RECOMMENDATIONS: { blocks: [ {...}, {...} ] }
        CLIENT: { name, address, phone, credentials, ... }
```

### 5. Render layer — `api/render-page-preview.js` (existing, modify)

Today renders just `generated_html`. Update to:

1. Read `generated_html` and `schema_jsonb`.
2. Inject each schema block as `<script type="application/ld+json">…</script>`
   in the `<head>` at serve time.
3. Inject the HTML body as the page body.

This is where the schema becomes "live" on the page. Before this point it's
just stored data.

### 6. Polish stage reads contract — `api/_lib/page-stage.js` (existing, modify)

The polish prompt currently rediscovers tokens from `design_specs`. When an
active contract exists, polish should reference it as authoritative — fewer
findings, less work, faster runs.

Same for clarify and harden if relevant. Audit and critique stay
contract-agnostic — they should evaluate the page on its own merits.

### 7. Admin UI — `admin/pages-chain/index.html` (existing, modify)

Three additions:

- **Lock-and-fire button** at the top of the page list. Disabled until intro
  call complete and ≥1 page selected. Click → POSTs to lock-target-pages,
  shows batch progress strip.
- **Per-page Surge status pill** on each card (queued / running / complete /
  failed). Pulls from `content_pages.surge_status`.
- **RTPBA snapshot tab** on the expanded card. Shows the parsed RTPBA so admin
  can see what Pagemaster will use as the content seed before Generate Draft.
- **Variance score badge** on the card header (e.g., "Variance: 37/100" with a
  color-coded band).

### 8. Documentation

This doc, plus inline comments in the parser and generator.

## What we're NOT building

- **Service-page blueprint task explosion.** Per Chris's direction, only the
  homepage entity audit's tasks become tracked tasks. Service-page Surge audits
  are used purely for content + schema. The blueprint phases are parsed and
  displayed (so admin sees the Surge findings) but not turned into actionable
  tasks per page.
- **Cluster synthesis as a hard requirement.** Surge multi-page synthesis is
  parsed when present. When absent, basic interlinking rules apply (every
  service page links to homepage and 2 sibling services).
- **Sitemap management.** Lives in the existing crawler system
  (`sitemap_scouts`, `site_map_pages`). We work from the content_pages that
  exist; we don't manage the sitemap from this admin.

## Future work (not this iteration)

- Dynamic chain: have audit's findings drive which subsequent stages run
  (e.g., skip harden when audit shows no mobile/FOUT issues). Today the chain
  is static; making it dynamic is a follow-up.
- Re-parse historical Surge audits with newer parser versions when the parser
  improves. The `parser_version` field on parsed output enables this.
- Bulk "Run chain on all eligible pages" action. Today admin runs each page
  individually via Run buttons. After homepage clears, parallel chain runs
  across service pages would save admin time. Adding this is small; deferred
  until the pipeline is validated end-to-end.

## Open questions / decisions to revisit

- **`tracked_keywords.is_locked`:** does it exist? Need to check before chunk 3.
- **Stale entity audit threshold:** 30 days. Easy to change.
- **Schema block curation:** Pagemaster decides which schema_recommendations
  to actually include. Is that always correct, or should there be a curation
  pass? For now: Pagemaster decides; admin can re-run if needed.
