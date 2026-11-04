# Changelog

## Unreleased

### Slice 4 — contracts, hand-over and return, deposits (branch `feat/slice-4-contracts`)
- Migration `0007_contracts` (additive): company phone2, logo file, rental rules (min driver age 18, new-licence years, max contract days, late tolerance); customer profession, other address, ID issue date; versioned `contract_templates` (starting template neutral); `contracts` with frozen snapshot, `contract_drivers`, `contract_photos`, `contract_events`, append-only `payments` ledger; permissions `contracts.read/manage` (manager + employee), `contracts.templates`, `payments.record`, `payments.reverse`, `deposits.refund`, `deposits.retain`.
- Check-out from a confirmed reservation: only an inspected available vehicle; km, fuel, washing, handed documents, observations, other drivers, photos, payment and deposit; vehicle → rented, reservation → in progress.
- Contract page: money (total, paid, rest, deposit held/returned/kept — deposits never counted as paid rent), payments, refund/keep deposit with rights and reason, corrections by reversal, extension, return with late time and proposed extra days (manager decides), signed paper scan, photos, history.
- Printable contract modelled on the company's paper contract (bilingual labels, front + back), PDF via browser print.
- Contract template page: the manager edits title, handed documents, clause and articles; every save is a new version.
- Driver rules: under the minimum age refused; missing birth date, new licence and over-long rental warned.
- Company logo upload. Contracts on the customer and vehicle cards; home tile (vehicles out, late, returns today); "Contrats" in the bottom bar (Clients moved to "Plus").
- Seed guard: the migration's default template row is configuration; a template saved by a person still blocks seeding.

### Slice 3 — reservations, data durability and isolation (branch `feat/slice-3-reservations`)
- Migration `0005_no_delete_business_data`: DELETE and TRUNCATE are refused by the database on every business table.
- Migration `0006_reservations` (additive): vehicle price per day and usual deposit (integer centimes); `reservations` with a GiST exclusion constraint (no overlapping active reservations per vehicle), append-only `reservation_events`; permissions `reservations.read`, `reservations.manage` (manager + employee) and `pricing.change` (manager, delegable).
- Reservations API and screens: list (upcoming, today's departures, today's returns, past), search by reference / customer / plate, booking form with live price preview and warnings, detail with history, change, cancel, no-show, reopen; reservations on the customer and vehicle cards; home tile; a vehicle with upcoming reservations cannot be retired.
- Backup tools: `backup`, `verify-backup`, `restore-backup` (empty database only, with proof), `check-files`; procedure in `BACKUP_RESTORE.md`.
- Guard test: the server never calls another service; the browser may only talk to this server.
- History page names the reservation, customer, vehicle or branch concerned.

### Slice 2c — customers (branch `feat/slice-2c-customers`)
- Migration `0004_customers` (additive): `customers`, `customer_documents`; permissions `customers.read`, `customers.manage` (manager and employee), `customers.verify`, `customers.block` (manager, delegable).
- Customer records for residents (CIN), Moroccans living abroad and tourists (passport): identity, contact, ID document, driving licence, notes; companies with ICE and contact person.
- Phone numbers stored as typed plus a normalised international key (Moroccan 06/07 numbers get 212; Arabic-Indic digits accepted). Search by name, e-mail, part of the phone in any format, or document number.
- Possible duplicates (same phone, ID or licence number) are shown before saving; staff must confirm it is another person. Nothing is merged.
- "Do not rent" flag with mandatory reason, lifting with reason, both audited.
- Customer scans (CIN front/back, passport, licence, residence permit, other) with human review; the same file on another customer is flagged. Scans are served only for their customer.
- Expiry status of the ID document and licence (expired / within 30 days) on the list and card, with filters.
- Audit: customer actions with field names only, never identity numbers or phones. History page now names the customer, vehicle or branch concerned.
- Forms no longer show the server's English validation text (vehicle, company settings, customer forms).

### Slice 2b — vehicle documents, photos, expiry alerts, account screens (branch `feat/slice-2b-documents`, not yet committed)
- Migration `0003_vehicle_documents_files` (additive): vehicle first registration date; `stored_files` (metadata of private files, immutable, never deleted); `vehicle_documents` (type, name, number, issuer, issue/expiry dates, notes, scan, archive); `vehicle_photos`; new delegable permission `vehicles.documents` (manager by default).
- File storage behind an adapter (`server/src/storage`): local disk, random content-addressed names, atomic write, type detected from the bytes and checked against the declared type, size limit `MAX_UPLOAD_MB` (default 10), identical files stored once. Files are served only to users who can see the vehicle, with `no-store`, `nosniff` and a sandbox CSP.
- APIs: vehicle documents (list, add, edit, archive with reason, attach/replace scan), photos (add one per request, idempotent on retry; archive), file download; fleet filter `docs=alert`; home summary counts expired / soon-expiring documents.
- Screens: documents and photos sections on the vehicle page (phone or computer, several photos at once with retry), "document expired / to renew" badges on the vehicle and fleet cards, filter "Documents à renouveler", alert on the home screen; first registration date in the vehicle form; "Mon compte" (change own password, sign out everywhere); team page: role change and password reset; login explains a malformed e-mail instead of "fields in red". FR/AR texts.
- Fix: `.gitignore` rule `storage/` (for uploaded data) also hid the storage source folder; the source folder is now explicitly included.

### Slice 2a — branches, delegated permissions and fleet (branch `feat/slice-2a-fleet`, not yet committed)
- Recorded the owner's business answers in `docs/BUSINESS_RULES.md` (BR-01 to BR-16) with the open questions.
- Migration `0002_branches_fleet`: branches, employee branch assignment, delegable permissions and individual grants, vehicles, transitions table enforced by trigger, append-only vehicle status history. Additive only.
- APIs: branches (list/create/edit), vehicles (list with plate/model search and filters, summary, detail with allowed actions and history, create, edit, state transitions), user branch assignment and grants.
- Screens: fleet list with search and status filters, vehicle card with guided actions and inspection (mileage, fuel, cleaning), add/edit vehicle, branches, team access panel, "Plus" page on phones, real fleet counts on the home screen; FR/AR texts.
- Plates are always displayed in written order (number – Arabic letter – region), in LTR and RTL pages; search tolerates spaces, separators, Arabic-Indic digits, alef variants and tatweel; no Arabic→Latin mapping yet.
- Test safety: fresh database per test run, wipe bound to that database only, cleanup even on failure. seed:dev: no marker bypass, insert-only accounts, refuses any database with business data.
- Build: `server/dist` is deleted before each build and nothing is emitted on TypeScript errors.
- Railway demo preparation (not deployed): `.railway/railway.ts` (railway@3.16.0, pinned), guarded `seed:demo` (explicit flag, explicit database name, blank database only, 20-character random passwords), shared fictitious-company fixtures for `seed:dev` and `seed:demo`, guide `docs/RAILWAY_DEMO.md`.
- Fixes found during review: denied-transition audit was lost on rollback; English text in vehicle history; phone layout overflow in Arabic; reversed large plate on the Arabic vehicle page.

### Review hardening and CI (branch `fix/slice-1-hardening-ci`)
- The test wipe is self-contained: `wipeTestDatabase()` re-checks the target identity (configured `TEST_DATABASE_URL`, local, `*_test`, not `DATABASE_URL`, matching `current_database()`) and the content on the same connection that runs the `DROP`.
- The content check now covers all schema objects (relations including sequences and views, functions, user types and domains, extensions) and refuses extra schemas.
- `seed:dev` is default-deny for operational data. Any non-foundation table with rows blocks seeding unless `seed:dev` created the database (marker table). Synthetic-accounts-only still applies.
- Added GitHub Actions CI (`.github/workflows/ci.yml`): `npm ci`, typecheck, lint, backend + frontend tests, migration idempotence check and build on a disposable PostgreSQL 16 service.

### Slice 1 review fixes (branch `fix/slice-1-review`)
- Test database protection: the tests refuse to wipe a database unless it is local, named `*_test`, different from `DATABASE_URL`, and either empty or marked by the test suite. The check runs before every wipe, not only at startup (`server/src/db/target-guard.ts`).
- `seed:dev` protection: requires `NODE_ENV=development` exactly, a local `*_dev`/`*_test` database, and refuses if any non-`@example.test` account exists. Exits with code 1 when refused.
- Login rate limiter counts failed attempts only, so a whole office behind one address can still log in. Its in-memory limits and the production gate are documented in `SECURITY.md`.
- Added automated FR/AR checks that the History and Team pages never show UUIDs, internal action codes or role codes.
- Added `docs/USABILITY_TEST_PLAN.md` for the real-employee test required by acceptance criterion 29.

### UX requirement and slice 1 interface refresh
- Recorded the owner requirement that the application is simple, modern, elegant and understandable for Moroccan staff: `docs/UX_GUIDELINES.md`, spec section 7a, acceptance criterion 29, decision D-024 and tracker item F-030.
- Rewrote French and Arabic wording in plain language ("Accueil", "Mon entreprise", "Équipe", "Historique" / "الرئيسية", "مقاولتي", "الفريق", "السجل"); no internal codes or ids are shown to staff.
- New login screen with one-tap FR | العربية switch and show/hide password; the dashboard has a greeting, today's date and upcoming modules.
- Phone bottom navigation bar and desktop side menu, both with icons and text labels; the header uses the company trade name and colour from company settings.
- Company settings use lists instead of free text (country, currency in DH, time zone), with help text next to fields, field errors in FR/AR and a save bar that is always visible.
- Team page shows cards with inline confirmation before deactivating; history shows readable actions and the affected person's name (API now returns `targetName`).
- Self-hosted Inter and Noto Sans Arabic fonts (npm packages, no CDN); lucide icons.
- Fixed: the password field's accessible name included the show-password button label.

### Slice 1 — application foundation (branch `feat/app-foundation-slice-1`)
- Added npm-workspaces monorepo: `server/` (Node.js 22, TypeScript, Express 5, PostgreSQL) and `web/` (React 19, TypeScript, Vite).
- Added forward-only SQL migration runner with checksums and advisory lock; migration `0001_foundation` creates roles, permissions, role_permissions, users, sessions, company_settings and append-only audit_logs.
- Added login/logout/logout-all, database-backed opaque sessions (SHA-256 hashed tokens, idle + absolute expiry, revocation), scrypt password hashing, account lockout, login rate limiting and CSRF protection.
- Added server-side permission middleware for manager/employee roles; denied attempts are audited.
- Added staff account administration API with last-manager and self-lockout protection.
- Added company settings API (Moroccan identifiers ICE/IF/RC/Patente, MAD, Africa/Casablanca, FR/AR document languages, branding fields).
- Added audit log API and sanitisation of audit metadata (no passwords, tokens or identity-document values).
- Added health and database-health endpoints, centralised JSON errors, request IDs, structured logs without bodies/query strings, security headers (CSP without external sources).
- Added frontend login, permission-based app shell, dashboard placeholder, company settings (read-only for employees), users and audit log screens; French/Arabic with RTL; loading/empty/error states; PWA manifest; no CDN assets.
- Added `docs/LOCAL_DEVELOPMENT.md` (Windows setup without Docker) and `docs/API.md`.
- Logo upload is deferred to slice 2 (needs the private file-storage adapter).

### Documentation baseline
- Established project documentation baseline.
- Added repository hygiene rules: ignore secrets, local data, uploads, databases and build artifacts.
- Added contributor instructions prohibiting direct work on main, use of real customer data in development, unsupported test claims and unapproved deployment.
- Expanded detailed workflows and MVP acceptance criteria, including vehicle/customer/contract fields, additional drivers, contract extensions, duplicate detection and controlled customer merge.
- Recorded staging-only use of the current company PC and the target production host profile (newer device, minimum 16 GB RAM).
- Recorded local company hosting, Wi-Fi access onsite and VPN access remotely.
- Clarified that signed paper contracts remain official initially; PDF is for preview, printing and archiving.
- Clarified manual WhatsApp attachment upload and employee-reviewed wa.me reminders; WhatsApp Business API remains deferred.
- Split the MVP into small, testable delivery slices and aligned OCR to Phase 2 after the upload foundation.
- (Documentation baseline contained no application code.)
