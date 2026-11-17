/**
 * Stored-file diagnostic (issue #16): which stored files are present, damaged or missing, which records use
 * them, and whether a local backup can give them back byte for byte.
 *   DATABASE_URL=... STORAGE_DIR=... [BACKUP_DIR=<folder>[,<folder>...]] [BACKUP_PASSPHRASE=...]
 *     npm run files-report -w server [-- --json] [-- --apply]
 * Read-only by default. --apply copies back ONLY missing files whose bytes from a backup have exactly the
 * recorded SHA-256; it never overwrites, never deletes, and never changes a database row. A file that no
 * backup holds stays reported as missing: its content is never made up.
 * Exit 0 = every file present and intact; 2 = problems remain (see the report); 1 = the check failed.
 */
import path from 'node:path';
import { recoverMissingFiles, storedFileReport } from '../backup/file-report.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const { DATABASE_URL, BACKUP_DIR, BACKUP_PASSPHRASE } = process.env;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR ?? 'uploads');
const json = process.argv.includes('--json');
const apply = process.argv.includes('--apply');
if (!DATABASE_URL) {
  console.error('set DATABASE_URL');
  process.exit(1);
}
try {
  const roots = (BACKUP_DIR ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
  let report = await storedFileReport({ databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR, backupRoots: roots });
  let recovery: Awaited<ReturnType<typeof recoverMissingFiles>> | null = null;
  if (apply && report.counts.missing_recoverable > 0) {
    recovery = await recoverMissingFiles(report, { storageDir: STORAGE_DIR, passphrase: BACKUP_PASSPHRASE || undefined });
    report = await storedFileReport({ databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR, backupRoots: roots }); // re-check from scratch
  }
  const problems = report.files.filter((f) => f.status !== 'ok');
  if (json) {
    say(JSON.stringify({ counts: report.counts, problems, recovery }, null, 2));
  } else {
    say(`Stored files: ${report.files.length} — ok ${report.counts.ok}, damaged ${report.counts.damaged}, missing but in a backup ${report.counts.missing_recoverable}, missing and in no backup ${report.counts.missing_unavailable}.`);
    for (const f of problems) {
      const used = f.usedBy.map((u) => `${u.ref} ×${u.ids.length}`).join(', ') || 'not referenced';
      say(`- ${f.status.padEnd(19)} ${f.storageKey.slice(0, 15)}… uploaded ${f.uploadedAt.slice(0, 10)}; used by ${used}${f.foundIn.length ? `; in backup ${f.foundIn.join(', ')}` : ''}`);
    }
    if (recovery) {
      say(`Recovered byte-identical: ${recovery.recovered.length}.`);
      for (const x of recovery.failed) say(`  not recovered ${x.storageKey.slice(0, 15)}…: ${x.reason}`);
    } else if (report.counts.missing_recoverable) {
      say('Dry run: add --apply to copy back the files a backup holds (identical bytes only).');
    }
    if (report.counts.damaged) say('Damaged files are never overwritten automatically: move the damaged copy aside, then run again with --apply.');
  }
  process.exit(problems.length ? 2 : 0);
} catch (e) {
  console.error(`files-report FAILED: ${(e as Error).message}`);
  process.exit(1);
}
