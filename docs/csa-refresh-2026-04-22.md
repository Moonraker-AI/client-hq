# CSA Refresh — 2026-04-22

Coordinated display-layer alignment with the 2D plan-tier schema already live on the `contacts` table, combined with a 9-point content pass on the Client Service Agreement.

## Plan naming

| Old display | New display | Tier keys (unchanged) |
|---|---|---|
| Annual Paid Upfront | **Annual Upfront** | `annual_upfront_ach`, `annual_upfront_cc` |
| Annual Paid Quarterly | **Annual Quarterly** | `annual_quarterly_ach`, `annual_quarterly_cc` |
| Annual Paid Monthly | **Annual Monthly** | `annual_monthly_ach`, `annual_monthly_cc` |
| Quarterly Upfront | **Flexible Quarterly** | `quarterly_upfront_ach`, `quarterly_upfront_cc` |
| Quarterly Paid Monthly | *(RETIRED — `active = false`)* | `quarterly_monthly_ach`, `quarterly_monthly_cc` |
| Month-to-Month | **Flexible Monthly** | `monthly_ach`, `monthly_cc` |

Tier keys are internal and unchanged; all 10 signed_agreements snapshots are unaffected (HTML frozen at signing time).

## CSA content changes

1. **Alteration.** Fully rewritten. Annual plans locked for 12 months; Flexible plans renegotiable after 90 days. Explicit reference to Commitment & Cancellation for exit paths.
2. **Mutual Confidentiality.** Rewritten in plain English. Two parallel paragraphs, one per party, plus a one-sentence survival clause.
3. **Account Access.** Added "or equivalent ownership or manager-level access where the platform does not offer an administrator role" to Client Ownership and Access Requirements paragraphs.
4. **Warranty.** Rewritten in plain English with parenthetical for the patent/trademark/etc. list.
5. **What Moonraker Does NOT Provide — hosting carve-out.** Website Infrastructure paragraph now includes an exception clarifying Moonraker hosts the site for Annual Upfront clients only; hosting of Client-owned or externally-built sites remains out of scope for everyone else.
6. **Pricing & Plans.** 5-plan structure matching the new naming. Annual Commitment (Upfront / Quarterly / Monthly) + Flexible (Quarterly / Monthly).
7. **Performance Guarantee.** Plan-name references updated. Still links to `/guarantee`.
8. **Additional Services & Add-ons.** Explicit availability rule (active Clients only, any plan). Explicit list of systems that do NOT extend to add-on pages: tracked keywords, monthly reporting, NEO image distribution, LiveDrive, citation refreshes, press release syndication.
9. **Statement of Work (endorsement bullet).** Clarifies Moonraker provides the endorsement system (template + per-clinician page + publication); Client is responsible for ongoing solicitation.
10. **Commitment & Cancellation.** Plan names updated; Quarterly Paid Monthly removed.
11. **Plan header labels.** Removed "Month-to-Month" language.

All emdashes removed from user-facing content.

## Code changes

- `shared/csa-content.js` — all of the above, pulls pricing from `pricing_tiers` via `/api/pricing`
- `_templates/checkout.html` — removed `quarterly_monthly` from BILLING_OPTIONS, added auto-skip for singleton billing step (quarterly → payment method directly), renamed Month-to-Month card title to Flexible Monthly
- `pricing_tiers` (DB) — 2 rows deactivated, 10 display names updated

## Commits

- `70d66a3` — csa: plan rename + 9-point CSA refresh
- `a35542a` — checkout: retire quarterly_monthly, rename Month-to-Month, auto-skip singleton billing

## Known follow-ups

- **Legacy `contact.plan_type` field.** Still used in the CSA header-label logic. Values `annual|quarterly|monthly` don't distinguish Annual Quarterly from Flexible Quarterly. Current code assumes `quarterly` means Flexible Quarterly. Worth auditing whether any Annual Quarterly clients have `plan_type='quarterly'` (they probably should have `plan_type='annual'`).
- **Service & Sales Reference Drive doc.** Updated separately with matching plan naming and pricing. Paste-in done by operator.
