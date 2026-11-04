# Security and Privacy Baseline

## Authentication and authorization
Hash passwords with a modern password-hashing algorithm. Secure sessions/cookies, apply CSRF protection where applicable, rate-limit authentication and enforce role/record/branch permissions on every API route. Never trust client-supplied roles or ownership identifiers.

### Login protection: current implementation and production gate
- Per-account lockout (5 failures, 15 minutes by default) is stored in PostgreSQL. It survives restarts and applies whatever the client address is.
- Per-client-address limit counts **failed** attempts only (express-rate-limit, in-memory store). It resets when the API restarts and assumes **one API process** (true on the Railway demo and on the single company host). The per-account lockout is stored in the database and survives restarts. Before running several API processes, move the limiter to a shared store.
- **Before production:** confirm a single API process, or move the limiter to a shared store (PostgreSQL). Set `TRUST_PROXY=true` behind the HTTPS reverse proxy so client addresses are not all the proxy's address. Review the thresholds with the company.

### Destructive tooling safeguards
- **Test suite.** The only wipe path is `wipeTestDatabase()`, and it carries all of its own checks. On the same connection that runs the `DROP`, it verifies:
  - the pool targets exactly the configured `TEST_DATABASE_URL`;
  - that database is local, its name ends in `_test`, and it is not `DATABASE_URL`;
  - the server-side `current_database()` matches;
  - the content is disposable: either completely empty (no tables, views, sequences, functions, types or extensions in `public`), or carrying the test-suite marker. Any extra schema is always refused.
- **`seed:dev`.** Runs only with `NODE_ENV=development`, on a local `*_dev`/`*_test` database, and only when every account is `@example.test`. It is default-deny for operational data: any table that is not a known foundation table must be empty unless `seed:dev` created the database (it leaves a marker table). Future module tables are covered without anyone updating a list.
- **CI** uses the same rules, with no relaxation; see `.github/workflows/ci.yml`.
- See `server/src/db/target-guard.ts` and `server/test/db-safety.test.ts`.

## File upload safety
Allowlist formats; verify actual file content, not only filename or client MIME. Enforce size/count limits, use random storage names and prevent path traversal. Store originals privately outside executable/public web roots; use authorized short-lived access. Consider malware scanning and parser isolation. Never expose identity documents in logs, URLs or error messages.

## Secrets and infrastructure
Never commit environment files, API keys, tokens, passwords, private keys or production dumps. Use HTTPS, managed secrets and restricted database/network access. Keep dependencies updated. Back up database and files and test restoration.

## Personal data and OCR
Collect only data required for operations/legal obligations. Use synthetic test data by default; real samples require authorization, consent where appropriate and minimization. Evaluate OCR vendor location, retention, training use, subprocessors, access controls and deletion terms before external processing. OCR output remains unverified until employee confirmation. Define access, retention, correction and deletion procedures with the company and applicable Moroccan legal advice.

## Audit and incident response
Record actor, action, target, timestamp and relevant before/after metadata for sensitive changes without copying secrets or full identity documents into logs. Document incident triage, credential rotation, containment and recovery.
## Audit 2026-11-05 — status of the points raised
- Extension of a rental is a separate, manager-only (delegable) permission `contracts.extend` (migration 0009); employees get 403 from the API, the button is hidden.
- Minimum driver age cannot be configured below 18 (API validation + database constraint); other drivers carry a birth date and are refused under the minimum age.
- Public endpoints: `/api/health…`, `/api/branding`, `/api/branding/logo` only (D-043). Everything else needs a session.
- Backups can be encrypted (AES-256-GCM, key from scrypt) with `BACKUP_PASSPHRASE`; without it the backup tool warns. The passphrase is never stored in the backup.
- Uploaded files are not scanned for malware (no antivirus engine is bundled). Mitigations: only JPEG/PNG/WebP/PDF accepted, type detected from bytes, served with `nosniff`, `sandbox` CSP and `no-store`, never executed. Install an antivirus on the company host that scans `STORAGE_DIR`.
- Retention of customer ID scans: not decided yet (BUSINESS_RULES open question 6); nothing is deleted meanwhile.
- GitHub branch protection for `main`: not available on a private repository without GitHub Pro/Team; until then the rule is procedural (CLAUDE.md: never push to `main`, merge only with the owner's approval after CI passes).
- Railway PostgreSQL network settings (no public domain / TCP proxy) cannot be verified from the repository; check them in the Railway dashboard (`docs/RAILWAY_DEMO.md`).
