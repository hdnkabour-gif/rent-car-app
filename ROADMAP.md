# Roadmap

## Phase 0 — Foundation and validation
- Confirm company workflows, role matrix, contract/document requirements and company profile fields.
- Preserve full requirements and acceptance criteria in `PROJECT_DETAILS_AND_ACCEPTANCE.md`.
- Establish repository conventions, architecture, schema, security baseline and contributor instructions.
- Confirm staging/production separation and the local-hosted production direction.
- Use synthetic or minimized, consented test data only.
- Validate target hosting hardware and company IT/VPN policy before production setup.

## Phase 1 — Early usable MVP (small, testable slices)

### Slice 1 — Application foundation — **done (tested)**
Authentication, session handling, manager/employee roles, server-enforced permissions, company profile settings, audit baseline and responsive app shell.

### Slice 2 — Fleet, customers and documents — **done (tested)**, except the WhatsApp batch upload
Vehicle CRUD/search/status; customer CRUD/search; private multi-file upload from phone and desktop; original-file preservation; basic document linking; manual WhatsApp attachment batch upload.

### Slice 3 — Reservations — **done (tested)**
Reservation lifecycle, date/time validation, vehicle conflict prevention, change/cancellation history and basic operational dashboard.

### Slice 4 — Rental execution — **done (tested)**; PDF via browser print (D-041)
Contract PDF preview/print/archive using company settings; signed paper remains the official executed contract initially; additional drivers; check-out/check-in; mileage, fuel, condition evidence and damage history.

### Slice 5 — Financial operations and reminders — **done (tested)**: ledger, expenses, daily cash closing, reports + CSV, wa.me reminders; maintenance by km/date also delivered
Payments, deposits, refunds and expenses with traceable ledger; deposit/revenue separation; search and basic reports; prefilled `wa.me` reminders with employee review and manual sending.

Each slice must be demonstrated and tested before moving on. Do not bundle all MVP functionality into one unreviewed delivery.

## Phase 2 — Document intelligence and operational controls
- OCR classification/extraction, batch processing and mandatory human review.
- Evaluate OCR against 20–30 representative, permitted and minimized documents, including Arabic and French.
- Exact/probable duplicate document detection and review queue.
- Controlled customer-record matching/merge with audit trail.
- ~~Contract extensions and change history~~ — done in slice 4.
- Document expiry alerts, maintenance and reminders — done.
- Operational/financial reports and exports — first version done (slice 5).

OCR failure must never block manual document attachment or entry.

## Phase 3 — Integrations and scale
- WhatsApp Business API after provider/business approval and privacy review.
- GPS integration, advanced multi-branch workflows and advanced reporting.
- AI-assisted damage comparison only after validated data and human-review design.
- Electronic signature only after legal and business validation.
- Public customer booking and online payments require a separate explicit scope decision.

## Deployment path
- Development/staging: isolated test environment; synthetic data only.
- Current company PC: development/testing only (Intel Core i5-650, 8 GB RAM, 512 GB SSD); not a production host and not for real customer documents.
- Production: newer dedicated company host, minimum 16 GB RAM, SSD (1 TB preferred), supported OS, wired LAN and UPS.
- Production database and private document storage remain on the company host. Inside access uses company Wi-Fi; remote access uses an approved VPN. Never expose database ports directly to the internet.
- Keep deployment portable and document backup/restore and migration.

## Release gates
No phase is production-ready until acceptance tests pass, access controls are reviewed, migrations are verified, backup/restore is tested, privacy/security risks are documented and a responsible company owner approves release.
