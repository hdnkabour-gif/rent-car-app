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
- Development/staging is isolated and uses synthetic or minimized test data only.
- The current company computer (Intel Core i5-650, 8 GB RAM, 512 GB SSD, Windows 11) is a temporary development/testing host only. It is not approved for production or real customer documents.
- Production target is a newer dedicated company computer/server with at least 16 GB RAM, SSD (1 TB preferred), wired LAN, a supported OS and UPS.
- Production PostgreSQL and private document storage remain inside the company. Employee phones connect over company Wi-Fi while onsite; remote access is through a company-approved VPN.
- Do not expose PostgreSQL or private file storage directly to the public internet. Remote access must terminate at an authenticated VPN/reverse-proxy boundary with HTTPS and application authorization.
- Keep the application portable across hosts. Configuration must be externalized; database migrations, file storage and backup/restore procedures must be documented and tested.
- Railway or another external host may be used for isolated development/staging only if persistent storage, secrets, backups, logs, networking and cost are reviewed. This does not authorize production deployment or public exposure.

## Reliability
Use database transactions for reservation allocation and financial posting. Prevent double-booking with database-level constraints/transactional checks, not only frontend checks. Use background jobs for OCR and reminders. Add health checks and structured logs without exposing personal document contents.
