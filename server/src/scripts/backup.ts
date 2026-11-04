/**
 * Full backup: database + every stored file + manifest with checksums.
 *   DATABASE_URL=... STORAGE_DIR=... BACKUP_DIR=D:\fleetora-backups npm run backup -w server
 * Exit code 0 = complete and verified; 2 = saved but problems were found (read them!); 1 = failed.
 */
import path from 'node:path';
import { createBackup, verifyBackup } from '../backup/backup.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const { DATABASE_URL, BACKUP_DIR } = process.env;
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
try {
  const { dir, manifest } = await createBackup({ databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR, backupRoot: root });
  const { problems } = await verifyBackup(dir);
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  say(`Backup saved: ${dir}`);
  say(`Database ${manifest.database}: ${Object.keys(manifest.tables).length} tables, ${rows} rows; ${manifest.files.length} files.`);
  if (problems.length) {
    console.error(`PROBLEMS (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  say('Verified: every checksum matches. Copy this folder to a second place (external disk / other site).');
} catch (e) {
  console.error(`backup FAILED: ${(e as Error).message}`);
  process.exit(1);
}
