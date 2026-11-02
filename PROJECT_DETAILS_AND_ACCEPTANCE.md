# Detailed Workflows and MVP Acceptance Criteria

Version 1.1 — supplements `PROJECT_MASTER_SPEC.md`; it does not replace or reduce its scope.

## 1. Operating and deployment decisions

- The current company computer (Intel Core i5-650, 8 GB RAM, 512 GB SSD, Windows 11) is for development and testing only. Do not use it for real customer records or production operation.
- Production will move to a newer dedicated company computer/server, with at least 16 GB RAM, SSD storage (1 TB preferred), wired network, supported operating system and UPS.
- Production database and original documents are hosted inside the company.
- Inside the company, employee phones connect through company Wi-Fi to the local application.
- Outside the company, authorized phones connect through a company-approved VPN. Do not expose database ports or the application server directly to the public internet.
- The development/staging environment is separate from production. No automatic production deployment.
- The system must be portable: configuration, database migrations, file-storage adapter and documented backup/restore must allow migration to a newer host.
- Production hosting choice (Linux server or another supported platform) is deferred until the target hardware and company IT policy are confirmed.

## 2. User roles and permissions

Initial roles:
- Manager: company-wide settings, staff and access management, operational oversight, authorized financial views and reports.
- Employee: assigned operational tasks according to explicit permissions.

Authorization is enforced on every protected backend endpoint. Hiding a button is not authorization. Record sensitive actions in an audit trail, including actor, timestamp, action, target record and safe metadata. Avoid placing identity document contents or secrets in logs.

## 3. Core data fields

### Vehicle
Required/expected fields, subject to business validation:
- Internal vehicle code; registration/plate number; make; model; trim/version where relevant; category/body type; color; transmission; fuel/energy type; seat count.
- VIN/chassis number where required; first registration date/year; current mileage; fuel level; operational status (available, reserved, rented, maintenance, inactive).
- Branch/location (future multi-branch capable); notes; created/updated timestamps.
- Vehicle documents: registration card, insurance, technical inspection and other configurable document types, with issue/expiry dates where applicable.
- Photos: general vehicle photos, condition photos, damage evidence and mileage/fuel evidence. Preserve originals and timestamps.

### Customer
- Customer type (individual/company); full legal name; phone; optional email; address/city; preferred language.
- Identity document type (national ID, passport or other configured type), document number and expiry where legally/operationally required.
- Driving licence number, category and expiry where required.
- Document files linked to the customer, source, upload time, review status and authorized reviewer.
- Additional driver(s) linked to a specific rental contract, with required identity/licence details and review status.
- Do not collect fields that the company does not need for a lawful operational purpose.

### Reservation
- Customer; vehicle or vehicle category if the business later chooses category-first allocation; start/end date and time; pickup/return location; status; quoted price; notes; creator and timestamps.
- Prevent overlapping active reservations for the same vehicle. Define timezone consistently and validate date ranges server-side.
- Keep cancellation and change history.

### Rental contract
- Unique contract number; linked customer, vehicle, reservation and branch; start/end date/time; rental price and payment terms; deposit amount and status; included mileage/fuel terms; additional driver(s); agreed extras/fees; special conditions; handover/return references.
- Store the generated PDF version and template/version metadata for preview, printing and archive.
- **Legal/operational rule for initial release:** paper contract signed by the parties remains the official executed contract. PDF is a preview/print/archive artifact, not a substitute for the signed paper. Electronic signature is deferred pending legal and business validation.
- Company identity, address, ICE, IF, RC, contact details and branding come from company settings, not repeated manual entry.

### Handover and return
- Record date/time, employee, mileage, fuel level, keys/accessories and customer acknowledgement.
- Capture timestamped photos from multiple angles and close-ups of existing/new damage.
- Record damage notes and link before/after evidence. Preserve prior inspection records; do not overwrite history.

### Finance
- Separate rental income, deposits, deposit refunds/retentions, expenses and other adjustments.
- Each transaction has amount, currency (MAD default), date, method, status, reference, linked customer/contract/vehicle where applicable, creator and audit history.
- Deposits must never be counted as rental revenue by default.
- Corrections, refunds and reversals must preserve history; do not silently delete posted transactions.

## 4. Document intake and OCR workflow

1. Employee selects the customer, vehicle or import batch, or starts an unlinked review queue.
2. Employee captures images using the phone camera or selects multiple images/files; desktop upload is also supported.
3. Validate file size, extension, detected MIME/content, file signature where feasible and image dimensions. Reject unsafe or unsupported content with a clear error.
4. Preserve original file bytes in private storage. Generate a random storage key; keep original filename only as sanitized metadata.
5. Create an upload/import batch and per-file processing status. Support retries and avoid duplicate creation on network retry using idempotency keys.
6. Classify likely document type: national ID, passport, driving licence, vehicle registration, insurance, technical inspection, contract, invoice, vehicle photo, damage photo, mileage/fuel evidence or unknown.
7. Detect likely duplicates using safe file hashes and metadata. Do not automatically merge or delete records based only on similarity.
8. Run OCR through a replaceable adapter. Extract candidate fields with source-page/region reference and confidence where supported.
9. Show candidate fields beside the original. Mark uncertain, missing or conflicting values clearly.
10. Authorized employee reviews, corrects and confirms. Only confirmed values become verified application data.
11. Record reviewer, decision, timestamp and corrections. Preserve original OCR output and audit history.
12. Failed OCR must not block manual document attachment or manual data entry.

### OCR evaluation
Before choosing an OCR provider or enabling real personal documents, test 20–30 representative documents with permission and data minimization. Include Arabic and French examples, varied image quality, orientations and document types. Record field-level accuracy, failure cases, latency, operating cost and privacy/data-retention terms. Synthetic or redacted samples are preferred for early development. No external provider receives real documents until company approval and a documented privacy/security assessment.

## 5. Duplicate detection and customer matching

- Detect exact duplicate uploads using cryptographic file hashes within the appropriate access scope.
- Provide a review warning for probable duplicate documents or customer records.
- Similarity matching must never silently merge customer identities.
- An authorized manager can review and approve a merge. Preserve a traceable mapping from the retired record to the surviving record and retain audit history.
- Keep separate people separate even if names are similar; phone/document-number matches are signals, not automatic proof.

## 6. WhatsApp workflow

Initial release:
- Employee downloads attachments from WhatsApp and uploads them to the application in batches.
- Provide prefilled `wa.me` links for reminders such as reservation confirmation, upcoming return and outstanding balance.
- The link opens WhatsApp with a prepared message and customer number. Employee checks the recipient and text, then manually presses Send.
- Respect customer communication preferences and company policy. Do not claim the message was sent merely because WhatsApp was opened.
- WhatsApp Business API, automatic ingestion and automatic sending remain deferred.

## 7. Company settings

A manager-configurable company profile controls company/trade name, logo, colors, ICE, IF, RC, registered address, phone, email, website, branches, document headers/footers, responsible person's title/signature, MAD currency default, timezone and language defaults. Changes should apply to future generated documents; archived documents retain the version actually generated at that time.

Product name and company name are separate. Fleetora remains provisional until an explicit naming decision and availability checks.

## 7a. Ease of use and visual quality

The application must be easy to use, with a modern, elegant interface that Moroccan agency staff understand without long training, on phone and desktop. Plain French and simple Modern Standard Arabic wording, Moroccan formats (DH, dates, phone numbers, ICE/IF/RC/CIN), phone-first navigation, and company branding are required. The detailed, checkable rules are in `docs/UX_GUIDELINES.md` and apply to every slice.

## 8. MVP acceptance criteria

The MVP is not accepted until each applicable criterion is demonstrated and tested:

1. Manager and employee can authenticate; passwords are securely hashed and sessions can be revoked.
2. Backend rejects unauthorized actions even when requests are sent directly without using the UI.
3. Company settings can be created and updated by an authorized manager.
4. Company identity is populated automatically in generated contract PDFs.
5. Vehicles can be created, viewed, edited, searched and assigned operational statuses.
6. Customers can be created, viewed, edited and searched with only necessary data.
7. Vehicle and customer documents can be attached and retrieved by authorized users.
8. Reservations validate date/time ranges and reject overlapping active bookings for the same vehicle.
9. Reservation changes and cancellations retain an audit history.
10. Contracts can be previewed and printed as PDFs; signed paper remains the official executed contract for the initial release.
11. Additional drivers can be recorded against a contract and their required documents reviewed.
12. Check-out records mileage, fuel, timestamp, employee and condition photos.
13. Check-in records mileage, fuel, timestamp, employee and return-condition photos.
14. Before/after inspection evidence remains available and is not overwritten.
15. Payments, deposits, refunds and expenses are distinguishable in the ledger; deposits are not counted as revenue.
16. Posted financial records cannot be silently deleted; corrections and reversals are traceable.
17. Phone and desktop support multi-file uploads; originals are retained.
18. Interrupted uploads can be retried safely without creating unintended duplicate records.
19. OCR suggestions are visibly unverified until an authorized employee confirms them; manual workflows work when OCR fails.
20. Exact/probable duplicate documents and customer matches are flagged for human review; no automatic destructive merge occurs.
21. Manual WhatsApp batch upload works; prefilled `wa.me` reminders require employee review and manual sending.
22. Core screens support French and Arabic RTL on phone and desktop.
23. Search, validation, empty states and error messages are usable and do not expose secrets or document contents.
24. Audit logs record sensitive actions without storing passwords, tokens or raw identity-document contents.
25. Backup and restore are demonstrated in a separate test environment before production release.
26. A migration to a different host can be completed from documented steps without losing linked files or records.
27. Security checks cover upload validation, path traversal, access control, session security and private file retrieval.
28. Test results are recorded truthfully; skipped tests and known limitations are disclosed.
29. Every core screen meets the definition of done in `docs/UX_GUIDELINES.md`. At least one real employee can complete the main tasks on a phone, in French and in Arabic, without assistance (usability check with synthetic data).

## 9. Explicitly deferred, not deleted

- Automated WhatsApp Business API ingestion/sending.
- GPS tracking and live fleet location.
- AI damage detection/comparison.
- Advanced AI analytics and forecasting.
- Advanced multi-branch automation.
- Electronic signatures, subject to legal review.
- Public customer booking and online payment gateway.
- Automatic customer identity merging.

These remain roadmap items and require explicit product approval before implementation.
