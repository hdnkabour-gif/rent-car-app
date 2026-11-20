# Changelog

## Unreleased

### RC-03 — partial rental refund after a paid late fee is waived (issue #26; unmerged)
- New `POST /api/contracts/:id/payments/:paymentId/refund` (`payments.refund`, manager, delegable): gives back rental money the customer overpaid as ONE append-only `rental_refund` entry linked to the rental receipt, with a reason and an audit record
- Bounded by what is overpaid on the contract **and** what is left on that receipt; a repeated or concurrent refund is refused (`nothing_to_refund` / `refund_exceeded`); method cash or transfer only; deposits untouched
- Balances (`paidCents`, new `overpaidCents`), cash of the day (cash out), reports (rental income) and agenda subtract refunds; a reversal of a refund adds it back; a rental receipt with a standing refund cannot be reversed (`refunded_receipt`)
- Additive migration `0020_rental_refunds` (kind list grows, `refunds_id` column, link/reason/method checks, permission); pinned migration and delegable-permission inventories updated
- Synthetic API regression `test/rental-refund.test.ts` (7 cases, incl. two simultaneous refunds)

### RC-04 — identical expense receipt uploads by different employees (issue #26; unmerged)
- A single content-addressed blob is still stored once, while an append-only receipt claim grants each employee the right to attach bytes they actually uploaded through the expense receipt endpoint.
- New additive migration `0018_expense_receipt_upload_claims` preserves previously valid expense receipt associations without granting unrelated document access.
- Synthetic API regression covers two employees uploading the same receipt, a third employee without a claim being refused, and a customer document not becoming an expense attachment.
- Validation status: proposed branch implementation; CI and review required. No production deployment, restoration or real customer files.


### Off-site backups, retention and restore drills (branch `fix/offsite-backup-restore`, issue #14)
- **Off-site copy** after every backup: a detached folder (external disk / NAS) or a private S3-compatible bucket.
  - Only encrypted backups may leave the host.
  - Every object is checked after upload; a completion marker is written last.
  - Downloads are checked object by object; network errors are retried.
  - The backup job exits with 3 when the off-site copy fails (local backup kept).
- **Manifest authenticated** (format 2, HMAC from the backup key); optional non-secret `BACKUP_KEY_LABEL`.
- **Backup locations:** never inside `STORAGE_DIR`. In production, never on the same disk as the uploads and never unencrypted. `BACKUP_KEEP_LOCAL=false` turns the local folder into a staging area.
- **`prune-backups`:** retention 14 daily / 8 weekly / 12 monthly, minimum age 48 h, dry run by default.
- **`backup-drill`:** newest off-site copy → detached folder → new isolated database → every SHA-256 → 10 negative checks → dropped; JSON evidence with counts only.
- **Migration `0017_offsite_backups_drills`** (additive): off-site result per backup run; append-only `backup_drills`.
- **Manager alerts (FR/AR):** off-site copy missing or failed; restore drill missing, failed or older than 35 days. `BACKUP_OFFSITE_REQUIRED`, default production.
- **Dependency:** `@aws-sdk/client-s3` 3.1161.0.
- **Docs:** provider and secret plan, key recovery, schedule, cost (`BACKUP_RESTORE.md`), `.env.example` placeholders, `ops/` scripts.

### Dependency advisories and missing-file diagnostic (branch `fix/dev-advisories-missing-files`, issue #16)
- **`eslint` 10.15.0 and `typescript-eslint` 8.73.0** (vendors' fixes for `minimatch` < 11.0.1).
  - Full audit: 15 → 12, all 12 from `picomatch`; production audit still 0.
  - `picomatch` has no patched release, so its exposure is documented in `docs/DEPENDENCY_SECURITY_AUDIT_20261117.md`. Not forced.
  - CI prints the development audit as a non-blocking warning; the production gate stays blocking.
- **`npm run files-report`:**
  - classifies every stored file (ok / damaged / missing but in a backup / missing and in no backup) and lists which records use it;
  - read-only;
  - `--apply` restores only byte-identical files from a backup, never overwrites, never touches database rows, never invents content.

### OCR milestone 1 — framing, perspective, ID-card MRZ, licence labels (branch `feat/ocr-framing-mrz-td1`, issue #15)
- **Four-corner detection:** the document's corners are found on the photo and its perspective corrected to the expected aspect for its kind (ID-1 card, passport page, A4). OCR then reads the corrected document.
  - Quality is measured on the document itself at a normalised width, so the background no longer changes the blur score and a small card on a dark table is no longer "too dark".
  - New retake guidance (FR/AR): document edges not found; document too small (come closer).
  - An already-cropped image or a PDF scan gets no framing warning.
- **ICAO TD1 MRZ** (identity cards, 3 lines of 30), read on `id_back` / `residence_permit`.
  - Document number, birth date, expiry, sex, nationality and name are kept only when their check digit passes; a failed composite check lowers the confidence and adds a warning.
  - The optional data stay an unverified hint: which national number a country stores there is not assumed.
  - A conservative repair handles the typical OCR misreading of filler (`K` inside `<<<`), in data lines only, still guarded by the check digits.
- **Driving licence (front/back):** number, issue and expiry dates, and categories, only beside a known French/Arabic label. Confidence 0.4; never assumed.
- **Dates:** ISO `YYYY-MM-DD` next to labelled dates; MRZ dates with century rules.
- **App side:** framing info and ISO dates pass the bounded OCR schema (out-of-range values are rejected); FR/AR names for the new fields.
- **Unchanged:** every value is a suggestion; nothing is accepted automatically.
- **CI:** the OCR unit step installs the pinned OpenCV/numpy and fails if the geometry tests are skipped.
- **Integration-gate fixes on PR #25:**
  - **B25-1:** one shared scale factor when limiting to 2400 px. A 4000×2523 card used to become 2400×2400; it now keeps the ID-1 proportions in both orientations.
  - **B25-2:** a PDF page or an already-cropped image is **never** cropped. A detected outline is used only if its proportions match the document (±15%), so an inner table or photo is rejected. If a crop does happen and the reading is empty or weak, the whole image is read too and merged: a weaker value never replaces a stronger one, and a disagreement is flagged.
  - **B25-3:** licence labels are matched longest first (`N° du permis`, `N° permis`, `Permis de conduire N°`, `رقم الرخصة`, `رقم رخصة السياقة`), and the number must contain at least 4 digits. The word `permis` is no longer returned as the number.
- **Gate round 2 on PR #25:**
  - As soon as a photo is cropped, the **whole image is always read too** (one extra OCR pass), not only when the cropped reading is weak.
  - When the crop already holds a checksum-verified MRZ, a worse MRZ read on the whole photo is ignored, including its composite verdict.
  - Tests:
    - with a fake OCR engine, a confident crop now still reads the whole image (this test failed on `8a99247`);
    - the MRZ-noise case observed with the real Tesseract: the extra pass first added junk optional data and false warnings, which this fix removes.
- **Gate round 3 on PR #25:** the MRZ is merged **field by field**.
  - A whole-image MRZ field is added when the crop lacks it and it has its own valid check digit, for example verified dates when the crop held only the document number.
  - Unverified MRZ extras and the composite verdict of a worse whole-photo read are ignored.
  - Two different checksum-valid values are flagged `ocr_disagreement`, and the crop's value is kept.
  - Tests: three new; the dates case and the disagreement case failed on `0a4c844`. The real Tesseract check stays clean.
- **Not in this milestone:** live in-browser corner guide with auto-shutter (needs real Android/iPhone testing); accuracy on real Moroccan documents (needs consented, redacted samples); staging E2E.

### Vehicle reference catalogue — fixes after review (branch `feat/vehicle-catalog-phase1-v12`, PR #3)
- Migration `0011_vehicle_reference_catalog` is now a readable `.sql` (was a binary `.sql.gz`) and no longer contains its own `BEGIN`/`COMMIT`: it is applied and recorded in one transaction. The runner refuses any migration with its own transaction (a failure while recording would otherwise leave it half-applied and block every restart — reproduced, now covered by a test). `.sql.gz` support removed.
- Data corrections (derived, nothing invented): commercial "C" tyre sizes get width/ratio/rim; engine kW computed from the published ch DIN (noted per row); "Huiles Lesieur" (a food-oil company) replaced by a placeholder for local motor-oil brands; status reference completed with the six statuses the app enforces (`app_status`); brand verification default aligned (`À vérifier`).
- Vehicle API: catalogue ids are text codes (`MODEL-…`), not UUIDs (was a 400 on every catalogue-linked vehicle); on update an omitted catalogue field keeps the current link instead of clearing it.
- Seed guards: the 15 catalogue tables (exact names) no longer block `seed:dev` / `seed:demo`; any fleet, customer or other table still does.
- Tests: migration upgrade from 0010 with data (no row changed, second run empty), failure atomicity, catalogue content checks, mismatch/chain refusals asserting the field, update keeps links, permissions, web picker and "Autre".

### Home screen vehicle first, CI on main, docs (branch `feat/vehicle-dashboard-ci-docs`)
- Owner request: the first screen shows the vehicles and everything about them, simply. New `GET /api/fleet/overview` (vehicles.read, branch scope): per vehicle status, km, fuel, branch, open contract (customer, planned return, late), next confirmed reservation, document alert (first document to renew and its date) and maintenance due/soon; customer names only with `customers.read`. Vehicles that need attention (late, expired document, maintenance due, blocked) come first.
- Home: "Vos véhicules" card first, filters All / To handle / by status, 6 cards then "see all"; the status tiles it replaces are gone, the document, maintenance, contract and reservation summaries remain below.
- CI also runs on every push to `main`.
- Docs: `main` is the reference branch (OWNER_TRIAL_AR, RAILWAY_DEMO, README); Railway demo vs company production table; files uploaded before the Railway volume were lost with the deploy — re-upload demo files and run `check-files`.

### Fix: Railway database not migrated (2026-11-05)
- Seen on the Railway demo: new screens without their database (e.g. `/api/branding` 500, menu without reservations/contracts) because the Pre-deploy migration step did not run there.
- The server start command now applies pending migrations before listening (`npm run start -w server`: migrate, then start). Migrations are forward-only, locked and idempotent; if one fails the new version does not start and Railway keeps the previous one.
- New public check `/api/health/schema` (`upToDate`, counts and missing versions only).

### Slice 5 — expenses, cash closing, maintenance, WhatsApp reminders, reports (branch `feat/slice-5-cash-maintenance`)
- Migration `0010_cash_maintenance_reminders` (additive): `expenses` (append-only, reversal corrections, optional receipt), `cash_closings` (one per branch and day, immutable, reason for any difference), `maintenance_plans` / `maintenance_records` (by km and/or months; external garage; record can book the expense), `reminder_log`; permissions `expenses.record`, `cash.read`, `reminders.send` (manager + employee), `cash.close`, `reports.read` (manager, delegable).
- Cash of the day per branch: rent, deposits received/returned/kept and expenses by method; expected cash = cash in − cash out (cheques and card holds never counted as cash); closing frozen with its totals; later movements flagged.
- Maintenance: due/soon by km left or days left, list and home alert, vehicle section with plans, work records and history.
- WhatsApp reminders (D-016): pickup (36 h), return (36 h / late), document expiring before the return — message in the customer's language with a `wa.me` link built by the server; the employee sends it himself and confirms; nothing is sent automatically.
- Reports: income (rent paid + deposits kept), deposits apart (not income), expenses by category, result, contracts, late fees, outstanding, reservations, fleet utilisation; CSV exports for the accountant (UTF-8 BOM, `;`, formula-injection safe).
- Security: an expense receipt must be a file uploaded by the same person (no access to other documents by id).

### Audit fixes P0/P1 (branch `feat/audit-fixes-p0`, independent audit 2026-11-05)
- Migration `0009_audit_fixes`: permission `contracts.extend` (manager, delegable) — employees can no longer extend a rental; minimum driver age constraint ≥ 18; other drivers' birth date; append-only `backup_runs`.
- Other drivers: birth date and licence number required, refused under the minimum age (check-out and later addition).
- Encrypted backups (`BACKUP_PASSPHRASE`, AES-256-GCM + scrypt) for backup, verify and restore; each run recorded; `/api/system/status` and a manager alert on the home screen when files are not on persistent storage or the backup is missing, failed or older than 36 h; startup warning in production without `STORAGE_DIR`.
- `.railway/railway.ts`: persistent volume on `/data` (Railway daily/weekly volume backups) and `STORAGE_DIR=/data/files`.
- Scheduling templates `ops/backup-nightly.ps1` / `ops/backup-nightly.sh`.
- Docs aligned with the code: README, ROADMAP, API (check-in late decision, extension permission, system status), RAILWAY_DEMO (public routes, branch, volume), BUSINESS_RULES, SECURITY (audit status), BACKUP_RESTORE (encryption, scheduling).

### Company-branded design, late-return decision, licence rule (branch `feat/branded-ui-late-fees`)
- The app looks like each company's own app: public `/api/branding` (name, city, colour, logo only — no identifiers); company logo and name on the login page, menu, phone top bar, home screen, browser tab title and favicon; product name only as "Propulsé par Fleetora".
- Modern refresh: company-colour gradients, active menu pill, quick actions on the home screen, lifted cards, phone bottom bar with active pill; "coming soon" block removed.
- Migration `0008_late_fees_licence`: "new licence" = less than 1 year (owner); late return decided by the manager in days, half days or hours (quantity × price) or waived with reason; an employee's return leaves it "pending"; home tile and filter "Retards à décider"; printed contract shows the late charge. Existing contracts keep their amounts.
- History names contracts and template versions; fixed a server error when extending a contract (found by the tests).
- `docs/OWNER_TRIAL_AR.md`: step-by-step trial and what remains before handing over.

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
