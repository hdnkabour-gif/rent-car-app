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

## Recorded runs
| Date | Scope | Environment | Command | Result |
|---|---|---|---|---|
| 2026-11-02 | Slice 1 backend | Linux container, Node 22.23, PostgreSQL 16 | `npm test -w server` | 80/80 passed |
| 2026-11-02 | Slice 1 frontend | same, jsdom | `npm test -w web` | 11/11 passed |
| 2026-11-02 | Typecheck, lint, build | same | `npm run typecheck && npm run lint && npm run build` | passed |
| 2026-11-02 | Browser walkthrough | Playwright Chromium, 1280×800 and 390×844 | ad-hoc script (not committed) | 20/20 checks passed |
| 2026-11-02 | UX refresh rerun | same | `npm test`, typecheck, lint, build | server 80/80, web 11/11, all passed |
| 2026-11-02 | UX refresh browser walkthrough | Playwright Chromium, 1280×800 and 390×844, FR and AR | ad-hoc script (not committed) | 27/27 checks passed |
| 2026-11-02 | Review fixes | Linux container, Node 22, PostgreSQL 16 | `npm test`, typecheck, lint, build | server 99/99, web 15/15 |
| 2026-11-02 | seed:dev guard via CLI | same | `npm run seed:dev -w server` with bad env / DB name / host / real-looking account | all refused, exit code 1; synthetic DB accepted |
| 2026-11-02 | Hardening + CI branch (local) | Linux container, Node 22, PostgreSQL 16 | `npm test`, typecheck, lint, build; plus full suite against a brand-new empty test DB | server 113/113 (corrected from 112, see CI run 41373749428), web 15/15 |
| 2026-11-02 | Slice 2a (local working tree) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, `npm test -w server`, `npm test -w web`, build | server 149/149, web 19/19; rerun after the Railway preparation: server 156/156, web 19/19, all passed |
| 2026-11-02 | Slice 2a build safety | same | build with a deliberate type error | build failed, no `dist` left; file restored identical |
| 2026-11-02 | Slice 2a test cleanup on failure | same | a deliberately failing test file | run database dropped; temporary file removed |
| 2026-11-02 | Slice 2a seed safety (CLI) | same | `seed-dev.ts` on populated `fleetora_dev` | refused, exit code 1 |
| 2026-11-02 | Slice 2a browser walkthrough | Playwright Chromium, desktop FR/AR + phone AR, fresh `fleetora_demo_dev` | ad-hoc script (not committed) | 23 checks, 0 failures |
| 2026-11-02 | Railway demo simulation (local) | same, `NODE_ENV=production`, fresh database | config's build, preDeploy, seed:demo and start commands; curl checks | build/migrations OK; seed:demo refusals OK; 401 without login; secure `__Host-` cookie; HSTS; cross-site login 403 |

| 2026-11-03 | Slice 2b (local working tree) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, `npm test -w server`, `npm test -w web`, build | server 169/169 (incl. 13 vehicle-docs tests), web 31/31, all passed |
| 2026-11-03 | Slice 2b browser walkthrough | Playwright Chromium, desktop FR + phone AR (Pixel 7), synthetic `fleetora_demo_dev`, generated PNG/PDF | ad-hoc script (not committed) | 22 checks, 0 failures (document statuses, PDF bytes identical, fake image refused, photo dedupe, alerts, filter, account, no overflow, no external requests) |

| 2026-11-04 | Slice 2c (local working tree) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, `npm test -w server`, `npm test -w web`, build | server 183/183 (incl. 13 customer tests), web 40/40, all passed |
| 2026-11-04 | Slice 2c browser walkthrough | Playwright Chromium, desktop FR + phone AR, synthetic data | ad-hoc script (not committed) | 18 checks; 1 failure found and fixed (letters in a search matched phone digits), rerun 18/18 |
| 2026-11-04 | Slice 2b CI | GitHub Actions run 41833812278 | ci.yml | success |

Not yet run: on the Windows 11 test PC; over Wi-Fi/VPN from a real phone; backup/restore drill; real-employee usability session (`docs/USABILITY_TEST_PLAN.md`).

## Release rule
Record test command, environment, date, result and limitations. Never report a test as passed unless actually executed.