# Architecture and Product Decisions

| ID | Decision | Status | Rationale / notes |
|---|---|---|---|
| D-001 | Internal manager/employee app, not public booking marketplace | Accepted | Matches operating model |
| D-002 | Moroccan market; MAD default currency | Accepted | Display defaults configurable |
| D-003 | Phone and desktop uploads from first release | Accepted | Both workflows required |
| D-004 | OCR classification/extraction with mandatory human review | Accepted | Sensitive data needs verification |
| D-005 | Early practical MVP, then incremental delivery | Accepted | Deliver core first in small testable slices |
| D-006 | WhatsApp files manually downloaded and batch-uploaded initially | Accepted | API deferred |
| D-007 | Product identity separate from configurable company identity | Accepted | Company can change branding |
| D-008 | Fleetora is a provisional working name only | Provisional | Final name/trademark/domain check pending |
| D-009 | React + TypeScript, Node.js + Express, PostgreSQL | Proposed — implemented in slice 1 | Slice 1 runs on Node 22, Express 5, PostgreSQL 16, React 19 + Vite; confirm at slice review |
| D-010 | File storage and OCR behind replaceable adapters | Accepted direction | Avoid vendor lock-in |
| D-011 | No production deployment until security, backup and tests pass | Accepted | Release safety gate |
| D-012 | Production is hosted on a dedicated company computer/server; database and private documents remain inside the company | Accepted direction | Remote access through approved VPN; no direct public exposure |
| D-013 | Current Intel i5-650 / 8 GB / 512 GB SSD computer is for development and testing only | Accepted | Do not use for real customer records or production 24/7 |
| D-014 | Production host target is a newer machine with at least 16 GB RAM and SSD; 1 TB preferred | Accepted target | Final CPU/OS selection depends on company IT and budget |
| D-015 | Signed paper contract remains the official executed contract in the initial release; PDF is for preview, printing and archiving | Accepted | Electronic signature deferred pending legal/business validation |
| D-016 | Initial WhatsApp reminders use prefilled wa.me links; employee reviews and sends manually | Accepted | No automated sending or Business API in initial release |
| D-017 | Phone uploads inside company use Wi-Fi; remote phone uploads use company-approved VPN | Accepted direction | Secure access to the same company-hosted application |
| D-018 | OCR evaluation uses 20–30 representative permitted/minimized samples before provider selection | Accepted | Measure Arabic/French accuracy, cost, latency and privacy |
| D-019 | Passwords hashed with scrypt (Node built-in), parameters stored per hash | Proposed (2026-11-02) | No native build tools on Windows; memory-hard; can be raised later with transparent rehash on login |
| D-020 | Database-backed opaque sessions in an HttpOnly SameSite=Strict cookie, not JWT | Proposed (2026-11-02) | Immediate server-side revocation on logout, deactivation, role or password change |
| D-021 | Local development does not require Docker; native Node.js + PostgreSQL | Proposed (2026-11-02) | Simplest reliable setup on the i5-650 / 8 GB Windows 11 test PC |
| D-022 | One role per user (manager/employee) mapped to a role→permission table; API checks permissions, not role names | Proposed (2026-11-02) | Lets roles change or branch scoping be added without rewriting route checks |
| D-023 | Audit log is append-only at database level; users are deactivated, never hard-deleted | Proposed (2026-11-02) | Traceability; trigger blocks UPDATE/DELETE/TRUNCATE on audit_logs |

New decisions include date, status, context and impact. Supersede decisions rather than silently rewriting history. A Proposed or Accepted direction is not a claim that infrastructure has already been deployed.
