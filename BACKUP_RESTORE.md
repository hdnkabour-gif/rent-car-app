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

## Off-site copies, retention and restore drills (2026-11-17, issue #14)

**Status: implemented and tested on synthetic data in a development container.**
- Not yet proven: on the company host, with the owner's real off-site provider or disks, or with a real schedule.
- No production restore was performed.

### What protects what
| Risk | Protection |
|---|---|
| Disk or volume holding the uploads fails | `BACKUP_DIR` must never be inside `STORAGE_DIR`. In production it must be on **another disk**, unless it is only a staging area (`BACKUP_KEEP_LOCAL=false`) for the off-site copy. |
| Server stolen, fire, ransomware | **Encrypted off-site copy** after every nightly backup (`OFFSITE_KIND=dir` on an external disk / NAS, or `OFFSITE_KIND=s3` on a private bucket). Only encrypted backups can leave the host. |
| Off-site copy altered or incomplete | Each object is checked after upload (size + SHA-256). A completion marker is written last. A download is checked object by object, and the manifest is authenticated (HMAC). |
| "We have backups" but they cannot be restored | Monthly `backup-drill`: newest off-site copy → empty detached folder → new isolated database → every SHA-256 checked → dropped. The result is recorded, and the manager is warned when no successful drill happened in 35 days. |
| A backup job silently stops | Home-screen alert: last backup missing or failed, or older than 36 h; off-site copy missing or failed. The job also returns an exit code for the scheduler. |

### Commands (built server: `npm run build`)
| Command | Exit codes |
|---|---|
| `npm run backup -w server` | 0 = verified (and copied off-site when configured); 2 = saved with problems; **3 = local backup verified but the off-site copy failed**; 1 = failed or refused. |
| `npm run backup-drill -w server` (`DRILL_ADMIN_DATABASE_URL` = maintenance DB such as `/postgres`, never the app DB) | 0 = proven; 1 = failed. Prints JSON evidence (counts, names and checksums only). Set `DRILL_REPORT=<file>` to save it. `--local` drills a `BACKUP_DIR` backup instead. |
| `npm run prune-backups -w server [-- --apply]` | Dry run by default. Keeps 14 daily / 8 weekly / 12 monthly backups (`BACKUP_KEEP_*`). Never deletes the newest backup or anything younger than 48 h. Also removes interrupted off-site uploads. |

### Settings (environment of the backup job only — never in Git)
| Variable | Meaning |
|---|---|
| `BACKUP_PASSPHRASE` | **Required in production and for any off-site copy.** At least 12 characters are enforced; generate 20+ with the password manager. |
| `BACKUP_KEY_LABEL` | Non-secret name of the passphrase generation, for example `2026-11`. It is written in each manifest, so you know which passphrase opens which backup. |
| `OFFSITE_KIND=dir` + `OFFSITE_DIR` | External disk or NAS. In production it must be another disk than both the uploads and `BACKUP_DIR`. |
| `OFFSITE_KIND=s3` + `OFFSITE_S3_BUCKET`, `OFFSITE_S3_REGION`, `OFFSITE_S3_ENDPOINT` (non-AWS), `OFFSITE_S3_PREFIX`, `OFFSITE_S3_FORCE_PATH_STYLE`, `OFFSITE_S3_ACCESS_KEY_ID`, `OFFSITE_S3_SECRET_ACCESS_KEY` | Private S3-compatible bucket. Use keys **dedicated to this bucket/prefix**, limited to put/get/list/delete. |
| `BACKUP_KEEP_LOCAL=false` | The local folder is only a staging area, deleted after a verified off-site copy. Use this on hosts whose disk is not durable, and never use the `/data` upload volume. |
| `BACKUP_OFFSITE_REQUIRED` (app server) | Shows the off-site and drill alerts. Default: on in production. |

### Provider and secret plan (owner decision — proposal D-051)
1. **Production stays on the company host (D-012).**
   - Nightly encrypted backup to a **second internal disk**.
   - An **encrypted off-site copy** right after.
2. **Off-site, choose one (or both):**
   - **A. No subscription:** two encrypted external disks (BitLocker / LUKS), mounted as `OFFSITE_DIR` and swapped every week; one is always outside the premises.
     - Weakness: the copy is only as recent as the last swap.
   - **B. Automatic, daily:** a private S3-compatible bucket from a provider the owner approves.
     - The provider only ever receives ciphertext and checksums.
     - Enable **versioning or object lock**, so a compromised server cannot erase the history.
     - A bucket lifecycle rule may replace `prune-backups --apply` off-site.
     - **The data then leaves Morocco** (even encrypted): confirm with the owner and the company's data-protection advisor (law 09-08, CNDP) **before** enabling it.
3. **Secrets:**
   - Environment of the backup job only: `/etc/fleetora/backup.env` (mode 600) on Linux, or machine environment variables for the backup account on Windows.
   - Never in Git, chat, logs or the backup itself.
4. **Railway** is a demo with fictitious data. It is never the place for real backups or real documents.

### Key recovery (read this before the first real backup)
- A lost passphrase makes every backup made with it **unreadable**. This is intended: a stolen disk or bucket reveals nothing.
- Keep the passphrase in two places:
  1. the owner's password manager;
  2. a sealed paper copy in a safe **outside** the premises.
- Two named people know where both are.
- **Rotation:**
  - choose a new passphrase and a new `BACKUP_KEY_LABEL`; new backups use them;
  - **keep the old passphrase** as long as backups made with it are retained (up to 12 months with the default retention).
- **Proof that the stored passphrase works:** the monthly `backup-drill` decrypts the newest off-site backup with the passphrase taken from the password manager. A drill that fails with "Wrong backup passphrase" is a key-recovery incident: fix it before anything else.

### Recommended schedule (company host)
| When | What |
|---|---|
| Every night 02:30 | `ops/backup-nightly.sh` / `.ps1`: backup + off-site copy. Exit code 3 = off-site failed; alert the administrator, local backup kept. |
| Every Sunday | `prune-backups` (dry run), then `--apply` once the plan looks right; add `--purge-incomplete` only to also clear old failed attempts. Or use bucket lifecycle rules. |
| First Monday of each month | `backup-drill` with the passphrase from the password manager. Keep the JSON report. The result shows on the manager's home screen. |
| After every upgrade | One more `backup-drill`. |
Legal retention of customer documents is still the owner's decision (BUSINESS_RULES open question 6). The defaults above only bound how many backups are kept.

### Fixes after the integration gate on PR #23 (2026-11-17)
- **B23-1, retention only counts complete backups:**
  - A local folder is complete only when its `manifest.json` exists and passes the strict schema. That file is written last, after the dump and every file.
  - Failed or interrupted runs never protect or displace anything: the newest **complete** backup is always kept.
  - Failed attempts older than the minimum age are listed as "incomplete" and removed with `--apply`.
  - The drill also picks the newest complete backup.
  - Test: one good backup 16 days old, two newer failed folders, policy daily=1 / weekly=0 / monthly=0. The old planning deleted the good backup; the new one keeps it.
- **B23-2, no authentication downgrade:**
  - An encrypted backup whose manifest is not authenticated is **refused**: format 1, whether made before 2026-11-17 or a format-2 manifest edited back to 1 without its MAC.
  - Only for a known legacy backup, an operator may set `BACKUP_ALLOW_UNAUTHENTICATED_LEGACY=true` for `verify-backup` / `restore-backup`. The tools then print a warning that the manifest is **not** authenticated; file contents and the restore proof are still checked, so altered counts still fail the proof.
  - `backup-drill` never accepts the opt-in.
  - An **unencrypted** backup found off-site is refused at download: off-site copies are always encrypted.
  - Mutation check: without the rule, the three downgrade tests fail.

### Gate round 2 on PR #23 — only verified backups count (2026-11-18)
- **Three states for a local backup:**
  - **verified:** valid manifest, no recorded problem, and a `VERIFIED.json` receipt for exactly that manifest;
  - **unverified:** problems recorded, or never verified;
  - **incomplete:** no valid manifest.
- **The receipt** is written by the backup job only after a full, clean verification. Changing the manifest voids it. It is never copied off-site.
- `verify-backup … --write-receipt` certifies an older backup after a full verification. It writes nothing for a backup accepted only through the legacy opt-in.
- **Retention plans verified backups only.** Unverified ones are never deleted by the tool and never protect anything. With no verified backup, no backup is deleted at all.
- **`prune-backups --apply` first re-verifies the newest verified backup in full** (one per run, so the cost stays bounded). If that fails — disk damage since the receipt, or a wrong passphrase — **nothing is deleted**.
- **Tests:**
  - a newer backup with problems — this test failed on the previous head;
  - a newer manifest with a corrupted dump;
  - damage after the receipt (deletion refused);
  - a receipt voided by a manifest change;
  - no verified backup at all;
  - the receipt is never sent off-site.

### Gate round 3 on PR #23 — fail closed (2026-11-18)
- **With no verified backup, `--apply` deletes nothing at all, not even old incomplete attempts.** A partial dump in a failed folder might be the only salvageable copy.
- **Old incomplete attempts are deleted only with the explicit `--purge-incomplete`,** and only after the newest verified backup has just passed a full re-verification.
- **Right before deleting, each target is re-checked:** same state as planned, a real directory (not a link), and the backup folder itself unchanged. Anything that changed meanwhile is spared and reported.
- **Tests:** zero verified backups (with and without the flag), the explicit purge, and a folder that gains a valid manifest between planning and deletion. All three failed on `acf60ee`.

### Recovery targets (proposal — owner to confirm; RC-05 of the independent audit #22)
| Target | Proposed value | How it is measured |
|---|---|---|
| **RPO**: data that may be lost | ≤ 24 h when the copy goes to an S3 bucket every night. **≤ 7 days** for the off-site part when relying only on weekly disk swaps; the second internal disk still gives ≤ 24 h unless the whole server is lost. | `backup_runs`: time of the last run with `offsite_ok`. The home alert fires after 36 h. |
| **RTO**: time to be working again on a replacement machine | ≤ 4 h with the documented procedure (install, restore, check). | Each `backup-drill` reports the duration of every step. The synthetic drill restored in about 0.7 s; production-size data must be timed at the first drill on the company host. |
- Local checksum success and off-site recoverability are reported **separately**: exit code 0 vs 3, `ok` vs `offsite_ok`, and backup alert vs off-site alert.
- Only a successful drill proves recoverability.

### Integrity rules added after the independent audit (#22)
- **RC-01, one snapshot:**
  - `pg_dump --snapshot` uses a snapshot exported by a read-only `REPEATABLE READ` transaction, and the record counts and file list are read in that same transaction.
  - Writes committed during the backup are in none of them, so the manifest always matches the dump.
  - Test: a branch and a file committed during the backup are absent from both, and the restore proof passes. Mutation check: without `--snapshot` the same test fails.
- **RC-02, a backup's own paths are never trusted:**
  - Before anything is read or written: a strict, bounded manifest schema, where every key must be the content address of its SHA-256, the dump name comes from a fixed list, and the KDF settings are bounded.
  - Every path must stay inside its folder; symbolic links are refused in the backup, in the restore destination and on an off-site disk.
  - Completion markers may only list the known object paths.
  - Tests cover the audit's traversal scenario, absolute paths, foreign keys, unknown dump names, extra fields, `N=2^30`, and links on all three sides. Mutation check: without the schema, the schema tests fail.

### Cost (estimates, to verify with current offers before choosing)
| Option | Cost |
|---|---|
| A. Two external disks of 1 TB | ≈ 1,000 – 1,800 MAD once |
| B. S3-compatible bucket | Today a backup is well under 1 MB of encrypted data. Even at 1 GB per backup with about 34 kept, it is around 34 GB: typically a few USD per month at common prices of about 0.005–0.02 USD per GB per month. A monthly drill downloads one backup. |

### Evidence (2026-11-17, development container, synthetic `fleetora_demo_dev`: 56 tables, ~1,290 rows, 14 files)
- **Backup with off-site copy to an S3 emulator (`moto` 5.1.4, private bucket):** exit 0, 16 objects verified.
  - The bucket was scanned: 30 binary objects; no `pg_dump` header, email address, PDF or JPEG signature found. Only ciphertext, plus the manifest and completion marker (counts and checksums).
- **Backup with off-site copy to a folder target:** exit 0.
- **`backup-drill` from S3 and from the folder:** both passed.
  - Every step OK; 14/14 restored files identical (SHA-256).
  - 10/10 negative checks passed: wrong passphrase, truncated dump, missing file, damaged file, altered manifest, interrupted upload, transient network failures retried, lasting outage reported, unencrypted copy refused, non-empty target refused.
  - No drill database left afterwards.
- **Off-site target unreachable:** exit 3; local backup kept; `offsite_ok=false` recorded.
- **Refusals (exit 1, recorded):**
  - production without a passphrase;
  - production with backups on the uploads disk;
  - `BACKUP_DIR` inside `STORAGE_DIR`;
  - drill pointed at the application database.
- **Production staging mode** (`BACKUP_KEEP_LOCAL=false` + S3): exit 0; local staging folder removed after the verified copy.
- **Automated tests:**
  - `server/test/offsite-backup.test.ts`: fake S3 server with transient and lasting outages, folder target, manifest MAC, locations, retention, full drill, alerts;
  - web home-alert tests.
- **Not proven yet:**
  - the owner's real disks or bucket;
  - the company host (Linux or Windows);
  - a real scheduled month;
  - a real provider outage;
  - restore time with production-size data.

## بالعربية — النسخة خارج الشركة باختصار
- **كل ليلة:** نسخة مشفّرة على قرص ثانٍ، ثم نسخة مشفّرة **خارج الشركة**: قرص خارجي يُبدَّل كل أسبوع، أو حاوية سحابية خاصة.
  - المزوّد لا يرى إلا بيانات مشفّرة.
  - إرسال البيانات خارج المغرب يحتاج قرار صاحب الشركة ومستشار حماية المعطيات (قانون 09-08 / CNDP).
- **كل شهر:** تجربة استرجاع آلية من النسخة الخارجية إلى قاعدة جديدة معزولة، مع التحقق من بصمة كل ملف، ثم تُحذف قاعدة التجربة.
- **في الرئيسية يرى المدير تنبيهاً** إذا فشلت النسخة الخارجية أو غابت، أو لم تنجح تجربة استرجاع منذ 35 يوماً.
- **كلمة سر النسخ:**
  - تُحفظ في مكانين: مدير كلمات المرور لصاحب الشركة، ونسخة ورقية مختومة في خزنة خارج الشركة؛
  - ضياعها يعني أن النسخ لا تُقرأ أبداً.

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
