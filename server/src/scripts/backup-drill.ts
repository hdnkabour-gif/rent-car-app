/**
 * Restore drill (issue #14): newest complete OFF-SITE backup (or BACKUP_DIR with --local) -> detached
 * folder -> verify every SHA-256 -> restore into a NEW database created for the drill + empty storage ->
 * prove -> negative checks -> drop. The source database and its files are never written, except one
 * evidence row in backup_drills when DATABASE_URL is set (counts only).
 *   DRILL_ADMIN_DATABASE_URL=<connection allowed to CREATE DATABASE, e.g. .../postgres>
 *   BACKUP_PASSPHRASE=... OFFSITE_KIND=... (or --local with BACKUP_DIR=...)
 *   [DATABASE_URL=<app database, to record the result>] [DRILL_REPORT=<file for the JSON evidence>]
 *     npm run backup-drill -w server [-- --local] [-- --backup <name>] [-- --keep]
 * Exit 0 = proven; 1 = the drill failed (see the report).
 */
import { writeFile } from 'node:fs/promises';
import { recordDrill } from '../backup/backup.js';
import { runDrill } from '../backup/drill.js';
import { offsiteFromEnv } from '../backup/offsite.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const args = process.argv.slice(2);
const local = args.includes('--local');
const backupName = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : undefined;
const { DRILL_ADMIN_DATABASE_URL, DATABASE_URL, BACKUP_PASSPHRASE, BACKUP_DIR, DRILL_REPORT } = process.env;
if (!DRILL_ADMIN_DATABASE_URL) {
  console.error('drill refused: set DRILL_ADMIN_DATABASE_URL (a connection allowed to CREATE DATABASE; the drill database is new and dropped afterwards).');
  process.exit(1);
}
if (DATABASE_URL && new URL(DRILL_ADMIN_DATABASE_URL).pathname === new URL(DATABASE_URL).pathname && new URL(DRILL_ADMIN_DATABASE_URL).host === new URL(DATABASE_URL).host) {
  console.error('drill refused: DRILL_ADMIN_DATABASE_URL must not point at the application database (use the maintenance database, e.g. /postgres).');
  process.exit(1);
}
const startedAt = new Date();
try {
  const target = local ? null : offsiteFromEnv();
  if (!local && !target) throw new Error('no off-site target configured (OFFSITE_KIND); use --local with BACKUP_DIR for a local drill');
  if (local && !BACKUP_DIR) throw new Error('--local needs BACKUP_DIR');
  const report = await runDrill({
    adminDatabaseUrl: DRILL_ADMIN_DATABASE_URL, passphrase: BACKUP_PASSPHRASE || undefined, target,
    localBackupDir: BACKUP_DIR, backupName, keep: args.includes('--keep'),
  });
  const json = JSON.stringify(report, null, 2);
  if (DRILL_REPORT) await writeFile(DRILL_REPORT, json, { mode: 0o600 });
  say(json);
  if (DATABASE_URL) {
    const failed = [...report.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.detail}`), ...report.negative.filter((n) => !n.passed).map((n) => `${n.check}: ${n.detail}`)];
    await recordDrill(DATABASE_URL, {
      startedAt, ok: report.ok, source: report.source, offsiteKind: report.offsiteKind, backupName: report.backupName,
      tables: report.tables, rowsTotal: report.rowsTotal, filesVerified: report.filesVerified,
      negativePassed: report.negative.filter((n) => n.passed).length, negativeTotal: report.negative.length,
      message: failed.length ? failed.join(' | ') : null,
    });
  }
  say(report.ok ? 'DRILL PASSED: the backup was restored into an isolated database and every checksum matched.' : 'DRILL FAILED: see the report above.');
  process.exit(report.ok ? 0 : 1);
} catch (e) {
  console.error(`drill FAILED: ${(e as Error).message}`);
  if (DATABASE_URL) {
    await recordDrill(DATABASE_URL, {
      startedAt, ok: false, source: local ? 'local' : 'offsite', offsiteKind: null, backupName: backupName ?? null,
      tables: null, rowsTotal: null, filesVerified: null, negativePassed: 0, negativeTotal: 0, message: (e as Error).message,
    }).catch(() => undefined);
  }
  process.exit(1);
}
