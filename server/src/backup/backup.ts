/**
 * Backups that can be trusted (BACKUP_RESTORE.md): one folder holds the database dump AND every
 * stored file, with a manifest of record counts and SHA-256 checksums.
 *
 *  - createBackup: pg_dump (custom format) + copy of each stored file, checked byte for byte.
 *  - verifyBackup: re-reads everything and compares with the manifest; pg_restore can read the dump.
 *  - restoreBackup: ONLY into an empty database and a storage folder that holds no conflicting
 *    file; then proves the result (counts and file checksums equal the manifest).
 *
 * Nothing here deletes or overwrites company data. Secrets are never written to the backup.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

export interface Manifest {
  format: 'fleetora-backup-1';
  createdAt: string;
  database: string;
  migrations: string[];
  tables: Record<string, number>;
  dump: { file: 'database.dump'; sha256: string; bytes: number };
  files: Array<{ key: string; sha256: string; bytes: number }>;
  problems: string[];
}

const KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** libpq environment for pg_dump / pg_restore: the password never appears on a command line. */
export function pgEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`${cmd} could not start (${e.message}). Install the PostgreSQL client tools.`)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (exit ${code}): ${err.trim().slice(0, 2000)}`))));
  });
}

async function inventory(db: pg.Pool | pg.PoolClient) {
  const name = (await db.query<{ n: string }>('SELECT current_database() AS n')).rows[0]!.n;
  const migrations = (await db.query<{ v: string }>(`SELECT version || '_' || name AS v FROM schema_migrations ORDER BY version`)).rows.map((r) => r.v);
  const tablesList = (
    await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)
  ).rows.map((r) => r.t);
  const tables: Record<string, number> = {};
  for (const t of tablesList) tables[t] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t.replace(/"/g, '""')}"`)).rows[0]!.n;
  return { name, migrations, tables };
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);

/** Creates `<backupRoot>/fleetora-backup-<UTC time>/`. Returns the folder and its manifest. */
export async function createBackup(opts: { databaseUrl: string; storageDir: string; backupRoot: string }): Promise<{ dir: string; manifest: Manifest }> {
  const dir = path.join(opts.backupRoot, `fleetora-backup-${stamp()}`);
  await mkdir(opts.backupRoot, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }); // fails if it exists: a backup is never overwritten
  await mkdir(path.join(dir, 'files'), { mode: 0o700 });
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
  const problems: string[] = [];
  try {
    // The dump is a consistent snapshot; files are content-addressed and never change, so every
    // file referenced by the dump exists (files only ever get added).
    const dumpFile = path.join(dir, 'database.dump');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpFile}`], pgEnv(opts.databaseUrl));
    const inv = await inventory(pool);
    const rows = (await pool.query<{ storage_key: string; sha256: string; size_bytes: number }>('SELECT storage_key, sha256, size_bytes FROM stored_files ORDER BY storage_key')).rows;
    const files: Manifest['files'] = [];
    for (const f of rows) {
      if (!KEY.test(f.storage_key)) {
        problems.push(`invalid storage key ${f.storage_key}`);
        continue;
      }
      const src = path.join(opts.storageDir, f.storage_key);
      const dst = path.join(dir, 'files', f.storage_key);
      try {
        await mkdir(path.dirname(dst), { recursive: true });
        await copyFile(src, dst);
        const sha = await sha256File(dst);
        if (sha !== f.sha256) problems.push(`file ${f.storage_key} does not match its checksum (damaged in storage)`);
        files.push({ key: f.storage_key, sha256: f.sha256, bytes: f.size_bytes });
      } catch {
        problems.push(`file ${f.storage_key} is missing from storage`);
      }
    }
    const manifest: Manifest = {
      format: 'fleetora-backup-1',
      createdAt: new Date().toISOString(),
      database: inv.name,
      migrations: inv.migrations,
      tables: inv.tables,
      dump: { file: 'database.dump', sha256: await sha256File(dumpFile), bytes: (await stat(dumpFile)).size },
      files,
      problems,
    };
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { dir, manifest };
  } finally {
    await pool.end();
  }
}

/** Every byte is checked against the manifest. Returns the list of problems (empty = good backup). */
export async function verifyBackup(dir: string): Promise<{ manifest: Manifest; problems: string[] }> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const problems = [...manifest.problems.map((p) => `recorded at backup time: ${p}`)];
  if (manifest.format !== 'fleetora-backup-1') problems.push('unknown backup format');
  const dumpFile = path.join(dir, manifest.dump.file);
  try {
    if ((await sha256File(dumpFile)) !== manifest.dump.sha256) problems.push('database dump is damaged (checksum differs)');
    await run('pg_restore', ['--list', dumpFile], process.env);
  } catch (e) {
    problems.push(`database dump unreadable: ${(e as Error).message}`);
  }
  for (const f of manifest.files) {
    try {
      if ((await sha256File(path.join(dir, 'files', f.key))) !== f.sha256) problems.push(`file ${f.key} is damaged in the backup`);
    } catch {
      problems.push(`file ${f.key} is missing from the backup`);
    }
  }
  return { manifest, problems };
}

/**
 * Restores into an EMPTY database (refuses otherwise) and copies files into storageDir (an
 * existing file with the same name must be identical). Then proves the restore.
 */
export async function restoreBackup(opts: { dir: string; databaseUrl: string; storageDir: string }): Promise<{ problems: string[] }> {
  const { manifest, problems: before } = await verifyBackup(opts.dir);
  if (before.length) throw new Error(`The backup is not intact; nothing was restored:\n- ${before.join('\n- ')}`);
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
  try {
    const existing = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
    );
    if (existing.rows[0]!.n > 0) throw new Error('The target database is not empty: restore only into a new, empty database. Nothing was changed.');

    for (const f of manifest.files) {
      const dst = path.join(opts.storageDir, f.key);
      try {
        if ((await sha256File(dst)) !== f.sha256) throw new Error(`Storage already holds a different ${f.key}; nothing more was copied.`);
        continue; // identical file already there
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(path.join(opts.dir, 'files', f.key), dst);
    }
    await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${pgEnv(opts.databaseUrl).PGDATABASE}`, path.join(opts.dir, manifest.dump.file)], pgEnv(opts.databaseUrl));

    // Proof: same records, same migrations, every file present and intact.
    const inv = await inventory(pool);
    const problems: string[] = [];
    for (const [t, n] of Object.entries(manifest.tables)) if (inv.tables[t] !== n) problems.push(`table ${t}: ${inv.tables[t] ?? 0} rows instead of ${n}`);
    if (JSON.stringify(inv.migrations) !== JSON.stringify(manifest.migrations)) problems.push('migration list differs');
    problems.push(...(await checkStoredFiles(pool, opts.storageDir)));
    return { problems };
  } finally {
    await pool.end();
  }
}

/** Live check: every stored file exists and still has its checksum. Returns problems found. */
export async function checkStoredFiles(db: pg.Pool, storageDir: string): Promise<string[]> {
  const rows = (await db.query<{ storage_key: string; sha256: string }>('SELECT storage_key, sha256 FROM stored_files')).rows;
  const problems: string[] = [];
  for (const f of rows) {
    try {
      if ((await sha256File(path.join(storageDir, f.storage_key))) !== f.sha256) problems.push(`file ${f.storage_key} is damaged`);
    } catch {
      problems.push(`file ${f.storage_key} is missing`);
    }
  }
  return problems;
}

/** Backup folders under a root, newest first (for retention reports; nothing is deleted here). */
export async function listBackups(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter((n) => n.startsWith('fleetora-backup-')).sort().reverse();
  } catch {
    return [];
  }
}
