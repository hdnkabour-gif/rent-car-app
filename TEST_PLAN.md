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

| 2026-11-04 | Slice 2c CI | GitHub Actions run 41836631293 | ci.yml | success |
| 2026-11-04 | Slice 3 (local working tree) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, `npm test -w server`, `npm test -w web`, build | server 202/202, web 48/48, all passed |
| 2026-11-04 | Backup / restore drill (CLI) | same, synthetic `fleetora_demo_dev` | `backup`, `verify-backup`, `restore-backup` into a new empty database, second restore, `check-files` | all as expected (see `BACKUP_RESTORE.md`) |
| 2026-11-04 | Slice 3 browser walkthrough | Playwright Chromium, desktop FR + phone AR | ad-hoc script (not committed) | 15/15 after 2 fixes |

| 2026-11-04 | Slice 3 CI | GitHub Actions run 41859129489 | ci.yml | success |
| 2026-11-04 | Slice 4 (local working tree) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, `npm test -w server`, `npm test -w web`, build | server 214/214, web 55/55, all passed |
| 2026-11-04 | Slice 4 browser walkthrough + PDF | Playwright Chromium, desktop FR + phone AR; `page.pdf` A4 | ad-hoc script (not committed) | 17/17 after fixes; PDF = 2 pages |

| 2026-11-04 | Slice 4 CI | GitHub Actions run 41866254231 | ci.yml | success |
| 2026-11-04 | Branded UI + late fees (local) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, tests, build | server 217/217, web 59/59 |
| 2026-11-04 | Full walkthrough, all pages and operations | Playwright Chromium, desktop FR (manager) + Pixel 7 AR (new employee) | ad-hoc script (not committed) | 49/49; no 5xx, console or external requests |

| 2026-11-05 | Audit fixes (local) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, `npm test -w server`, `npm test -w web`, build | server 221/221, web 62/62, all passed |
| 2026-11-05 | Encrypted backup drill (CLI) | same, synthetic `fleetora_demo_dev` (28 tables, 670 rows, 14 files) | `backup` with `BACKUP_PASSPHRASE`, `verify-backup` (wrong + right passphrase), `restore-backup` into a new empty DB | exit 0 / 2 (wrong passphrase) / 0 / 0 with proof; no plaintext in the backup folder; run recorded |

| 2026-11-05 | Audit fixes CI | GitHub Actions run 41937415322 | ci.yml | success |
| 2026-11-05 | Slice 5 (local) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, tests, build | server 227/227, web 67/67 |
| 2026-11-05 | Slice 5 browser walkthrough | Playwright Chromium, desktop FR + Pixel 7 AR | ad-hoc script (not committed) | 17/17 |
| 2026-11-05 | Vehicle-first home (local) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, tests, build | server 229/229, web 68/68 |
| 2026-11-05 | Read-only crawler, local demo DB | Playwright Chromium; manager FR desktop, employee AR phone | `e2e/crawl.cjs` | see CHANGELOG / PR for the counts of this run |

| 2026-11-05 | PR #3 catalogue fixes (local) | Linux container, Node 22, PostgreSQL 16 | typecheck, lint, tests, build | server 242/242, web 71/71 |
| 2026-11-05 | 0011 on the synthetic demo DB | `fleetora_demo_dev` (pg_dump taken first) | migrate, fingerprint of 9 business tables before/after, second run | applied; no row changed; second run "up to date" |
| 2026-11-05 | Crawler after fix (logout label "Sortir" was clicked; session now checked via `/api/auth/me`) | manager FR desktop / employee AR phone | `e2e/crawl.cjs` | 53 pages, 400 buttons / 44 pages, 230 buttons; no issue |
| 2026-11-17 | #15 OCR milestone 1 (local) | dev container; OpenCV 4.10 / numpy 1.26.4 venv; production image (Tesseract) for E2E | `server/tools` unit tests; `local-ocr.test.ts`; worker run in the image on synthetic cards | Python 36/36 with OpenCV (30 + 6 skipped without); server parser 2/2; E2E: flat synthetic card (assumed cropped, no warning) and the same card photographed in perspective (corners found, corrected, no warning) both read all TD1 fields with valid check digits |
| 2026-11-17 | PR #25 gate fixes B25-1/2/3 | dev container (OpenCV venv); production image with Tesseract for E2E | `server/tools` (8 new tests); the same tests run against the previous `document_ocr.py`; old vs new worker on synthetic inputs | Python 44/44. Against the old version: B25-1 and B25-3 fail (bugs reproduced). E2E: an already-cropped card with an inner photo frame — old version cropped to the frame and read **no field**, new version keeps the card and reads every TD1 field with valid check digits. An A4 insurance PDF with a table — old version cropped to the table (**no field**), new version keeps the page (policy number partly read as `POL2026`, both dates read; plate not read on this synthetic page) |
| 2026-11-18 | PR #25 gate round 2: whole image always read after a crop | OpenCV venv + production image (Tesseract) | `test_document_fallback.py` (fake OCR engine), `test_document_mrz.py` (2 new) | the fallback test failed on `8a99247`. The real Tesseract run first showed the extra pass polluting a clean reading (junk optional data, false `mrz_composite_failed` / `ocr_disagreement`); after the MRZ-unit rule, the photo gives all TD1 fields with no warning. Python 47/47 |
| 2026-11-18 | PR #25 gate round 3: per-field MRZ merge | OpenCV venv + production image (Tesseract) | `test_document_mrz.py` (3 new) | the dates case and the disagreement case failed on `0a4c844`; Python 50/50. Real Tesseract on the synthetic photo and on the cropped card: every TD1 field, no warning |
| 2026-11-05 | Browser: create a vehicle from the catalogue | Playwright, manager FR | ad-hoc script | Dacia Logan + generation + dCi 95 saved and shown on the vehicle page |

## Read-only crawler (`e2e/crawl.cjs`)
Visits every page reachable by links and clicks every button except print/logout/language, as one account. It checks with the server that it is still logged in and reports `SESSION_LOST` otherwise (earlier runs in French clicked "Sortir" and silently crawled logged out — those runs, including the first Railway run, were incomplete).
Every write (POST/PUT/PATCH/DELETE other than login/logout) is blocked in the browser, so it cannot change data and can be run against the Railway demo with a **demo** account.
Reports: 5xx responses, browser console errors, uncaught errors, generic error screens, broken API links, and any request to another site. Business messages (e.g. "vehicle not inspected") are listed separately.
```bash
E2E_BASE_URL=http://127.0.0.1:3100 E2E_EMAIL=manager@example.test E2E_PASSWORD=… node e2e/crawl.cjs
```
Options: `E2E_LANG=ar`, `E2E_MOBILE=1`, `E2E_MAX_PER_ROUTE=3`. Requires Playwright (pre-installed in the dev container, not a project dependency). It does not test submitting forms — the automated tests and walkthroughs cover that.

Not yet run: on the Windows 11 test PC; over Wi-Fi/VPN from a real phone; backup/restore drill; real-employee usability session (`docs/USABILITY_TEST_PLAN.md`).

## Release rule
Record test command, environment, date, result and limitations. Never report a test as passed unless actually executed.