# Architecture

## Proposed components
- Frontend: React + TypeScript, responsive PWA, French/Arabic localization and RTL.
- API: Node.js + Express; validation, authentication, authorization and business rules enforced server-side.
- Database: PostgreSQL with versioned migrations and transactional workflows.
- File storage: private storage adapter, deployable locally or on a selected managed volume; S3-compatible option behind the same interface.
- OCR: isolated service/worker behind a provider-neutral interface. Reuse ideas or engines from ScanFlowPro only after independent testing; no operational hard dependency.
- PDF generation: server-side templates populated from approved company settings and records.

## Boundaries
The browser never connects directly to PostgreSQL or private storage. The API authorizes every record operation. File metadata and business records live in PostgreSQL; binary originals live in private storage. Store stable storage keys, not public URLs.

OCR jobs are asynchronous and idempotent. Store engine/version, status, extracted candidate data, confidence where available, source file, reviewer, approval timestamp and corrections. OCR must not overwrite originals or silently approve sensitive data.

## Deployment direction
Local development and test environment first. Railway or another host may be selected after reviewing persistent storage, backups, secrets, logs, networking and cost. This document does not authorize production deployment or a public domain.

## Reliability
Use database transactions for reservation allocation and financial posting. Prevent double-booking with database-level constraints/transactional checks, not only frontend checks. Use background jobs for OCR and reminders. Add health checks and structured logs without exposing personal document contents.