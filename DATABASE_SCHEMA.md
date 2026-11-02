# Database Schema — Initial Logical Model
Logical starting point. Final columns, constraints, indexes and retention rules require review.

## Executed migrations
- `server/migrations/0001_foundation.sql` (slice 1): `roles`, `permissions`, `role_permissions`, `users`, `sessions`, `company_settings` (single row), `audit_logs` (append-only via trigger), plus `schema_migrations` (created by the runner). Users have one `role_code`; `user_roles` and `employees`/`branches` from the logical model are not created yet.

## Identity and organization
users, roles, permissions, user_roles, role_permissions, employees, branches, company_settings.

## Fleet and customers
vehicles, vehicle_photos, vehicle_documents, clients, client_documents, vehicle_status_history.

## Rentals
reservations, rental_contracts, contract_templates, vehicle_checkouts, vehicle_checkins, vehicle_inspections, vehicle_damage_reports.

## Finance
payments, deposits, deposit_movements, expenses. Financial entries preserve amount, currency, type, date, method, related record, creator and audit history. Deposits/refunds are not rental revenue. Avoid hard deletion of posted financial records; use reversal/correction entries.

## Operations and documents
maintenance_records, suppliers, notifications, uploaded_files, document_import_batches, document_classifications, ocr_jobs, ocr_results, document_reviews, audit_logs.

## Required safeguards
- Stable primary keys; timestamps stored consistently in UTC and displayed in configured local timezone.
- Money uses fixed-precision decimal or integer minor units, never floating point.
- Foreign keys and indexes support integrity and searches.
- Reservation overlap prevention is transactional and database-enforced where feasible.
- Preserve financial/audit history; soft-delete/archive only where justified.
- Personal-data access, retention and deletion require a documented policy.
- Migrations are versioned, reviewed, tested on a copy and have rollback/restore plans.