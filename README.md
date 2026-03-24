# Moonraker Insights

Private proposal and audit pages deployed via Vercel.

## URL Structure

```
insights.moonraker.ai (also: proposals.moonraker.ai)

/[prospect-slug]/proposal       → Sales proposals
/[client-slug]/audits/diagnosis → Audit diagnosis page
/[client-slug]/audits/action-plan → Audit action plan page
/[client-slug]/audits/progress  → Audit progress tracker
```

## Repo Structure

```
moonraker-insights/
├── _templates/
│   ├── proposal.html
│   ├── diagnosis.html
│   ├── action-plan.html
│   └── progress.html
├── [prospect-slug]/
│   └── proposal/index.html
├── [client-slug]/
│   └── audits/
│       ├── diagnosis/index.html
│       ├── action-plan/index.html
│       └── progress/index.html
├── assets/
├── shared/
├── index.html
└── vercel.json
```

## Projects

- **Sales Assistant** — manages proposals (`/[slug]/proposal/`)
- **Audit & Reporting Assistant** — manages audits (`/[slug]/audits/`)

Last updated: 2026-03-25
