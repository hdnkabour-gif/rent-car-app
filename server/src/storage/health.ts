import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Non-destructive live storage probe. It never reads, modifies or removes uploaded files.
 * A successful probe proves current read/write access, NOT survival across a redeploy.
 */
export async function checkStorageWritable(root: string): Promise<boolean> {
  let directory: string | undefined;
  try {
    if (!(await stat(root)).isDirectory()) return false;
    directory = await mkdtemp(path.join(root, '.fleetora-health-'));
    const probe = path.join(directory, 'probe');
    const sample = randomBytes(32);
    await writeFile(probe, sample, { flag: 'wx', mode: 0o600 });
    const readBack = await readFile(probe);
    if (!readBack.equals(sample)) return false;
    await rm(directory, { recursive: true });
    directory = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
