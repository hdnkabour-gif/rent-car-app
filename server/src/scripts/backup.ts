/**
 * Full backup: database + every stored file + manifest with checksums, then (if configured) an
 * ENCRYPTED off-site copy checked object by object (issue #14).
 *   DATABASE_URL=... STORAGE_DIR=... BACKUP_DIR=... BACKUP_PASSPHRASE=... [OFFSITE_KIND=dir|s3 ...] npm run backup -w server
 * Production (NODE_ENV=production) and any off-site copy require BACKUP_PASSPHRASE. BACKUP_DIR may never
 * be inside STORAGE_DIR; in production it must be on another disk than STORAGE_DIR unless it is only a
 * staging area (BACKUP_KEEP_LOCAL=false + off-site copy).
 * Every run is recorded in the app (backup_runs): the manager sees a missing/failed backup or off-site copy.
 * Exit code 0 = complete and verified (and copied off-site when configured); 2 = saved but problems were
 * found; 3 = local backup verified but the off-site copy FAILED; 1 = failed.
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createBackup, recordBackupRun, verifyBackup, type OffsiteResult } from '../backup/backup.js';
import { checkBackupLocations } from '../backup/locations.js';
import { offsiteFromEnv, pushBackup } from '../backup/offsite.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const { DATABASE_URL, BACKUP_DIR, BACKUP_PASSPHRASE, BACKUP_KEY_LABEL } = process.env;
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR ?? 'uploads');
const production = process.env.NODE_ENV === 'production';
const keepLocal = process.env.BACKUP_KEEP_LOCAL !== 'false';
if (!DATABASE_URL || !BACKUP_DIR) {
  console.error('backup refused: set DATABASE_URL and BACKUP_DIR (a folder outside the application, ideally another disk).');
  process.exit(1);
}
const root = path.resolve(BACKUP_DIR);
const startedAt = new Date();
let target;
try {
  target = offsiteFromEnv();
  if (!keepLocal && !target) throw new Error('BACKUP_KEEP_LOCAL=false needs an off-site target (OFFSITE_KIND).');
  const warnings = await checkBackupLocations({
    storageDir: STORAGE_DIR, backupDir: root, offsiteDir: process.env.OFFSITE_KIND === 'dir' ? process.env.OFFSITE_DIR : undefined,
    production, localIsStagingOnly: !keepLocal && Boolean(target),
  });
  for (const w of warnings) console.warn(`WARNING: ${w}`);
} catch (e) {
  console.error(`backup refused: ${(e as Error).message}`);
  await recordBackupRun(DATABASE_URL, { startedAt, ok: false, encrypted: Boolean(BACKUP_PASSPHRASE), folderName: null, problems: 1, message: `refused: ${(e as Error).message}` }).catch(() => undefined);
  process.exit(1);
}
if (!BACKUP_PASSPHRASE) console.warn('WARNING: BACKUP_PASSPHRASE is not set — this backup is NOT encrypted. Store it only on an encrypted disk.');

try {
  const { dir, manifest } = await createBackup({
    databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR, backupRoot: root, passphrase: BACKUP_PASSPHRASE || undefined,
    requireEncryption: production || Boolean(target), keyLabel: BACKUP_KEY_LABEL || undefined,
  });
  const { problems } = await verifyBackup(dir, BACKUP_PASSPHRASE || undefined);
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  say(`Backup saved: ${path.basename(dir)}${manifest.encryption ? ' (encrypted)' : ''}`);
  say(`Database ${manifest.database}: ${Object.keys(manifest.tables).length} tables, ${rows} rows; ${manifest.files.length} files.`);

  let offsite: OffsiteResult | null = null;
  if (target && problems.length === 0) {
    try {
      const r = await pushBackup(dir, target);
      offsite = { kind: target.kind, ok: true, objects: r.objects, bytes: r.bytes, message: null };
      say(`Off-site copy verified (${target.kind}): ${r.objects} objects, ${r.bytes} bytes.`);
    } catch (e) {
      offsite = { kind: target.kind, ok: false, message: (e as Error).message };
      console.error(`OFF-SITE COPY FAILED (${target.kind}): ${(e as Error).message}`);
    }
  } else if (target) {
    offsite = { kind: target.kind, ok: false, message: 'not copied: the local backup has problems' };
  }
  await recordBackupRun(DATABASE_URL, {
    startedAt, ok: problems.length === 0, encrypted: Boolean(manifest.encryption), folderName: path.basename(dir), manifest,
    problems: problems.length, message: problems.length ? problems.slice(0, 5).join(' | ') : null, offsite,
  });
  if (problems.length) {
    console.error(`PROBLEMS (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  if (offsite && !offsite.ok) process.exit(3);
  if (!keepLocal && offsite?.ok) {
    await rm(dir, { recursive: true, force: true });
    say('Local staging copy removed (BACKUP_KEEP_LOCAL=false); the off-site copy is the backup.');
  }
  say(target ? 'Verified locally and off-site.' : 'Verified: every checksum matches. Copy this folder to a second place (external disk / other site).');
} catch (e) {
  console.error(`backup FAILED: ${(e as Error).message}`);
  await recordBackupRun(DATABASE_URL, {
    startedAt, ok: false, encrypted: Boolean(BACKUP_PASSPHRASE), folderName: null, problems: 1, message: (e as Error).message,
    offsite: target ? { kind: target.kind, ok: false, message: 'not copied: backup failed' } : null,
  }).catch(() => undefined);
  process.exit(1);
}
