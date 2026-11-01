# Test Plan

## Test layers
- Unit: validation, date/overlap rules, money calculations, permissions and OCR mapping.
- Integration: API + PostgreSQL, transactions, migrations, storage adapter and OCR worker.
- End-to-end: manager and employee workflows on desktop and mobile viewport.
- Security: authorization bypass, IDOR, upload spoofing, path traversal, oversized files, rate limits, sessions and secret leakage.
- Recovery: database/file restore, migration rollback strategy and consistency checks.

## Critical acceptance scenarios
1. Employee cannot access manager-only settings or unauthorized records/branches.
2. Simultaneous reservations cannot allocate one vehicle for overlapping active periods.
3. Invalid dates and unavailable vehicles are rejected by the API.
4. Contract output uses approved company identity and correct customer/vehicle/reservation data.
5. Check-out/check-in preserve mileage, fuel, timestamp, employee and photo evidence.
6. Deposits, refunds, rental payments and expenses remain distinct and reconcile.
7. Originals remain unchanged and private; unsupported or malicious uploads are rejected.
8. OCR suggestions show source traceability and cannot be treated as verified until reviewed.
9. Arabic RTL and French screens work on mobile and desktop.
10. Backup restore reproduces database records and linked files.

## Release rule
Record test command, environment, date, result and limitations. Never report a test as passed unless actually executed.