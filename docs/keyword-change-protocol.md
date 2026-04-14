# Keyword Change Protocol

**Last updated:** April 14, 2026

## When This Applies

Any time a client wants to add, remove, or swap a tracked keyword after the initial setup is complete and the keyword has been activated in downstream systems (content pages, LocalFalcon campaigns, reporting).

This is expected to be rare: once or twice per year per client at most, typically driven by the client pivoting their specialty focus or dropping a service line.

## Who Can Initiate

Clients cannot initiate keyword changes on their own. The process is always:

1. Client communicates the change to Karen or Scott
2. Karen/Scott flags it to Chris
3. Chris executes the change following this protocol

## Why Keywords Lock

Once a keyword is activated, it creates dependencies in two pipelines:

**Pagemaster Content Pipeline**
- Surge content audits run against the keyword
- Design specs and HTML pages are generated from audit data
- Changing the keyword orphans all existing audit data and generated content

**LocalFalcon Reporting Pipeline**
- Campaigns track the keyword across 6 platforms (Google, Apple, AI Mode, GAIO, ChatGPT, Gemini)
- Monthly scans build historical trend data
- Changing a keyword resets the trend history (no way around this with LF architecture)

The admin UI shows a lock icon next to any keyword with active content pages or when the client has LocalFalcon campaigns configured. Locked keywords cannot be deleted through the UI.

## Change Checklist

When executing a keyword change, follow every step in order:

### 1. Document the Change
Add a note to the client record (activity log or notes field) explaining:
- What keyword(s) are being retired
- What keyword(s) are replacing them (if any)
- Why (client request, niche pivot, etc.)
- Date of the change

### 2. Retire the Old Keyword
In the database, set `retired_at = now()` and `retired_reason` on the tracked_keyword record. Do NOT delete it. The audit history and any generated content remain accessible for reference.

```sql
UPDATE tracked_keywords 
SET retired_at = now(), retired_reason = 'Client pivoted to [new focus]'
WHERE id = '[keyword_id]';
```

### 3. Handle Existing Content
For each content page built from the retired keyword, decide:
- **Keep live:** If the page still has SEO value, leave it. Just note it is no longer being actively updated.
- **Flag for review:** Set `stale = true` on the content_page so it shows up in review queues.
- **Mark for removal:** If the content is now irrelevant, coordinate with the client before removing.

### 4. Seed the New Keyword
Add the replacement keyword to `tracked_keywords` via the admin UI (Intro Call or Reports tab). Set the appropriate priority, target page URL, and page status.

### 5. Kick Off Surge Audit
If the new keyword needs content, create a content audit batch to get fresh Surge data for the new keyword.

### 6. Handle LocalFalcon Campaigns
This is the most impactful step. LF campaigns cannot be renamed, only created/deleted.

- **Delete the old campaigns** for the retired keyword (or reconfigure them if LF supports keyword changes on existing campaigns)
- **Create new campaigns** for the replacement keyword with the standard config (google+apple 7x7, aimode+gaio+chatgpt+gemini 3x3, all 5mi, monthly 28th 6AM UTC)
- **Update `report_configs.lf_campaign_keys`** with the new campaign keys
- **Accept the trend data reset.** Add a note in the next monthly report narrative explaining the keyword change so the gap in trend data is not confusing.

**Credit budget:** Creating 6 new campaigns adds ~670 credits/month to the LF bill. If you are also retiring 6 old campaigns, the net change is zero. If adding keywords without retiring, budget accordingly.

### 7. Verify Reporting Config
Confirm that `report_configs` for the client has the correct:
- `lf_campaign_keys` (updated in step 6)
- The new keyword is set as P1 if it should appear in reports

### 8. Confirm with Team
Let Karen know the change is complete so she can communicate timing expectations to the client (first Surge audit data in ~24h, first LF scan on the 28th, first report reflecting the new keyword in the next monthly cycle).

## Notes

- Old keywords are never hard-deleted. The `retired_at` timestamp preserves all historical data.
- The UI filters out retired keywords automatically (they do not appear in active keyword lists).
- Content pages built from retired keywords remain accessible but will show as tied to a retired keyword if viewed.
- Running old and new LF campaigns in parallel is possible but burns double credits. Given the Pro plan ceiling, retire before creating unless there is a specific reason to overlap.
