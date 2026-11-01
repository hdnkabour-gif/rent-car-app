# Architecture and Product Decisions

| ID | Decision | Status | Rationale / notes |
|---|---|---|---|
| D-001 | Internal manager/employee app, not public booking marketplace | Accepted | Matches operating model |
| D-002 | Moroccan market; MAD default currency | Accepted | Display defaults configurable |
| D-003 | Phone and desktop uploads from first release | Accepted | Both workflows required |
| D-004 | OCR classification/extraction with mandatory human review | Accepted | Sensitive data needs verification |
| D-005 | Early practical MVP, then incremental delivery | Accepted | Deliver core first |
| D-006 | WhatsApp files manually downloaded and batch-uploaded initially | Accepted | API deferred |
| D-007 | Product identity separate from configurable company identity | Accepted | Company can change branding |
| D-008 | Fleetora is a provisional working name only | Provisional | Final name/trademark/domain check pending |
| D-009 | React + TypeScript, Node.js + Express, PostgreSQL | Proposed | Validate with implementation spike |
| D-010 | File storage and OCR behind replaceable adapters | Accepted direction | Avoid vendor lock-in |
| D-011 | No production deployment until security, backup and tests pass | Accepted | Release safety gate |

New decisions include date, status, context and impact. Supersede decisions rather than silently rewriting history.