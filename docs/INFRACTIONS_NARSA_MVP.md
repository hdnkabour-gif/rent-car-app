# NARSA / Infractions & Amendes — design, integration evidence, first isolated implementation

**Owner issue:** [#30](https://github.com/hdnkabour-gif/rent-car-app/issues/30).
**Baseline:** `main` `ff461900c44d0667dbe5d9e3819705f02b2b5d7b`.
**Branch:** `feature/infractions-manual-mvp-issue30-20261118`.
**Release state:** code under separate PR, **not merged, not deployed**, synthetic testing required.

## 1. Evidence / NARSA integration contract check (18 Nov 2026)

- NARSA's publicly described *Infractions routières* service provides official viewing of infractions, fine/payment status, incident dates and radar evidence when available:
  https://www.narsa-securiteroutiere.ma/fr/la-plateforme-infractions-routieres-consultation-simple-et-rapide-des-infractions-commises/
  https://infractionsroutieres.narsa.gov.ma/InfractionsRoutieres
- **Professional interface exists:** *Tasrih Saeq / Infractions PRO* at https://tasrih-saeq.narsa.gov.ma is described in the published `Guide d’utilisation du portail TASRIH-SAEQ`, intended for **legal entities including rental agencies** to consult fixed-radar offences for registered fleet vehicles and designate drivers. An accessible copy of the guide appears at https://fr.scribd.com/document/784212647/Tasrih-Saeq-Guide-utilisation . The direct professional portal did not respond to the web verification request in this session, so its live registration and detailed contractual terms are **unverified**.
- **Public/third-party API:** no official developer portal, public API contract, Swagger/OpenAPI, consumer key issuance policy or permitted external polling terms for road infractions could be confirmed after review of NARSA public pages and searches. This is **not evidence no private integration exists**. Separate NARSA partner APIs exist for other business processes (e.g. financing collateral); do not infer that they can access fines.
- Ask NARSA explicitly whether a documented agency-to-agency API / data export / partnership exists for registered rental fleets, with scopes, batch limits, access controls, rate limits, personal-data handling and written authorization. No screen scraping, CAPTCHA/OTP bypass or collection of NARSA passwords is in scope.
- Until a verifiable legal API exists, `source='manual'` is enforced by the DB itself. The app does not call NARSA.

## 2. First isolated MVP: manual authorised infraction register

- New additive migration `0019_road_infractions.sql`, without altering prior migrations or payment tables.
- Manager-only `infractions.read` and `infractions.manage` privileges. Regular employees receive neither by default. Existing branch filtering remains mandatory even if a read permission is separately delegated in a future release.
- Fields: owning vehicle (stable vehicle ID, not mutable plate alone), historical branch, issuing authority, notice/PV number, incident *local Casablanca* date/time and UTC instant, notice date separately, optional location/kind/notes, fine amount in **integer centimes MAD**, manual status, linked contract only after manager's explicit decision.
- Duplicate prevention: unique (vehicle_id, normalized issuer, normalized notice_number). Same number issued by separate authorities is not an automatic duplicate; same car & authority & number is a conflict, including after case changes.
- No automatic financial postings, payment, deposit deduction, legal driver designation, e-mail, SMS or external network access. Payment status is a *manually declared* record requiring a reference, not proof of bank settlement.
- The matching candidate query uses `contracts.out_at` through actual `in_at`; if the vehicle has **not been checked in**, even a contract past its planned return remains a **provisional** candidate. Planned return is informational, not an assumption of actual return. The candidate list does **not** prove actual responsibility, and is not bound to a customer until manager reviews original documents. Multiple candidate or no candidate are acceptable review outcomes.
- Every register, match decision/review correction and status change creates an append-only event and generic audit entry. No deleting infraction records or event rows.
- UI: separate /infractions bilingual FR/AR page (under More), link from vehicle detail; filters by car/status, manual creation and explicit manager review; links to official professional portal.
- Read model contains no customer identity and no file content. No actual government notice files are uploaded in this MVP. Private evidence storage and legal retention need separate approval.

## 3. API contracts (authenticated + CSRF)

- `GET /api/infractions?vehicleId=&status=&branchId=` — branch-scoped list, capped at 300
- `POST /api/infractions` — create a manual notice; only manager. The user supplies `occurredLocal` as `YYYY-MM-DDTHH:mm` in Africa/Casablanca. `source` cannot be set by clients.
- `GET /api/infractions/:id/candidates` — manager-only contract-time candidates for this vehicle
- `POST /api/infractions/:id/match` — explicit human review, `{contractId: UUID | null, reason}`. Confirmations for unrelated vehicle/time are rejected.
- `POST /api/infractions/:id/status` — manager status reason and reference when declaring paid.

## 4. QA gates

- SQL migration apply + idempotence and verified backup manifest update.
- Server: manager create/deduplicate, employee forbidden, branch-scoped delegated read, candidate match and wrong-car denial, append-only audit/events, cash ledger unchanged after manual status and linking, no-match decision, no arbitrary status on creation.
- Web: build/typecheck, nav permission gating, FR/AR i18n completeness, interaction tests with synthetic API fixtures.
- Test with a government-style *fictional* PV and fictional car identifiers only. No real clients or registered government credentials.
- Do not merge, stage, deploy, or treat this as an official NARSA integration until CI and independent security/business review succeed.

## 5. Future official connector (disabled)

When NARSA gives written approval and a documented interface:
1. Define a `NarsaInfractionsProvider` adapter, server-side only, default disabled, no credentials ever in the browser or Git.
2. Map official IDs and source timestamps with immutable import provenance, idempotent replay, and explicit match review.
3. Implement encrypted credentials, permissions, rate limits, monitoring, token rotation and authorized sync intervals.
4. Validate privacy requirements, contracts/consent and notification deadlines with a Moroccan legal professional before enabling customer invoicing or driver designation.
