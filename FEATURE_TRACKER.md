# Feature Tracker
Status vocabulary: Proposed → Planned → In progress → Implemented → Tested → Accepted. Use Deferred only with a reason and target milestone. Implemented does not mean accepted.

| ID | Feature | Priority | Target | Status |
|---|---|---|---|---|
| F-001 | Authentication and session security | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-002 | Manager/employee roles and API permissions | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-003 | Company profile and document branding | P0 | MVP slice 1 | In progress — settings tested; logo upload waits for the file-storage adapter (slice 2); use in documents arrives with contracts (slice 4) |
| F-004 | Vehicle fleet CRUD, status and search | P0 | MVP slice 2 | Planned |
| F-005 | Customer records and document links | P0 | MVP slice 2 | Planned |
| F-006 | Reservations and vehicle/date conflict prevention | P0 | MVP slice 3 | Planned |
| F-007 | Contract PDF preview/print/archive; signed paper remains official initially | P0 | MVP slice 4 | Planned |
| F-008 | Check-out/check-in with mileage, fuel and photos | P0 | MVP slice 4 | Planned |
| F-009 | Payments, deposits, refunds and expenses ledger | P0 | MVP slice 5 | Planned |
| F-010 | Secure multi-file upload from phone and desktop | P0 | MVP slice 2 | Planned |
| F-011 | OCR classification/extraction with human approval | P1 | Phase 2 after upload foundation | Planned |
| F-012 | Maintenance records and reminders | P1 | Phase 2 | Planned |
| F-013 | Document expiry alerts | P1 | Phase 2 | Planned |
| F-014 | Operational and financial reports | P1 | Phase 2 | Planned |
| F-015 | Manual WhatsApp attachment batch workflow | P1 | MVP slice 2 | Planned |
| F-016 | WhatsApp Business API ingestion/automation | P2 | Later | Deferred |
| F-017 | GPS tracking | P2 | Later | Deferred |
| F-018 | AI-assisted damage comparison | P2 | Later | Deferred |
| F-019 | Advanced AI analytics | P2 | Later | Deferred |
| F-020 | Multi-branch operational controls | P2 | Later | Planned |
| F-021 | Local company-hosted production with Wi-Fi access and remote VPN access | P0 | Deployment foundation | Planned |
| F-022 | Exact/probable duplicate document detection with human review | P1 | Phase 2 | Planned |
| F-023 | Controlled customer-record merge with audit trail | P1 | Phase 2 | Planned |
| F-024 | Rental contract extension and revised return date/price history | P1 | Phase 2 | Planned |
| F-025 | Additional drivers linked to a rental contract | P1 | MVP slice 4 | Planned |
| F-026 | Prefilled wa.me reminders with employee review and manual send | P1 | MVP slice 5 | Planned |

| F-027 | Append-only audit log of sensitive actions | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-028 | Staff account administration (create, role change, deactivate, password reset) | P0 | MVP slice 1 | Tested (automated; awaiting review) |
| F-029 | Responsive app shell, French/Arabic UI with RTL | P0 | MVP slice 1 | Tested (component + browser checks; awaiting review) |

### Slice 1 evidence (branch `feat/app-foundation-slice-1`)
- Backend: 80 Vitest integration/unit tests against a real PostgreSQL 16 database, all passing.
- Frontend: 11 Vitest/Testing Library component tests, all passing.
- `npm run typecheck`, `npm run lint`, `npm run build`: all passed.
- Browser walkthrough (Playwright, Chromium, desktop 1280×800 + phone 390×844): 20/20 checks passed.
- Environment: Linux cloud container, Node 22, PostgreSQL 16. **Not yet run on the Windows 11 test PC.**
- "Tested" here means automated tests passed. Nothing is Accepted until reviewed by the owner.

## Scope preservation
- The detailed workflows and acceptance criteria in `PROJECT_DETAILS_AND_ACCEPTANCE.md` are part of the project baseline.
- Features marked Deferred are postponed, not deleted.
- Update this table, the changelog and relevant decision documents whenever scope or status changes.
- Never mark a feature Accepted without evidence and the relevant acceptance tests.
