# Fleet Management System

Internal vehicle-rental operations platform for a Moroccan car-rental company managing approximately 30–100 vehicles.

**Working product name:** Fleetora (provisional only; not a final brand or trademark decision). Product identity is independent from the rental company's configurable identity.

## Status (2026-11-05)
`main` is the reference branch (slices 1–5 merged with the owner's approval, PR #1). New work goes on task branches and reaches `main` only through a reviewed pull request approved by the owner; CI runs on every push to `main` and on every pull request.
Implemented and tested: foundation (accounts, sessions, roles and delegated rights, company settings, audit log, FR/AR), branches, fleet lifecycle, vehicle documents/photos and expiry alerts, customers with ID scans and review, reservations with database-enforced no-overlap, contracts (check-out, check-in, extension, late-return decision, printable contract modelled on the paper one), payments and deposits ledger, company-branded look, verified (optionally encrypted) backups, expenses and daily cash closing, maintenance by km/date, wa.me reminders, reports and accountant CSV exports, and a vehicle-first home screen.
Still to do before real company use: company host + VPN, scheduled backups there, a session with a real employee, review of the printed contract (see `FEATURE_TRACKER.md` and `docs/OWNER_TRIAL_AR.md`).
The Railway deployment is a **demo with fictitious data only** (D-030); real data stays on the company host (D-012).

## Getting started
See `docs/LOCAL_DEVELOPMENT.md` (Windows 11, no Docker required). API reference: `docs/API.md`.

```
npm install
npm run migrate
npm run create-manager -w server
npm run dev:server   # terminal 1
npm run dev:web      # terminal 2
```

## Principles
- Internal manager/employee system, not a public self-service booking marketplace.
- Responsive phone and desktop PWA; French and Arabic with RTL.
- Preserve original uploaded documents; OCR suggestions require employee review.
- Financial records must be traceable; deposits are not rental revenue.
- Security, privacy, backup/restore and tests are release requirements.
- Defer features explicitly; never silently discard them.

## Documentation
See PROJECT_MASTER_SPEC.md, FEATURE_TRACKER.md, ROADMAP.md, ARCHITECTURE.md, DATABASE_SCHEMA.md, SECURITY.md, TEST_PLAN.md, BACKUP_RESTORE.md, DECISIONS.md and CHANGELOG.md.

## Stack
React 19 + TypeScript + Vite (web), Node.js 22 + Express 5 + TypeScript (API), PostgreSQL 16 with versioned SQL migrations, private file storage behind an adapter (local disk), self-hosted fonts, no CDN. OCR is not implemented yet and will stay behind a replaceable adapter.

Never commit real customer documents, personal data, credentials, production exports or environment files.