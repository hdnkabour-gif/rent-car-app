# API — Slice 1 (application foundation)

All endpoints are under `/api`. JSON in/out. Errors: `{ "error": { "code", "message", "details?", "requestId" } }`.
State-changing requests (POST/PUT/PATCH/DELETE) must send `X-Requested-With: fleetora`; a browser `Origin`
header, if present, must be the API's own origin or listed in `APP_ORIGINS`. The session is an HttpOnly,
SameSite=Strict cookie (`__Host-fleetora_sid` over HTTPS, `fleetora_sid` on local HTTP).

| Method | Path | Auth / permission | Purpose |
|---|---|---|---|
| GET | `/health` | public | Liveness (`status`, uptime) |
| GET | `/health/db` | public | Database readiness; 503 if unreachable |
| POST | `/auth/login` | public, rate-limited | `{email, password}` → user, permissions, session expiry; sets cookie |
| POST | `/auth/logout` | optional session | Revokes the current session, clears cookie |
| POST | `/auth/logout-all` | session | Revokes all of the user's sessions |
| GET | `/auth/me` | session | Current user, permissions, session expiry |
| PATCH | `/auth/me/preferences` | session | `{preferredLanguage: 'fr'|'ar'}` |
| POST | `/auth/change-password` | session | `{currentPassword, newPassword}`; revokes other sessions |
| GET | `/users` | `users.read` | List staff accounts |
| POST | `/users` | `users.manage` | Create account `{email, fullName, role, password, preferredLanguage?}` |
| PATCH | `/users/:id` | `users.manage` | `{fullName?, role?, isActive?, preferredLanguage?}`; deactivation/role change revokes sessions; last active manager and self-demotion are protected |
| POST | `/users/:id/reset-password` | `users.manage` | `{newPassword}`; unlocks and revokes sessions |
| GET | `/company-settings` | `company_settings.read` | Company identity and document settings |
| PUT | `/company-settings` | `company_settings.update` | Replace editable settings (strict validation; unknown fields rejected) |
| GET | `/audit-logs` | `audit_logs.read` | Newest first; `limit` (≤200), `before` (id), `action`, `actorUserId`, `outcome` |

## Role → permission matrix (migration 0001)

| Permission | Manager | Employee |
|---|---|---|
| `dashboard.view` | ✓ | ✓ |
| `company_settings.read` | ✓ | ✓ |
| `company_settings.update` | ✓ | — |
| `users.read` | ✓ | — |
| `users.manage` | ✓ | — |
| `audit_logs.read` | ✓ | — |

Audited actions: `auth.login` (success/failure with reason), `auth.logout`, `auth.logout_all`,
`auth.password_change`, `authz.denied`, `user.create`, `user.update`, `user.deactivate`,
`user.password_reset`, `company_settings.update` (with field-level before/after).

## Slice 2b — vehicle documents, photos and files

All routes need a session; changes need `X-Requested-With: fleetora`. Branch scope applies: a vehicle outside the user's branches answers 404.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/vehicles/:id/documents[?includeArchived=true]` | `vehicles.read` | `status`: valid, expiring (≤ 30 days), expired, no_expiry, archived; `daysLeft` |
| POST | `/api/vehicles/:id/documents` | `vehicles.documents` | JSON `{docType, label?, number?, issuer?, issueDate?, expiryDate?, notes?}`; `label` required for `other`; 409 if the vehicle is retired |
| PUT | `/api/vehicles/:id/documents/:docId` | `vehicles.documents` | same body; archived documents cannot be edited |
| POST | `/api/vehicles/:id/documents/:docId/archive` | `vehicles.documents` | `{reason}` required |
| PUT | `/api/vehicles/:id/documents/:docId/file` | `vehicles.documents` | raw body = the file; `Content-Type` must match the real content (JPEG/PNG/WebP/PDF); optional `X-File-Name` (URI-encoded) |
| GET | `/api/vehicles/:id/photos` | `vehicles.read` | active photos |
| POST | `/api/vehicles/:id/photos` | `vehicles.documents` | raw body = one image (JPEG/PNG/WebP); optional `X-File-Name`, `X-Caption`; the same image again answers 200 `duplicate: true` |
| POST | `/api/vehicles/:id/photos/:photoId/archive` | `vehicles.documents` | hidden from the gallery, file kept |
| GET | `/api/vehicles/:id/files/:fileId` | `vehicles.read` | only files linked to that vehicle (documents or photos, archived included) |
| GET | `/api/vehicles?docs=alert` | `vehicles.read` | vehicles with an expired or soon-expiring document |
| GET | `/api/vehicles/summary` | `vehicles.read` | now also `documents: {expired, expiring}` (counts of documents) |

Upload errors: 400 `empty_file`, 413 too large (`MAX_UPLOAD_MB`, default 10), 415 `unsupported_file` / `type_mismatch`.
Account: `POST /api/auth/change-password` `{currentPassword, newPassword}` (400 `invalid_current_password`), `POST /api/auth/logout-all`; manager: `PATCH /api/users/:id {role}` (409 `last_manager` / `self_lockout`), `POST /api/users/:id/reset-password {newPassword}`.

## Slice 2c — customers

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/customers[?q=&filter=]` | `customers.read` | `q`: name, e-mail, part of a phone (any format) or document number; `filter`: `pending_documents`, `expired_documents`, `blocked`; 100 most recent |
| GET | `/api/customers/summary` | `customers.read` | `{total, blocked, pendingDocuments}` |
| GET | `/api/customers/:id` | `customers.read` | `idDocStatus` / `licenceStatus`: valid, expiring (≤ 30 days), expired |
| POST | `/api/customers` | `customers.manage` | 409 `possible_duplicate` with `details.matches` (reasons phone / id_document / licence) unless `acknowledgeDuplicates: true` |
| PUT | `/api/customers/:id` | `customers.manage` | same body and duplicate rule (ignoring itself) |
| POST | `/api/customers/:id/block` · `/unblock` | `customers.block` | `{reason}` required (3–500 characters) |
| GET | `/api/customers/:id/documents[?includeArchived=true]` | `customers.read` | scans with review status |
| POST | `/api/customers/:id/documents?kind=` | `customers.manage` | raw body = the file (JPEG/PNG/WebP/PDF); `alsoLinkedTo` lists other customers with the same file; same file again answers 200 `duplicate: true` |
| POST | `/api/customers/:id/documents/:docId/review` | `customers.verify` | `{status: verified \| rejected, note}`; note required to reject |
| POST | `/api/customers/:id/documents/:docId/archive` | `customers.manage` | `{reason}` |
| GET | `/api/customers/:id/files/:fileId` | `customers.read` | only scans of that customer |

## Slice 3 — reservations

Times are local Africa/Casablanca `YYYY-MM-DDTHH:mm`; money is integer centimes of MAD.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/reservations?view=&status=&customerId=&vehicleId=&q=` | `reservations.read` | `view`: upcoming (default), departures_today, returns_today, past, all; `q`: reference (R-00012), customer name, plate; branch scope applies |
| GET | `/api/reservations/summary` | `reservations.read` | `{departures, returns, upcoming}` |
| GET | `/api/reservations/availability?start=&end=[&branchId=&excludeReservationId=]` | `reservations.read` | vehicles in scope with `available` and `conflictReference` |
| POST | `/api/reservations/quote[?excludeReservationId=]` | `reservations.manage` | same body as create; returns days, prices, total, deposit, `warnings`, `conflicts`; saves nothing |
| GET | `/api/reservations/:id` | `reservations.read` | reservation + `events` history |
| POST | `/api/reservations` | `reservations.manage` | `{customerId, vehicleId, start, end, pickupPlace, pickupDetails?, returnPlace, returnDetails?, returnBranchId?, dailyCents?, priceReason?, depositCents?, notes?}`; 409 `vehicle_unavailable`, `customer_blocked`, `vehicle_retired`; a `dailyCents` different from the vehicle price needs `pricing.change` (403) and `priceReason` (400) |
| PUT | `/api/reservations/:id` | `reservations.manage` | confirmed only; same customer; changes recorded in `events` |
| POST | `/api/reservations/:id/cancel` · `/no-show` · `/reopen` | `reservations.manage` | `{reason}` required; no-show only after the pickup time; reopen re-checks availability |

Vehicles: `dailyRateCents` and `depositCents` added to create/edit; retiring a vehicle with upcoming reservations answers 409 `has_reservations`.

## Slice 4 — contracts, payments, templates

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/contracts?status=open\|late\|closed\|all&customerId=&vehicleId=&q=` | `contracts.read` | branch scope |
| GET | `/api/contracts/summary` | `contracts.read` | `{open, late, returnsToday}` |
| GET | `/api/contracts/:id` | `contracts.read` | contract (with frozen `snapshot`), `balances`, drivers, photos, events, payments, template version used |
| POST | `/api/contracts/checkout` | `contracts.manage` | `{reservationId, paperNumber?, kmOut, fuelOut, washedOut?, documentsOut[], notesOut?, drivers[], payments[]}`; 409 `vehicle_not_ready`, `paper_number_used`, `customer_blocked`, `driver_too_young`, `reservation_past`; 422 `mileage_decrease` |
| POST | `/api/contracts/:id/extend` | `contracts.extend` (manager; delegable) | `{newEnd, reason?}`; 409 `vehicle_unavailable` (migration 0009) |
| GET | `/api/contracts/:id/return-preview` | `contracts.read` | `{lateMinutes, graceMinutes, proposedExtraDays}` |
| POST | `/api/contracts/:id/checkin` | `contracts.manage` | `{kmIn, fuelIn, notesIn?, cleaned?, late?}` — see "Branding and late returns" below (the older `extraDays` fields were replaced by the manager's late decision, migration 0008) |
| POST | `/api/contracts/:id/payments` | per kind | `{kind: rental\|deposit_in\|deposit_out\|deposit_kept, method, amountCents, reference?, reason?}`; rental = cash/transfer; `deposit_out` needs `deposits.refund`, `deposit_kept` needs `deposits.retain` + reason; 409 `overpayment`, `deposit_exceeded` |
| POST | `/api/contracts/:id/payments/:paymentId/reverse` | `payments.reverse` | `{reason}`; once per entry |
| PUT | `/api/contracts/:id/paper-number` | `contracts.manage` | `{paperNumber}` unique |
| PUT | `/api/contracts/:id/signed-scan` · POST `/api/contracts/:id/photos?phase=out\|in` | `contracts.manage` | raw file body |
| POST | `/api/contracts/:id/drivers` | `contracts.manage` | other driver |
| GET | `/api/contracts/:id/files/:fileId` | `contracts.read` | photos, signed scan and the logo printed on it only |
| GET | `/api/contract-templates/current` | `contracts.read` | |
| GET · POST | `/api/contract-templates` | `contracts.templates` | list versions · save a new version |
| PUT · GET | `/api/company-settings/logo` | `company_settings.update` · `.read` | raw PNG/JPEG/WebP |

Company settings body also takes `phone2`, `minDriverAge`, `newLicenceYears`, `maxContractDays`, `lateGraceMinutes`. Customers take `profession`, `otherAddress`, `idDocIssueDate`. Reservation warnings add `customer_birthdate_missing`, `customer_licence_new`, `over_max_days`; 409 `driver_too_young`.

## Branding and late returns (2026-11-04)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/branding` | public | `{name, city, color, logo}` only |
| GET | `/api/branding/logo` | public | company logo (if branding shown) |
| GET | `/api/contracts/:id/return-preview` | `contracts.read` | `{lateMinutes, graceMinutes, isLate, suggestions: {day, half_day, hour}, unitPrices}` |
| POST | `/api/contracts/:id/checkin` | `contracts.manage` | optional `late: {decision: charge\|waive, unit, quantity, unitCents, reason}` (needs `pricing.change`); otherwise a late return stays `pending` |
| POST | `/api/contracts/:id/late-fee` | `pricing.change` | decide or change (reason needed to change or waive) |
| GET | `/api/contracts?status=late_fee` · summary `lateFeePending` | `contracts.read` | |

## Audit fixes (2026-11-05, migration 0009)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/system/status` | `company_settings.update` | `{storage: {persistentConfigured, warning}, backup: {last, lastOkAt, overdueHours, warning}}` — no paths or secrets |

Other drivers (`drivers[]` at check-out, `POST /api/contracts/:id/drivers`) now require `birthDate` and `licenceNumber`; under the minimum age → 409 `driver_too_young`. `minDriverAge` cannot be below 18 (400; database constraint).

## Slice 5 — cash, maintenance, reminders, reports
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET · POST | `/api/cash/expenses` | `cash.read` · `expenses.record` | `{branchId, vehicleId?, category, amountCents, method, spentOn?, supplier?, reference?, notes?, receiptFileId?}`; receipt must be uploaded by the same person |
| POST | `/api/cash/expenses/receipt` | `expenses.record` | raw file → `{fileId}` |
| POST | `/api/cash/expenses/:id/reverse` | `payments.reverse` | `{reason}` |
| GET | `/api/cash/expenses/:id/receipt` | `cash.read` | branch scope |
| GET | `/api/cash/day?branchId=&date=` | `cash.read` | totals by method, expected cash, movements, closing |
| POST | `/api/cash/close` | `cash.close` | `{branchId, date, countedCashCents, notes?}`; reason required if difference; 409 `already_closed` |
| GET | `/api/cash/closings` | `cash.read` | |
| GET | `/api/maintenance/due` · `/summary` · `/vehicles/:id` | `vehicles.read` | status due / soon / ok / unknown |
| POST | `/api/maintenance/vehicles/:id/plans` · `/plans/:planId/archive` · `/records` | `vehicles.maintenance` | record `{planId?, item, doneOn, km, garage?, costCents?, paidWith?}` (paidWith books an expense) |
| GET | `/api/reminders` | `reminders.send` | prepared messages with `wa.me` link |
| POST | `/api/reminders/sent` | `reminders.send` | `{kind, refId}` — the person confirms sending |
| GET | `/api/reports/summary?from=&to=&branchId=` | `reports.read` | |
| GET | `/api/reports/export.csv?type=payments\|expenses&from=&to=` | `reports.read` | CSV `;` UTF-8 BOM |

## Home screen — fleet overview
- `GET /api/fleet/overview` (`vehicles.read`, branch scope) → `{ counts, total, attention, late, items[] }`. Each item: `id, plate, make, model, status, mileageKm, fuelEighths, branch{id,name}`, `contract` (open contract: `id, number, outAt, plannedEndAt, late, customer, phone` — `null` without `contracts.read`; customer/phone `null` without `customers.read`), `nextReservation` (next confirmed: `id, number, startAt, endAt, customer` — `null` without `reservations.read`), `documents` (`alert: expired|expiring, nextType, nextExpiry`), `maintenance` (`status: due|soon, due, soon, next`), `needsAttention`. Retired vehicles excluded; attention first.
