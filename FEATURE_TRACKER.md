# Feature Tracker
Status vocabulary: Proposed → Planned → In progress → Implemented → Tested → Accepted. Use Deferred only with a reason and target milestone. Implemented does not mean accepted.

| ID | Feature | Priority | Target | Status |
|---|---|---|---|---|
| F-001 | Authentication and session security | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-002 | Manager/employee roles and API permissions | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-003 | Company profile and document branding | P0 | MVP slice 1 | Tested (slice 4) — logo upload done (M-19), printed on contracts with ICE, IF, RC, address and two phones; second phone and rental rules (min age, new licence, max days, late tolerance) in settings |
| F-004 | Vehicle fleet CRUD, status and search | P0 | MVP slice 2a | Tested (automated + browser, local; awaiting review) — vehicle lifecycle with DB-enforced transitions, status history, inspection (mileage, fuel, cleaning), plate search; slice 2b adds first registration date, vehicle documents (registration card, insurance, technical inspection, vignette, transport authorization, other) with number, issuer, dates, scan and archive history, and a vehicle photo gallery; photos *at check-out/return* come with slice 4 |
| F-005 | Customer records and document links | P0 | MVP slice 2 | Tested (automated + browser, local; awaiting review) — slice 2c: individuals and companies (ICE), residents / MRE / tourists (BR-11), phone(s) with wa.me-ready key, ID document (CIN, passport, residence permit, other) with number, country and expiry, driving licence, notes; search by name, part of the phone in any format, document number; possible-duplicate warning (phone, ID or licence number) with explicit confirmation, never merged; "do not rent" flag with reason; scans of ID/passport/licence with human review (to check / verified / rejected with reason). Rental history appears with reservations/contracts |
| F-006 | Reservations and vehicle/date conflict prevention | P0 | MVP slice 3 | Tested (automated + browser, local; awaiting review) — booking with customer, vehicle, dates (Casablanca time), 24-hour days (BR-04), pickup/return place and return branch (BR-10), vehicle price and deposit, agreed price change only with `pricing.change` + reason (BR-06/BR-14, one right for change and discount for now), live preview with warnings (licence/ID expiring, vehicle in maintenance, no price), DATABASE exclusion constraint against overlaps (tested with 6 simultaneous requests), cancel / no-show / reopen with reason, full change history, lists for today's departures and returns; seasonal price list pending the owner's prices |
| F-007 | Contract PDF preview/print/archive; signed paper remains official initially | P0 | MVP slice 4 | Tested (automated + browser, local; awaiting review) — printable A4 contract modelled on the company's paper contract (front + general conditions on the back, FR/AR labels), from a frozen copy of the data and the template version used; PDF through the browser's print / "Save as PDF" (no server PDF engine); paper number recorded; scan of the signed paper attached as the official copy (D-015) |
| F-008 | Check-out/check-in with mileage, fuel and photos | P0 | MVP slice 4 | Tested (automated + browser, local) — check-out only for an inspected available vehicle, km (never lower), fuel, washing, handed documents, observations, photos; check-in with km, fuel, late time and proposed extra days (manager decides, BR-05), vehicle goes to "inspection pending" (BR-09) |
| F-009 | Payments, deposits, refunds and expenses ledger | P0 | MVP slice 5 | In progress (slice 4) — append-only ledger per contract: rental payments (cash/transfer), deposits received (cash/cheque/card hold/transfer), returned, kept with reason, corrections by reversal only; balances; rights `deposits.refund`, `deposits.retain`, `payments.reverse` delegable. Expenses and daily cash closing per branch done in slice 5 (cash, cheques, cards apart) |
| F-010 | Secure multi-file upload from phone and desktop | P0 | MVP slice 2 | In progress (slice 2b) — storage adapter (local disk, random content-addressed keys, immutable originals), type detection from file bytes (JPEG/PNG/WebP/PDF), size limit, branch-scoped download; used for vehicle documents and photos (several photos at once, retry) and customer document scans (slice 2c). WhatsApp batch upload (F-015) still to do |
| F-011 | OCR classification/extraction with human approval | P1 | Phase 2 after upload foundation | Planned |
| F-012 | Maintenance records and reminders | P1 | Phase 2 | Tested (slice 5) — plans by km and/or months, due/soon alerts, work records by external garage booking the expense; reminders are on-screen (no automatic messages) |
| F-013 | Document expiry alerts | P1 | Phase 2 | In progress (slice 2b, moved earlier on owner request) — vehicle documents: expired / expiring within 30 days (Casablanca calendar) on the vehicle, fleet list (with filter) and home screen. Customer ID/licence expiry comes with customers; no automatic messages |
| F-014 | Operational and financial reports | P1 | Phase 2 | Tested (slice 5) — period summary (income, deposits apart, expenses, result, outstanding, utilisation) and CSV exports; more reports on request |
| F-015 | Manual WhatsApp attachment batch workflow | P1 | MVP slice 2 | Planned |
| F-016 | WhatsApp Business API ingestion/automation | P2 | Later | Deferred |
| F-017 | GPS tracking | P2 | Later | Deferred |
| F-018 | AI-assisted damage comparison | P2 | Later | Deferred |
| F-019 | Advanced AI analytics | P2 | Later | Deferred |
| F-020 | Multi-branch operational controls | P0 | Moved to slice 2a (BR-02, D-026) | In progress — branches, employee branch assignment and branch-scoped vehicle access tested; branch scope for reservations/contracts/cash comes with those slices |
| F-021 | Local company-hosted production with Wi-Fi access and remote VPN access | P0 | Deployment foundation | Planned |
| F-022 | Exact/probable duplicate document detection with human review | P1 | Phase 2 | In progress — identical files are recognised by SHA-256 and stored once (slice 2b); the same scan attached to two customers is flagged at upload, and possible duplicate customers (same phone, ID or licence number) are flagged before saving (slice 2c). Probable (similar, not identical) image matching not started |
| F-023 | Controlled customer-record merge with audit trail | P1 | Phase 2 | Planned |
| F-024 | Rental contract extension and revised return date/price history | P1 | Phase 2 | Tested (slice 4, moved earlier) — extension re-checks the vehicle's next booking, adds days at the agreed price, recorded in the contract history |
| F-025 | Additional drivers linked to a rental contract | P1 | MVP slice 4 | Tested (slice 4) — up to 3 other drivers with licence and CIN details, printed in "Autre conducteur" |
| F-026 | Prefilled wa.me reminders with employee review and manual send | P1 | MVP slice 5 | Tested (slice 5) — pickup, return and document reminders with wa.me link, sent and confirmed by the employee |

| F-027 | Append-only audit log of sensitive actions | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-028 | Staff account administration (create, role change, deactivate, password reset) | P0 | MVP slice 1 | Tested (automated + browser, local; awaiting review) — UI now also has role change (last-manager refusal explained), password reset by the manager and "Mon compte" (own password, sign out of all devices) (M-18 done in slice 2b) |
| F-029 | Responsive app shell, French/Arabic UI with RTL | P0 | MVP slice 1 | Tested (component + browser checks; awaiting review) |
| F-030 | Simple, modern UX for Moroccan staff (plain FR/AR wording, Moroccan formats, phone-first, company branding) | P0 | All slices | In progress — guidelines written; slice 1 screens updated; real-employee usability session pending (`docs/USABILITY_TEST_PLAN.md`) |
| F-032 | Data durability: no deletion at database level, verified backups of database + files, restore drill tool, live file integrity check | P0 | Slice 3 (owner priority 2026-11-04) | Tested (automated + CLI drill, local) — encryption, run recording, manager alert and scheduling templates added (audit 2026-11-05); the actual schedule, off-site copy and Windows restore drill must be set up on the company host |
| F-033 | Company data isolation: no outbound calls from the server, browser limited to this server, no third-party scripts | P0 | Slice 3 (owner priority) | Tested (automated guard test) |
| F-034 | Contract template per company (title, handed documents, responsibility clause, general conditions articles), versioned; each contract keeps its version | P0 | Slice 4 (owner request BR-17) | Tested (automated + browser) |
| F-035 | Company-branded (white-label) look: company name, logo and colour on every screen including login, tab title and favicon | P0 | Owner request 2026-11-04 | Tested (automated + browser) |
| F-031 | Delegated permissions: the manager grants specific rights to an individual employee (only rights the manager holds) | P0 | Slice 2a (BR-14, D-027) | Tested (automated; awaiting review) — vehicle rights now; finance rights (discounts, price changes, deposit refunds/retentions) come with slices 4–5 |

### Slice 5 evidence (branch `feat/slice-5-cash-maintenance`, local)
- Server 227/227 (incl. 6 slice-5 tests: expenses + IDOR receipt case, cash closing, maintenance, reminders, reports/CSV), web 67/67, typecheck, lint, build.
- Browser walkthrough (manager desktop FR + employee phone AR): 17/17, no 5xx, console or external requests.

### Audit fixes evidence (branch `feat/audit-fixes-p0`, local)
- Server 221/221 (incl. extension permission, other-driver age, min-age constraint, encrypted backup + restore, backup-run alerts), web 62/62, typecheck, lint, build: see TEST_PLAN for the final run.
- Not verifiable from here: Railway dashboard settings (branch, volume, `STORAGE_DIR`, PostgreSQL networking).

### Branded UI + late-fee evidence (branch `feat/branded-ui-late-fees`, local)
- Server 217/217, web 59/59, typecheck, lint, build: passed.
- Full browser walkthrough of every page and the main operations (manager desktop FR + new employee phone AR, synthetic data): 49/49 checks, 0 server errors, 0 console errors, 0 external requests.

### Slice 4 evidence (branch `feat/slice-4-contracts`, local)
- Server 214/214 (incl. 11 contract tests), web 55/55, typecheck, lint, build: passed.
- Browser walkthrough (desktop FR + phone AR, synthetic data): 17/17 after fixes found by it (template confirmation disappeared; vehicle status not shown when booking; deposit refund defaulted to cash for a cheque; printed plate order; label overlap and a 3-page print). Printed PDF: 2 A4 pages (front + conditions).
- Not yet run: real printer, real phones, Windows; customer and owner review of the printed layout.

### Slice 3 evidence (branch `feat/slice-3-reservations`, local)
- Server 202/202 (incl. 12 reservation, 4 backup/restore and 3 data-isolation tests), web 48/48, typecheck, lint, build: passed.
- Browser walkthrough (desktop FR + phone AR, synthetic data): 15/15 after two fixes found by it (history did not name reservations; wording on the reservation card).
- Backup/restore CLI drill on synthetic `fleetora_demo_dev`: passed (see `BACKUP_RESTORE.md`).
- Not yet run: on the company host / Windows; seasonal pricing (waiting for the owner's price list).

### Slice 2c evidence (branch `feat/slice-2c-customers`, local)
- Server 183/183, web 40/40, typecheck, lint, build: passed on the current working tree (Linux container, Node 22, PostgreSQL 16).
- Browser walkthrough (Playwright Chromium, desktop FR + phone AR, synthetic `fleetora_demo_dev`, synthetic PDF scan): 18 checks, 0 failures after one fix (a search with letters was also matched against phone digits).
- Not yet run: real phones, real-employee usability session; customer expiry alerts on the home screen (only on the customer card, list and filter).

### Slice 2b evidence (branch `feat/slice-2b-documents`, local, not yet committed)
- Server 169/169, web 31/31, typecheck, lint, build: passed on the current working tree (Linux container, Node 22, PostgreSQL 16).
- Browser walkthrough (Playwright Chromium, desktop FR + phone AR, synthetic `fleetora_demo_dev`, synthetic PNG/PDF files): 22 checks, 0 failures.
- Not yet run: CI on GitHub (not pushed), Windows 11, real phones (camera upload), real-employee usability session, Railway with a volume.

### Slice 2a evidence (branch `feat/slice-2a-fleet`, local, not yet committed)
- Server 156/156 (incl. 7 seed:demo tests), web 19/19, typecheck, lint, build: passed on the current working tree (Linux container, Node 22, PostgreSQL 16).
- Browser walkthrough (Playwright Chromium, desktop FR/AR, phone AR): 23 checks, 0 failures, against the latest build and a fresh demo database.
- Not yet run: CI on GitHub (not pushed), Windows 11, real phones, real-employee usability session.

### Slice 1 evidence (branch `feat/app-foundation-slice-1`)
- Backend: 80 Vitest integration/unit tests against a real PostgreSQL 16 database, all passing.
- Frontend: 11 Vitest/Testing Library component tests, all passing.
- `npm run typecheck`, `npm run lint`, `npm run build`: all passed.
- Browser walkthrough (Playwright, Chromium, desktop 1280×800 + phone 390×844, FR + AR): 27/27 checks passed after the UX refresh.
- Environment: Linux cloud container, Node 22, PostgreSQL 16. **Not yet run on the Windows 11 test PC.**
- "Tested" here means automated tests passed. Nothing is Accepted until reviewed by the owner.

## Scope preservation
- The detailed workflows and acceptance criteria in `PROJECT_DETAILS_AND_ACCEPTANCE.md` are part of the project baseline.
- Features marked Deferred are postponed, not deleted.
- Update this table, the changelog and relevant decision documents whenever scope or status changes.
- Never mark a feature Accepted without evidence and the relevant acceptance tests.
