# Security and Privacy Baseline

## Authentication and authorization
Hash passwords with a modern password-hashing algorithm. Secure sessions/cookies, apply CSRF protection where applicable, rate-limit authentication and enforce role/record/branch permissions on every API route. Never trust client-supplied roles or ownership identifiers.

## File upload safety
Allowlist formats; verify actual file content, not only filename or client MIME. Enforce size/count limits, use random storage names and prevent path traversal. Store originals privately outside executable/public web roots; use authorized short-lived access. Consider malware scanning and parser isolation. Never expose identity documents in logs, URLs or error messages.

## Secrets and infrastructure
Never commit environment files, API keys, tokens, passwords, private keys or production dumps. Use HTTPS, managed secrets and restricted database/network access. Keep dependencies updated. Back up database and files and test restoration.

## Personal data and OCR
Collect only data required for operations/legal obligations. Use synthetic test data by default; real samples require authorization, consent where appropriate and minimization. Evaluate OCR vendor location, retention, training use, subprocessors, access controls and deletion terms before external processing. OCR output remains unverified until employee confirmation. Define access, retention, correction and deletion procedures with the company and applicable Moroccan legal advice.

## Audit and incident response
Record actor, action, target, timestamp and relevant before/after metadata for sensitive changes without copying secrets or full identity documents into logs. Document incident triage, credential rotation, containment and recovery.