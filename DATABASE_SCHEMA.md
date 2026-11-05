# Database Schema — Initial Logical Model
Logical starting point. Final columns, constraints, indexes and retention rules require review.

## Executed migrations
- `server/migrations/0001_foundation.sql` (slice 1): `roles`, `permissions`, `role_permissions`, `users`, `sessions`, `company_settings` (single row), `audit_logs` (append-only via trigger), plus `schema_migrations` (created by the runner). Users have one `role_code`; `user_roles` and `employees`/`branches` from the logical model are not created yet.

- `0002_branches_fleet.sql` (slice 2a): branches, user branches, delegable permissions and grants, vehicles, transitions, status history.
- `0003_vehicle_documents_files.sql` (slice 2b): first registration date, `stored_files`, `vehicle_documents`, `vehicle_photos`.
- `0005_no_delete_business_data.sql` (slice 3): DELETE/TRUNCATE refused on business tables.
- `0006_reservations.sql` (slice 3): vehicle `daily_rate_cents` / `deposit_cents`, `reservations` (exclusion constraint), `reservation_events`.
- `0007_contracts.sql` (slice 4): company phone2/logo/rental rules, customer profession/other address/ID issue date, `contract_templates` (versioned), `contracts`, `contract_drivers`, `contract_photos`, `contract_events`, `payments` (append-only ledger).
- `0004_customers.sql` (slice 2c): `customers` (identity, contact, ID document, licence, "do not rent"), `customer_documents` (scans with review status).

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

## Reference catalogue (migration 0011, read-only)
`vehicle_catalog_*` (15 tables): sources, brands, models, generations, engines, tyre brands/models/sizes/fitments, oil brands/products/fitments, maintenance categories, market priority, status reference (`app_status` = one row per vehicle status). Text primary keys (`BRAND-…`, `MODEL-…`, `GEN-…`, `ENG-…`) kept stable with the shared PNEU MOUHIM seed. `vehicles.catalog_model_id / catalog_generation_id / catalog_engine_id` are optional FKs (`ON DELETE RESTRICT`). Compatibility rows are advisory only. No write API; updates come as new migrations.

## Required safeguards
- Stable primary keys; timestamps stored consistently in UTC and displayed in configured local timezone.
- Money uses fixed-precision decimal or integer minor units, never floating point.
- Foreign keys and indexes support integrity and searches.
- Reservation overlap prevention is transactional and database-enforced where feasible.
- Preserve financial/audit history; soft-delete/archive only where justified.
- Personal-data access, retention and deletion require a documented policy.
- Migrations are versioned, reviewed, tested on a copy and have rollback/restore plans.