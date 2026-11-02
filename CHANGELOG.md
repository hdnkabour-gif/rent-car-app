# Changelog

## Unreleased

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
