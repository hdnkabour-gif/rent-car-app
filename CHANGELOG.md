# Changelog

## Unreleased

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
