# Fleet Management System

Internal vehicle-rental operations platform for a Moroccan car-rental company managing approximately 30–100 vehicles.

**Working product name:** Fleetora (provisional only; not a final brand or trademark decision). Product identity is independent from the rental company's configurable identity.

## Status
Foundation/documentation stage. No production application or operational feature is claimed as implemented.

## Principles
- Internal manager/employee system, not a public self-service booking marketplace.
- Responsive phone and desktop PWA; French and Arabic with RTL.
- Preserve original uploaded documents; OCR suggestions require employee review.
- Financial records must be traceable; deposits are not rental revenue.
- Security, privacy, backup/restore and tests are release requirements.
- Defer features explicitly; never silently discard them.

## Documentation
See PROJECT_MASTER_SPEC.md, FEATURE_TRACKER.md, ROADMAP.md, ARCHITECTURE.md, DATABASE_SCHEMA.md, SECURITY.md, TEST_PLAN.md, BACKUP_RESTORE.md, DECISIONS.md and CHANGELOG.md.

## Proposed stack
React + TypeScript, Node.js + Express, PostgreSQL, private file-storage abstraction and replaceable OCR service. Validate choices with implementation spikes.

Never commit real customer documents, personal data, credentials, production exports or environment files.