# Project Master Specification
Version 1.0 — foundation baseline. Status: approved direction; detailed workflows require company validation.

## Purpose and scope
Build a private internal operations system for a Moroccan car-rental business managing about 30–100 vehicles. Authorized managers and employees manage fleet, customers, reservations, contracts, vehicle handovers, finances, documents and alerts. This is not a public booking marketplace and does not initially process public online payments.

## Product and company identity
The application identity is separate from the rental company's identity. Fleetora is a provisional working name only. A configurable Company Profile must control company/trade name, logo, brand colors, ICE, IF, RC, registered address, contacts, website, branches, contract/invoice headers and footers, responsible person's title/signature, currency (MAD), timezone and language defaults. Company information must populate generated documents automatically. Support configurable display of company branding instead of product branding.

## Users and access
Initial roles: Manager (company-wide configuration, staff access, oversight and authorized finance/reporting) and Employee (operational tasks allowed by assigned permissions). Enforce permissions on the server, not merely by hiding UI controls. Keep branch-level scoping extensible. Audit sensitive actions.

## Functional modules
1. Authentication, users, roles and permissions.
2. Dashboard and operational overview.
3. Fleet: vehicle identity, registration, make/model, category, status, mileage, fuel, branch and photos.
4. Customers: contact details and necessary identity/document references.
5. Reservations: dates, vehicle, status and conflict prevention.
6. Rental contracts: PDF generation using company settings and approved templates.
7. Check-out/check-in: mileage, fuel, timestamps, responsible employee, customer acknowledgement and evidence photos.
8. Inspections and damage: before/after photos, notes and traceable history.
9. Finance: rental payments, deposits, refunds, expenses and balances. Deposits are distinct from revenue.
10. Maintenance: service records, reminders and vehicle downtime.
11. Documents and alerts: expiry tracking for insurance, technical inspection and configured documents.
12. Smart Document Center: batch upload, classification, OCR extraction, human review and linking to records.
13. Reports: utilization, reservations, revenue, deposits, expenses, maintenance and document expiry.

## Document intake and OCR
Accept uploads from both phones and computers from the first release. Initial WhatsApp workflow is manual: download attachments and upload them in batches. Automated WhatsApp Business API is deferred.

Preserve immutable originals. Validate file type, size and content; handle orientation and image quality; classify likely national ID, driving licence, passport, vehicle registration, insurance, technical inspection, contracts, invoices, vehicle/damage/mileage photos. OCR output is a suggestion, not verified truth. Show extracted candidates beside the source and confidence where available. An authorized employee reviews and confirms or corrects sensitive fields. Keep approval and correction history.

Evaluate OCR providers for accuracy, cost, privacy, language support (Arabic/French), deployment and retention. Do not transmit personal documents externally without explicit privacy/security assessment and company approval.

## MVP acceptance direction
- Manager and employee can sign in with server-enforced access.
- Create, view, edit and search vehicles and customers.
- Create reservations and prevent overlapping active reservations for a vehicle.
- Generate contract PDFs populated from company settings.
- Record handover and return, including mileage, fuel and photos.
- Record payments, deposits, refunds and expenses with clear categories and history.
- Upload documents from phone and desktop; retain originals.
- OCR can classify/extract candidate fields where supported, with human review before use.
- Core flows are tested, documented, backed up and restorable before production use.

## Non-functional requirements
Responsive mobile/desktop UX; French and Arabic RTL; consistent validation; auditability; least privilege; secure file handling; data export; reliable backups; modular architecture; clear errors; no external CDN dependency for essential UI assets.

## Out of scope for initial MVP
Public customer booking, online payment gateway, automatic WhatsApp ingestion, GPS tracking, AI damage assessment, advanced AI analytics, multi-company SaaS and complex multi-branch automation. These remain roadmap candidates, not deleted requirements.

## Delivery discipline
Track features as proposed, planned, in progress, implemented, tested, accepted or deferred. Code existing does not mean accepted. Require acceptance tests and review. Database changes use versioned migrations. Destructive changes require explicit approval, backup and documented rollback.