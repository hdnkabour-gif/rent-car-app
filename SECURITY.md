# Security and Privacy Baseline

## Authentication and authorization
Hash passwords with a modern password-hashing algorithm. Secure sessions/cookies, apply CSRF protection where applicable, rate-limit authentication and enforce role/record/branch permissions on every API route. Never trust client-supplied roles or ownership identifiers.

### Login protection: current implementation and production gate
- Per-account lockout (5 failures, 15 minutes by default) is stored in PostgreSQL. It survives restarts and applies whatever the client address is.
- Per-client-address limit counts **failed** attempts only (express-rate-limit, in-memory store). It resets when the API restarts and assumes **one API process**.
- **Before production:** confirm a single API process, or move the limiter to a shared store (PostgreSQL). Set `TRUST_PROXY=true` behind the HTTPS reverse proxy so client addresses are not all the proxy's address. Review the thresholds with the company.

### Destructive tooling safeguards
- The test suite wipes only a database that passes all of these: local host, name ending in `_test`, different from `DATABASE_URL`, and either empty or carrying the test-suite marker table.
- `seed:dev` runs only with `NODE_ENV=development`, on a local `*_dev`/`*_test` database that contains only `@example.test` accounts.
- See `server/src/db/target-guard.ts` and `server/test/db-safety.test.ts`.

## File upload safety
Allowlist formats; verify actual file content, not only filename or client MIME. Enforce size/count limits, use random storage names and prevent path traversal. Store originals privately outside executable/public web roots; use authorized short-lived access. Consider malware scanning and parser isolation. Never expose identity documents in logs, URLs or error messages.

## Secrets and infrastructure
Never commit environment files, API keys, tokens, passwords, private keys or production dumps. Use HTTPS, managed secrets and restricted database/network access. Keep dependencies updated. Back up database and files and test restoration.

## Personal data and OCR
Collect only data required for operations/legal obligations. Use synthetic test data by default; real samples require authorization, consent where appropriate and minimization. Evaluate OCR vendor location, retention, training use, subprocessors, access controls and deletion terms before external processing. OCR output remains unverified until employee confirmation. Define access, retention, correction and deletion procedures with the company and applicable Moroccan legal advice.

## Audit and incident response
Record actor, action, target, timestamp and relevant before/after metadata for sensitive changes without copying secrets or full identity documents into logs. Document incident triage, credential rotation, containment and recovery.