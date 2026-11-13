# JMR LUXE CAR — document intelligence implementation status (2026-11-13)

## Agreed rules
- Client identity documents, vehicle documents and rental contracts have **separate** data models, permissions and workflows.
- The owner/manager sees the original scan next to extracted suggestions; can correct, approve or reject them.
- Initial OCR is lightweight and local; **only escalate** to additional preprocessing / OCR engines for uncertain, missing, inconsistent or low-quality fields. Never claim OCR output proves a document genuine.
- A manager's approval never silently edits an existing customer profile, a vehicle record, or a signed contract. Those must have separate explicit update operations and their own audits.
- Never automatically merge customer identities. Manual cross-document verification is required for conflicts.
- The original scanned document and OCR suggestions are not changed by an edit; reviewed fields are stored separately and visible with revision and reviewer context.

## Implemented in this branch
- Migration 0015: separate manager-approved/rejected fields with revision counter and FK-protected rows.
- A branch-scoped, manager-only PUT endpoint: /api/customer-intakes/:id/documents/:docId/review.
- Review values never flow automatically into the customer or reservation.
- Customer-intake details response includes review state.
- Staff review UI displays image files, editable OCR proposal fields and approve/reject controls.
- Server integration test for manager-only review, correction revisions and no customer-profile mutation.

## Existing in main before this branch
- Time-limited secure guest upload links with independent code, consent and throttling.
- Local opt-in Tesseract OCR with basic photo-quality checks, analysis warnings and similarity fingerprints.
- Dedicated vehicle-document page and contract pages.
- Custom brand logo upload and company identity settings.

## Remaining work — not implemented or verified by this branch
1. Calibrated escalation engine: run additional OCR processors **only** on doubtful fields; benchmark actual correctness by document type.
2. Moroccan document templates (CNIE versions, permis categories, carte grise, insurance) with licensed non-sensitive samples and independently verified field rules.
3. Detailed audit revision history with restricted visibility; this branch logs status/revision/modified field names, not the full sensitive old/new values.
4. A distinct workflow for approving extracted vehicle-document fields, separate from customer documents.
5. A distinct workflow for scanning signed contracts, comparing approved snapshots and retaining immutability.
6. Manager-confirmed field-to-customer update action, with duplicate/identity conflict checks, explicit selected target, and audit record.
7. OCR functional tests on a trusted staging runtime with dependencies and synthetic scans; manually test desktop and mobile scan review.
8. Accessibility refinements and PDF inline preview in the review UI.
9. Validate brand logo in company settings (JMR LUXE CAR) and choose a finalized source asset rather than overwriting default identity across all tenants.

## Release gates
- Server/client TS typechecks, unit/integration tests and lint.
- DB migration up and rollback/restore rehearsal on staging **without real customer data**.
- Confirm manager/employee scope isolation and verify private scans cannot be fetched as a guest.
- Ensure approved review fields never modify a signed contract.
- Merge only after CI and deployment checks pass.
