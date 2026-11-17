/**
 * Stored-file diagnostic and recovery (issue #16). For every `stored_files` row it says:
 *   ok                  — the file is on disk with its SHA-256;
 *   damaged             — a file is there but its bytes differ (never overwritten automatically);
 *   missing_recoverable — not on disk, but a local backup folder lists it (bytes checked on recovery);
 *   missing_unavailable — not on disk and in no backup we can see: it stays recorded as missing.
 * It also lists WHICH records use each file (by table and row id only: no names, no content), so a missing
 * file can be explained without guessing. Database access is read-only. Rows are never created, changed or
 * deleted, and no file content is ever made up: recovery copies only bytes whose SHA-256 is identical.
 */
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { listBackups, readFileFromBackup, sha256File } from './backup.js';

export type FileStatus = 'ok' | 'damaged' | 'missing_recoverable' | 'missing_unavailable';

export interface FileEntry {
  id: string;
  storageKey: string;
  sha256: string;
  bytes: number;
  uploadedAt: string;
  status: FileStatus;
  /** Backup folders (names only) whose manifest lists this exact file. */
  foundIn: string[];
  /** Records that reference the file: `table.column` → row ids. */
  usedBy: Array<{ ref: string; ids: string[] }>;
}

const KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

async function referencingColumns(client: pg.PoolClient): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await client.query<{ table: string; column: string }>(
    `SELECT tc.table_name AS table, kcu.column_name AS column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = 'stored_files' AND ccu.column_name = 'id'
      ORDER BY 1, 2`,
  );
  return rows;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Which backup folders list which `key:sha256` (manifests are plain JSON even for encrypted backups). */
async function backupIndex(backupRoots: string[]): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  for (const root of backupRoots) {
    for (const name of await listBackups(root)) {
      try {
        const m = JSON.parse(await readFile(path.join(root, name, 'manifest.json'), 'utf8')) as { files?: Array<{ key?: unknown; sha256?: unknown }> };
        for (const f of m.files ?? []) {
          if (typeof f.key !== 'string' || typeof f.sha256 !== 'string' || !KEY.test(f.key)) continue;
          const k = `${f.key}:${f.sha256}`;
          index.set(k, [...(index.get(k) ?? []), path.join(root, name)]);
        }
      } catch {
        // unreadable folder: ignored here; verify-backup reports it
      }
    }
  }
  return index;
}

export async function storedFileReport(opts: { databaseUrl: string; storageDir: string; backupRoots?: string[] }): Promise<{
  files: FileEntry[];
  counts: Record<FileStatus, number>;
  /** Full backup folder paths per file id, for recovery only (kept out of the printed report). */
  sources: Map<string, string[]>;
}> {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent, read-only view
    const rows = (
      await client.query<{ id: string; storage_key: string; sha256: string; size_bytes: number; uploaded_at: Date }>(
        'SELECT id, storage_key, sha256, size_bytes, uploaded_at FROM stored_files ORDER BY uploaded_at, id',
      )
    ).rows;
    const refs = await referencingColumns(client);
    const usedBy = new Map<string, Array<{ ref: string; ids: string[] }>>();
    for (const r of refs) {
      const hasId = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`, [r.table])).rowCount;
      const idExpr = hasId ? 'id::text' : `ctid::text`;
      const q = await client.query<{ file: string; ids: string[] }>(
        `SELECT ${ident(r.column)}::text AS file, array_agg(${idExpr} ORDER BY ${idExpr}) AS ids FROM ${ident(r.table)} WHERE ${ident(r.column)} IS NOT NULL GROUP BY 1`,
      );
      for (const x of q.rows) usedBy.set(x.file, [...(usedBy.get(x.file) ?? []), { ref: `${r.table}.${r.column}`, ids: x.ids }]);
    }
    await client.query('COMMIT');

    const index = await backupIndex(opts.backupRoots ?? []);
    const files: FileEntry[] = [];
    const sources = new Map<string, string[]>();
    for (const r of rows) {
      let status: FileStatus;
      try {
        status = KEY.test(r.storage_key) && (await sha256File(path.join(opts.storageDir, r.storage_key))) === r.sha256 ? 'ok' : 'damaged';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        status = 'missing_unavailable';
      }
      const foundIn = index.get(`${r.storage_key}:${r.sha256}`) ?? [];
      if (status === 'missing_unavailable' && foundIn.length) status = 'missing_recoverable';
      files.push({
        id: r.id, storageKey: r.storage_key, sha256: r.sha256, bytes: r.size_bytes, uploadedAt: r.uploaded_at.toISOString(), status,
        foundIn: foundIn.map((d) => path.basename(d)), usedBy: usedBy.get(r.id) ?? [],
      });
      if (foundIn.length) sources.set(r.id, foundIn);
    }
    const counts = { ok: 0, damaged: 0, missing_recoverable: 0, missing_unavailable: 0 } as Record<FileStatus, number>;
    for (const f of files) counts[f.status] += 1;
    return { files, counts, sources };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Copies back ONLY missing files whose bytes, read from a listed backup, have exactly the recorded SHA-256.
 * Never overwrites (damaged files are left for a person to move aside), never follows a symbolic link,
 * never touches the database. Returns what was recovered and what could not be.
 */
export async function recoverMissingFiles(
  report: { files: FileEntry[]; sources: Map<string, string[]> },
  opts: { storageDir: string; passphrase?: string; /** tests only: replaces the temporary-file write */ _writeTemp?: (file: string, bytes: Buffer) => Promise<void> },
): Promise<{ recovered: string[]; failed: Array<{ storageKey: string; reason: string }>; staleTempRemoved: number }> {
  let staleTempRemoved = 0;
  const recovered: string[] = [];
  const failed: Array<{ storageKey: string; reason: string }> = [];
  const root = path.resolve(opts.storageDir);
  for (const f of report.files) {
    if (f.status !== 'missing_recoverable') continue;
    const dst = path.resolve(root, f.storageKey);
    if (!KEY.test(f.storageKey) || !dst.startsWith(root + path.sep)) {
      failed.push({ storageKey: f.storageKey, reason: 'invalid storage key' });
      continue;
    }
    let done = false;
    const reasons: string[] = [];
    for (const dir of report.sources.get(f.id) ?? []) {
      try {
        const bytes = await readFileFromBackup(dir, f.storageKey, f.sha256, opts.passphrase);
        const parent = path.dirname(dst);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('symbolic link refused in storage');
        try {
          await lstat(dst);
          throw new Error('a file appeared at that place meanwhile; nothing overwritten');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        // B24-1: leftovers of an interrupted earlier attempt carry OUR temporary names only (never a stored file's
        // name, which is exactly the content address): they are removed so they cannot block this attempt.
        staleTempRemoved += await removeStaleTemps(parent, path.basename(dst));
        // Each attempt owns a unique temporary file and always removes it if anything fails.
        const tmp = `${dst}.recovering-${randomBytes(8).toString('hex')}`;
        try {
          if (opts._writeTemp) await opts._writeTemp(tmp, bytes);
          else await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
          if ((await sha256File(tmp)) !== f.sha256) throw new Error('temporary copy does not match the SHA-256');
          // link() fails if the final name appeared meanwhile: never overwrites (rename would).
          await link(tmp, dst);
        } finally {
          await unlink(tmp).catch(() => undefined);
        }
        if ((await sha256File(dst)) !== f.sha256) throw new Error('recovered file does not match after writing');
        recovered.push(f.storageKey);
        done = true;
        break;
      } catch (e) {
        reasons.push(`${path.basename(dir)}: ${(e as Error).message}`);
      }
    }
    if (!done) failed.push({ storageKey: f.storageKey, reason: reasons.join(' | ') || 'no backup listed it' });
  }
  return { recovered, failed, staleTempRemoved };
}

/**
 * Gate round 2 on #24: a temporary file younger than this belongs, as far as we can know, to an attempt still
 * running (another process recovering the same file): it is never removed. Recovering one file takes seconds,
 * so an hour-old temporary file is a leftover of a killed or crashed run.
 */
export const STALE_TEMP_MS = 60 * 60 * 1000;

/** Removes only STALE regular files named `<storage file>.recovering` or `<storage file>.recovering-<16 hex>`. */
async function removeStaleTemps(dir: string, base: string): Promise<number> {
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.recovering(-[0-9a-f]{16})?$`);
  let n = 0;
  for (const name of await readdir(dir)) {
    if (!pattern.test(name)) continue;
    const full = path.join(dir, name);
    const st = await lstat(full);
    if (!st.isFile()) continue; // never follow or remove a link or folder
    if (Date.now() - st.mtimeMs < STALE_TEMP_MS) continue; // possibly a live attempt of another process
    await unlink(full);
    n += 1;
  }
  return n;
}
