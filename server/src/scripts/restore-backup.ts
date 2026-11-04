/**
 * Restore drill / disaster recovery, into a NEW EMPTY database only:
 *   DATABASE_URL=<new empty db> STORAGE_DIR=<files folder> FLEETORA_RESTORE_TARGET=<that db name> \
 *     npm run restore-backup -w server -- <backup folder>
 * Refuses a non-empty database, a damaged backup or a conflicting file. Never deletes anything.
 */
import path from 'node:path';
import { pgEnv, restoreBackup } from '../backup/backup.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const dir = process.argv[2];
const { DATABASE_URL, FLEETORA_RESTORE_TARGET } = process.env;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR ?? 'uploads');
if (!dir || !DATABASE_URL) {
  console.error('usage: DATABASE_URL=... STORAGE_DIR=... FLEETORA_RESTORE_TARGET=<db name> restore-backup <backup folder>');
  process.exit(1);
}
const target = pgEnv(DATABASE_URL).PGDATABASE;
if (FLEETORA_RESTORE_TARGET !== target) {
  console.error(`restore refused: set FLEETORA_RESTORE_TARGET=${target} to confirm the target database.`);
  process.exit(1);
}
try {
  const { problems } = await restoreBackup({ dir, databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR, passphrase: process.env.BACKUP_PASSPHRASE || undefined });
  if (problems.length) {
    console.error(`Restored, but the proof FAILED (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  say(`Restored into ${target} and proven: same record counts, same migrations, every file present and intact.`);
} catch (e) {
  console.error(`restore FAILED: ${(e as Error).message}`);
  process.exit(1);
}
