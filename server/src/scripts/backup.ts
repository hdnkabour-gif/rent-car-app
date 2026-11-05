/**
 * Full backup: database + every stored file + manifest with checksums.
 *   DATABASE_URL=... STORAGE_DIR=... BACKUP_DIR=D:\fleetora-backups [BACKUP_PASSPHRASE=...] npm run backup -w server
 * With BACKUP_PASSPHRASE (12+ characters, kept OUTSIDE the backup) everything is encrypted.
 * Every run is recorded in the app (backup_runs), so the manager sees a missing or failed backup.
 * Exit code 0 = complete and verified; 2 = saved but problems were found (read them!); 1 = failed.
 */
import path from 'node:path';
import { createBackup, recordBackupRun, verifyBackup } from '../backup/backup.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const { DATABASE_URL, BACKUP_DIR, BACKUP_PASSPHRASE } = process.env;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR ?? 'uploads');
if (!DATABASE_URL || !BACKUP_DIR) {
  console.error('backup refused: set DATABASE_URL and BACKUP_DIR (a folder outside the application, ideally another disk).');
  process.exit(1);
}
const root = path.resolve(BACKUP_DIR);
if (root.startsWith(STORAGE_DIR + path.sep) || root === STORAGE_DIR) {
  console.error('backup refused: BACKUP_DIR must not be inside STORAGE_DIR.');
  process.exit(1);
}
if (!BACKUP_PASSPHRASE) console.warn('WARNING: BACKUP_PASSPHRASE is not set — this backup is NOT encrypted. Store it only on an encrypted disk.');
const startedAt = new Date();
try {
  const { dir, manifest } = await createBackup({ databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR, backupRoot: root, passphrase: BACKUP_PASSPHRASE || undefined });
  const { problems } = await verifyBackup(dir, BACKUP_PASSPHRASE || undefined);
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  await recordBackupRun(DATABASE_URL, {
    startedAt, ok: problems.length === 0, encrypted: Boolean(manifest.encryption), folderName: path.basename(dir), manifest,
    problems: problems.length, message: problems.length ? problems.slice(0, 5).join(' | ') : null,
  });
  say(`Backup saved: ${dir}${manifest.encryption ? ' (encrypted)' : ''}`);
  say(`Database ${manifest.database}: ${Object.keys(manifest.tables).length} tables, ${rows} rows; ${manifest.files.length} files.`);
  if (problems.length) {
    console.error(`PROBLEMS (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  say('Verified: every checksum matches. Copy this folder to a second place (external disk / other site).');
} catch (e) {
  console.error(`backup FAILED: ${(e as Error).message}`);
  await recordBackupRun(DATABASE_URL, { startedAt, ok: false, encrypted: Boolean(BACKUP_PASSPHRASE), folderName: null, problems: 1, message: (e as Error).message }).catch(() => undefined);
  process.exit(1);
}
