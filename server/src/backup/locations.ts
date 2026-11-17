/**
 * Where backups may live (issue #14): never inside the uploads folder, and in production never on the
 * same disk/volume as the uploads — a lost or corrupted volume must not take the backups with it.
 * The off-site folder must also be a different disk from both.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/** Device id of a folder, or of its nearest existing parent when it does not exist yet. */
async function deviceOf(dir: string): Promise<number> {
  let d = path.resolve(dir);
  for (;;) {
    try {
      return (await stat(d)).dev;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const up = path.dirname(d);
      if (up === d) throw e;
      d = up;
    }
  }
}

export interface LocationCheck {
  storageDir: string;
  backupDir: string;
  offsiteDir?: string;
  production: boolean;
  /** The local folder is only a staging area: deleted after a verified off-site copy. */
  localIsStagingOnly?: boolean;
}

/** Throws on a forbidden layout; returns warnings for development. */
export async function checkBackupLocations(c: LocationCheck): Promise<string[]> {
  const storage = path.resolve(c.storageDir);
  const backup = path.resolve(c.backupDir);
  const offsite = c.offsiteDir ? path.resolve(c.offsiteDir) : undefined;
  if (inside(backup, storage) || inside(storage, backup)) throw new Error('BACKUP_DIR must not be inside STORAGE_DIR (or contain it).');
  if (offsite && (inside(offsite, storage) || inside(storage, offsite))) throw new Error('OFFSITE_DIR must not be inside STORAGE_DIR (or contain it).');
  if (offsite && (inside(offsite, backup) || inside(backup, offsite))) throw new Error('OFFSITE_DIR must not be inside BACKUP_DIR (or contain it).');

  const warnings: string[] = [];
  const [ds, db] = [await deviceOf(storage), await deviceOf(backup)];
  if (ds === db && !c.localIsStagingOnly) {
    const msg = 'BACKUP_DIR is on the same disk/volume as STORAGE_DIR: a disk failure would take both.';
    if (c.production) throw new Error(`${msg} Use another disk, or an off-site copy with BACKUP_KEEP_LOCAL=false.`);
    warnings.push(msg);
  }
  if (offsite) {
    const dof = await deviceOf(offsite);
    if (dof === ds || dof === db) {
      const msg = 'OFFSITE_DIR is on the same disk as STORAGE_DIR or BACKUP_DIR: it is not an off-site copy.';
      if (c.production) throw new Error(msg);
      warnings.push(msg);
    }
  }
  return warnings;
}
