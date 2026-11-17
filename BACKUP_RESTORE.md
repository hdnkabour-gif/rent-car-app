# Backup and Restore

## Backup scope
A recovery set includes PostgreSQL data, private uploaded files, storage metadata/configuration, migration version and required non-secret configuration. Secrets belong only in an approved secure secret-management process, never repository archives.

## Policy to agree before production
Automated encrypted database backups; file/object storage backup or versioning; retention schedule and off-site copy; restricted administrator access; monitoring and failure alerts; agreed recovery point objective (RPO) and recovery time objective (RTO).

## Restore procedure
1. Declare recovery and stop writes if needed.
2. Provision a clean, access-restricted environment.
3. Restore database and matching file backup.
4. Apply only migrations appropriate to the restored version.
5. Verify record counts, file checksums/availability and key rental/finance workflows.
6. Re-enable access only after validation and record the recovery event.

Perform restore drills before production and periodically. Backup completion without a successful restore test is not sufficient evidence of recoverability.
## Implemented tools (slice 3, 2026-11-04)
Run on the company host (needs the PostgreSQL client tools `pg_dump` / `pg_restore`, same major version as the server or newer). Build once with `npm run build`.

| Command | What it does |
|---|---|
| `npm run backup -w server` (env `DATABASE_URL`, `STORAGE_DIR`, `BACKUP_DIR`) | Creates `BACKUP_DIR/fleetora-backup-<UTC time>/` with `database.dump` (pg_dump custom format), `files/` (every stored file) and `manifest.json` (migrations, row count per table, SHA-256 of the dump and of every file). Re-reads and verifies the result. Exit 0 = complete and verified, 2 = saved but problems found (missing or damaged file in storage), 1 = failed. A backup folder is never overwritten. |
| `npm run verify-backup -w server -- <folder>` | Checks the dump and every file byte for byte against the manifest; `pg_restore --list` must read the dump. |
| `npm run restore-backup -w server -- <folder>` (env `DATABASE_URL` of a NEW EMPTY database, `STORAGE_DIR`, `FLEETORA_RESTORE_TARGET=<that database name>`) | Refuses a damaged backup, a non-empty database, or a storage file that differs. Restores in one transaction, copies the files, then proves the result: same row counts, same migrations, every file present with its checksum. |
| `npm run check-files -w server` | Live check that every stored file exists in `STORAGE_DIR` and still has its checksum. |

What a backup contains: all company records and all uploaded files. What it never contains: passwords in clear (only scrypt hashes), session tokens in clear (only their SHA-256), `.env` or other secrets.

### Encryption (2026-11-05)
Set `BACKUP_PASSPHRASE` (12+ characters) for the backup, verify and restore commands: the dump and every file are then stored encrypted (AES-256-GCM, key derived with scrypt; the manifest keeps only checksums and counts). Keep the passphrase in the company password manager — **a lost passphrase makes the backups unreadable**. Without it the backup tool prints a warning; store such backups only on an encrypted disk.

### Scheduling templates
`ops/backup-nightly.ps1` (Windows Task Scheduler) and `ops/backup-nightly.sh` (cron). Each run appends to `BACKUP_DIR/backup-log.txt` and is recorded in the app (`backup_runs`); the manager sees on the home screen when the last backup failed or is older than 36 hours.

### Recommended schedule for the company host (to confirm with the owner and IT)
1. Every night: `npm run backup` to a second disk of the server (Windows Task Scheduler or cron).
2. Every week: copy the newest backup folder to an external disk kept outside the server room (or an approved encrypted off-site copy). The backup contains personal data: store it encrypted (e.g. BitLocker on the external disk) and restrict access.
3. Every month, and after every upgrade: restore drill into a new empty database on the test PC with `restore-backup`, and record the result in `TEST_PLAN.md`.
4. Keep at least 14 daily, 8 weekly and 12 monthly backups (retention to be confirmed: BUSINESS_RULES open question 6). The tools never delete backups; old folders are removed by the administrator only.

### Database protections that complement backups
- Business tables cannot be deleted or truncated (`0005_no_delete_business_data`): users, company settings, branches, vehicles, vehicle documents and photos, customers, customer scans, reservations. Audit log, vehicle status history and reservation history are append-only. Stored files are immutable.
- Records are deactivated, archived or cancelled instead, with the reason and the person recorded.

Evidence (2026-11-04, local, synthetic data): automated test `server/test/backup.test.ts` (backup → verify → restore into a new database with proof → damaged backup refused → missing file reported) and a CLI drill on `fleetora_demo_dev` (21 tables, 179 rows, 5 files: backup exit 0, verify exit 0, restore without confirmation refused, restore exit 0 with proof, second restore onto the now non-empty database refused). Not yet run on the company host or on Windows.

## بالعربية — النسخ الاحتياطي باختصار
- كل ليلة: `npm run backup` → مجلد فيه قاعدة البيانات وكل الملفات مع بصمة SHA-256 لكل شيء، ويتحقق منه تلقائياً.
- كل أسبوع: انسخ آخر مجلد إلى قرص خارجي مشفّر يُحفظ خارج مكان الخادم.
- كل شهر: تجربة استرجاع في قاعدة جديدة فارغة على حاسوب التجربة (`restore-backup`). الاسترجاع يرفض أي قاعدة غير فارغة، فلا يمكن أن يمسح بيانات موجودة.
- قاعدة البيانات نفسها تمنع حذف السجلات (السيارات، الزبناء، الحجوزات، الوثائق…): كل شيء يُؤرشف أو يُلغى مع السبب.

## Missing or damaged stored files — diagnostic and recovery (2026-11-17, issue #16)
`npm run files-report -w server` (env `DATABASE_URL`, `STORAGE_DIR`, optionally `BACKUP_DIR=<folder>[,<folder>…]` and `BACKUP_PASSPHRASE`).

**Status of every `stored_files` row:**
| Status | Meaning |
|---|---|
| `ok` | Present with its SHA-256. |
| `damaged` | Bytes differ. Never overwritten automatically. |
| `missing_recoverable` | Not on disk, but a backup folder lists it. |
| `missing_unavailable` | Not on disk and in no backup. |

For each file, the report also shows **which records use it** (table and column, row ids only: no names, no content).

**How it behaves:**
- **Read-only by default.** It reads the database in a single read-only transaction.
- **`--apply`** copies back only missing files whose bytes, decrypted from a backup, have exactly the recorded SHA-256.
  - It never overwrites, never deletes, never creates or changes a row, and never invents content.
  - A file no backup holds stays reported as missing.
- **Damaged file:** move the damaged copy aside, then run again with `--apply`.
- **Exit codes:** 0 = all files present and intact; 2 = problems remain; 1 = the check failed. `--json` gives the machine-readable report.
- **Off-site copies** (after PR #23): pull the backup into a folder with the drill tooling or `pullBackup`, then pass that folder in `BACKUP_DIR`.

**Fixes after the integration gate on PR #24 (B24-1):**
- Each recovery attempt writes its own uniquely named temporary file and removes it whatever happens. A disk-full error in the middle no longer leaves a file that blocked every later attempt.
- Leftovers of an interrupted run are removed before the next attempt. Only our own temporary names are touched (`<file>.recovering`, `<file>.recovering-<16 hex>`), never a stored file, a link or anything else.
- The final name is created with `link()`, which fails if a file appeared there meanwhile: recovery never overwrites.
- **Gate round 2:** leftovers are removed only when **older than one hour**.
  - A younger temporary file may belong to another recovery still running, so it is left alone. Unique names mean it cannot block this attempt anyway.
  - Tested with two synchronised recoveries of the same file: the second one no longer deletes the first one's live file. That test failed on `3397a3a`.

**Railway staging — the two historical missing synthetic files (#16):** this must be run by someone with staging access. Claude Code has none. Run inside the staging service:
```
STORAGE_DIR=/data/files BACKUP_DIR=<folder holding any staging backups> npm run files-report -w server -- --json
```
- Record in #16 the status and the `usedBy` references of the two rows: synthetic data only, no content.
- If a backup holds the bytes, `--apply` restores them identically.
- If none does, the rows stay as they are and the app keeps answering "file missing" (410) for them. **Do not delete the rows or upload look-alike files.**
