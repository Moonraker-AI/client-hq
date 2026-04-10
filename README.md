# Client HQ

Moonraker client lifecycle platform at [clients.moonraker.ai](https://clients.moonraker.ai)

## Architecture

Static HTML + Vercel serverless functions. No build step, no frontend framework.

- **Backend:** Supabase PostgREST (33 tables, RLS enabled)
- **API:** 39 CommonJS routes in `api/` + 3 cron jobs in `api/cron/`
- **Templates:** 12 HTML templates in `_templates/` deployed per client
- **Admin:** Password-protected dashboard at `/admin/`

## Shared Helper Modules

All API routes use shared helpers in `api/_lib/`:

```js
// Supabase PostgREST
var sb = require('./_lib/supabase');   // or '../_lib/supabase' from cron/
var rows = await sb.query('contacts?status=eq.active&select=*');
var one  = await sb.one('contacts?slug=eq.anna-skomorovskaia&limit=1');
await sb.mutate('contacts?id=eq.xxx', 'PATCH', { status: 'active' });
await sb.mutate('deliverables', 'POST', { contact_id: id, title: 'Setup' });
var hdrs = sb.headers('return=representation');

// GitHub file operations
var gh = require('./_lib/github');
var { content, sha } = await gh.readFile('slug/proposal/index.html');
var html = await gh.readTemplate('proposal.html');
await gh.pushFile('slug/report/index.html', html, 'Deploy report');
await gh.deleteFile('old/path.html', null, 'Cleanup');
```

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | System health check (Supabase connectivity + env var status) |
| `POST /api/action` | Generic CRUD proxy (33 allowlisted tables) |
| `POST /api/chat` | Claude chat proxy (Sonnet 4.6) |
| `POST /api/compile-report` | Monthly report engine (300s) |
| `POST /api/generate-proposal` | AI proposal generation (300s) |
| `POST /api/process-entity-audit` | Surge data processing (300s, NDJSON streaming) |

## Client Lifecycle

Lead > Prospect > Onboarding > Active (+ boolean `lost` flag)

## Conventions

- CommonJS (`module.exports`), raw `fetch`, no npm packages
- `var` declarations (not let/const) for consistency
- Functions called from `onclick` must be assigned to `window`
- Always fetch fresh SHA before GitHub PUT operations
- Use `api/_lib/supabase.js` and `api/_lib/github.js` for all Supabase/GitHub calls
