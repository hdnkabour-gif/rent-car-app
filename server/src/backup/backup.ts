/**
 * Backups that can be trusted (BACKUP_RESTORE.md): one folder holds the database dump AND every
 * stored file, with a manifest of record counts and SHA-256 checksums.
 *
 *  - createBackup: pg_dump (custom format) + copy of each stored file, checked byte for byte.
 *    With a passphrase (BACKUP_PASSPHRASE) the dump and every file are encrypted with
 *    AES-256-GCM (key from scrypt); a lost or stolen backup disk then reveals nothing.
 *  - verifyBackup: re-reads everything and compares with the manifest; pg_restore can read the dump.
 *  - restoreBackup: ONLY into an empty database and a storage folder that holds no conflicting
 *    file; then proves the result (counts and file checksums equal the manifest).
 *
 * Nothing here deletes or overwrites company data. Secrets are never written to the backup.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

interface Encryption {
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  salt: string; // hex
  N: number;
  r: number;
  p: number;
  /** "fleetora" encrypted with the key: tells a wrong passphrase from a damaged file. */
  check: string;
}

export interface Manifest {
  format: 'fleetora-backup-1';
  createdAt: string;
  database: string;
  migrations: string[];
  tables: Record<string, number>;
  /** sha256 = of the PLAIN content; storedSha256 = of the file on disk when encrypted. */
  dump: { file: string; sha256: string; bytes: number; storedSha256?: string };
  files: Array<{ key: string; sha256: string; bytes: number }>;
  encryption?: Encryption;
  problems: string[];
}

const KEY = /^[0-9a-f]{2}\/[0-9a-f]{64}$/;
const KDF = { N: 2 ** 15, r: 8, p: 1 };
const MAGIC = Buffer.from('FLEETORA-ENC1');

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function deriveKey(passphrase: string, e: Pick<Encryption, 'salt' | 'N' | 'r' | 'p'>): Buffer {
  return scryptSync(passphrase, Buffer.from(e.salt, 'hex'), 32, { N: e.N, r: e.r, p: e.p, maxmem: 128 * e.N * e.r * 2 });
}
function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
function decrypt(key: Buffer, data: Buffer): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted Fleetora file');
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data.subarray(MAGIC.length + 28)), d.final()]);
}
function keyFor(manifest: Manifest, passphrase: string | undefined): Buffer | null {
  if (!manifest.encryption) return null;
  if (!passphrase) throw new Error('This backup is encrypted: set BACKUP_PASSPHRASE to read it.');
  const key = deriveKey(passphrase, manifest.encryption);
  try {
    if (decrypt(key, Buffer.from(manifest.encryption.check, 'base64')).toString() !== 'fleetora') throw new Error('bad check');
  } catch {
    throw new Error('Wrong backup passphrase.');
  }
  return key;
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

/** Select pg_dump / pg_restore matching the database's major version.
 * Newer pg_dump may connect to older servers, but its output is not guaranteed
 * to restore on that older version. Preserve source-major compatibility.
 */
export function postgresClientCommand(command: 'pg_dump' | 'pg_restore', serverMajor: number): string {
  if (!Number.isInteger(serverMajor) || serverMajor < 10 || serverMajor > 30) {
    throw new Error('Unsupported PostgreSQL server major version');
  }
  const installed = `/usr/lib/postgresql/${serverMajor}/bin/${command}`;
  return existsSync(installed) ? installed : command;
}

async function serverMajorVersion(db: pg.Pool): Promise<number> {
  const {rows} = await db.query<{server_version_num:string}>('SHOW server_version_num');
  const version = Number(rows[0]?.server_version_num);
  if(!Number.isFinite(version)) throw new Error('Cannot determine PostgreSQL server version');
  return Math.floor(version / 10000);
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

/** A private temporary folder (mode 700), removed afterwards: holds only our own decrypted copies. */
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fleetora-backup-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Creates `<backupRoot>/fleetora-backup-<UTC time>/`. Returns the folder and its manifest. */
export async function createBackup(opts: { databaseUrl: string; storageDir: string; backupRoot: string; passphrase?: string }): Promise<{ dir: string; manifest: Manifest }> {
  if (opts.passphrase !== undefined && opts.passphrase.length < 12) throw new Error('BACKUP_PASSPHRASE must have at least 12 characters.');
  const dir = path.join(opts.backupRoot, `fleetora-backup-${stamp()}`);
  await mkdir(opts.backupRoot, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }); // fails if it exists: a backup is never overwritten
  await mkdir(path.join(dir, 'files'), { mode: 0o700 });
  let encryption: Encryption | undefined;
  let key: Buffer | null = null;
  if (opts.passphrase) {
    const salt = randomBytes(16).toString('hex');
    key = deriveKey(opts.passphrase, { salt, ...KDF });
    encryption = { algorithm: 'aes-256-gcm', kdf: 'scrypt', salt, ...KDF, check: encrypt(key, Buffer.from('fleetora')).toString('base64') };
  }
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
  const problems: string[] = [];
  try {
    // The dump is a consistent snapshot; files are content-addressed and never change, so every
    // file referenced by the dump exists (files only ever get added).
    const dump = await withTemp(async (tmp) => {
      const plainFile = key ? path.join(tmp, 'database.dump') : path.join(dir, 'database.dump');
      await run(postgresClientCommand('pg_dump', await serverMajorVersion(pool)),
        ['--format=custom', '--no-owner', '--no-privileges', `--file=${plainFile}`], pgEnv(opts.databaseUrl));
      const plainSha = await sha256File(plainFile);
      const bytes = (await stat(plainFile)).size;
      if (!key) return { file: 'database.dump', sha256: plainSha, bytes };
      const enc = encrypt(key, await readFile(plainFile));
      await writeFile(path.join(dir, 'database.dump.enc'), enc, { mode: 0o600 });
      return { file: 'database.dump.enc', sha256: plainSha, bytes, storedSha256: sha256(enc) };
    });
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
        const plain = await readFile(src);
        if (sha256(plain) !== f.sha256) problems.push(`file ${f.storage_key} does not match its checksum (damaged in storage)`);
        await writeFile(key ? `${dst}.enc` : dst, key ? encrypt(key, plain) : plain, { mode: 0o600 });
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
      dump,
      files,
      ...(encryption ? { encryption } : {}),
      problems,
    };
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { dir, manifest };
  } finally {
    await pool.end();
  }
}

/** Reads one backed-up file as plain bytes (decrypting when needed). */
async function readBackupFile(dir: string, key: Buffer | null, name: string): Promise<Buffer> {
  const data = await readFile(path.join(dir, key ? `${name}.enc` : name));
  return key ? decrypt(key, data) : data;
}

/**
 * Issue #16 — reads ONE file out of a backup folder, for recovering a missing stored file. The key must be
 * a content address (`xx/<sha256>`) whose SHA-256 is the expected one, the manifest must list it with that
 * SHA-256, and the decrypted bytes must hash to it: anything else is refused. Nothing is written here.
 */
export async function readFileFromBackup(dir: string, storageKey: string, expectedSha256: string, passphrase?: string): Promise<Buffer> {
  if (!KEY.test(storageKey) || storageKey !== `${expectedSha256.slice(0, 2)}/${expectedSha256}`) throw new Error('not a content-addressed storage key');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (!Array.isArray(manifest.files) || !manifest.files.some((f) => f.key === storageKey && f.sha256 === expectedSha256)) {
    throw new Error('this backup does not list the file');
  }
  const key = keyFor(manifest, passphrase);
  const filesDir = path.resolve(dir, 'files');
  const target = path.resolve(filesDir, key ? `${storageKey}.enc` : storageKey);
  if (!target.startsWith(filesDir + path.sep)) throw new Error('path escapes the backup folder');
  const bytes = await readBackupFile(filesDir, key, storageKey);
  if (sha256(bytes) !== expectedSha256) throw new Error('the backed-up bytes do not match the expected SHA-256');
  return bytes;
}

/** Every byte is checked against the manifest. Returns the list of problems (empty = good backup). */
export async function verifyBackup(dir: string, passphrase?: string): Promise<{ manifest: Manifest; problems: string[] }> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const problems = [...manifest.problems.map((p) => `recorded at backup time: ${p}`)];
  if (manifest.format !== 'fleetora-backup-1') problems.push('unknown backup format');
  let key: Buffer | null;
  try {
    key = keyFor(manifest, passphrase);
  } catch (e) {
    return { manifest, problems: [...problems, (e as Error).message] };
  }
  await withTemp(async (tmp) => {
    try {
      let dumpFile = path.join(dir, manifest.dump.file);
      if (key) {
        const enc = await readFile(dumpFile);
        if (manifest.dump.storedSha256 && sha256(enc) !== manifest.dump.storedSha256) throw new Error('checksum differs');
        dumpFile = path.join(tmp, 'database.dump');
        await writeFile(dumpFile, decrypt(key, enc), { mode: 0o600 });
      }
      if ((await sha256File(dumpFile)) !== manifest.dump.sha256) problems.push('database dump is damaged (checksum differs)');
      await run('pg_restore', ['--list', dumpFile], process.env);
    } catch (e) {
      problems.push(`database dump unreadable or damaged: ${(e as Error).message}`);
    }
  });
  for (const f of manifest.files) {
    try {
      if (sha256(await readBackupFile(path.join(dir, 'files'), key, f.key)) !== f.sha256) problems.push(`file ${f.key} is damaged in the backup`);
    } catch (e) {
      problems.push((e as NodeJS.ErrnoException).code === 'ENOENT' ? `file ${f.key} is missing from the backup` : `file ${f.key} is damaged in the backup`);
    }
  }
  return { manifest, problems };
}

/**
 * Restores into an EMPTY database (refuses otherwise) and copies files into storageDir (an
 * existing file with the same name must be identical). Then proves the restore.
 */
export async function restoreBackup(opts: { dir: string; databaseUrl: string; storageDir: string; passphrase?: string }): Promise<{ problems: string[] }> {
  const { manifest, problems: before } = await verifyBackup(opts.dir, opts.passphrase);
  if (before.length) throw new Error(`The backup is not intact; nothing was restored:\n- ${before.join('\n- ')}`);
  const key = keyFor(manifest, opts.passphrase);
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
      if (key) await writeFile(dst, await readBackupFile(path.join(opts.dir, 'files'), key, f.key), { mode: 0o600 });
      else await copyFile(path.join(opts.dir, 'files', f.key), dst);
    }
    await withTemp(async (tmp) => {
      let dumpFile = path.join(opts.dir, manifest.dump.file);
      if (key) {
        dumpFile = path.join(tmp, 'database.dump');
        await writeFile(dumpFile, decrypt(key, await readFile(path.join(opts.dir, manifest.dump.file))), { mode: 0o600 });
      }
      await run(postgresClientCommand('pg_restore', await serverMajorVersion(pool)),
        ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
          `--dbname=${pgEnv(opts.databaseUrl).PGDATABASE}`, dumpFile], pgEnv(opts.databaseUrl));
    });

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

/**
 * Records the result of a backup run in the database (table backup_runs, migration 0009) so the
 * manager sees a missing or failed backup in the app. Never stores paths or secrets.
 */
export async function recordBackupRun(
  databaseUrl: string,
  run: { startedAt: Date; ok: boolean; encrypted: boolean; folderName: string | null; manifest?: Manifest; problems: number; message: string | null },
): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const exists = await pool.query(`SELECT to_regclass('public.backup_runs') IS NOT NULL AS ok`);
    if (!exists.rows[0].ok) return;
    const m = run.manifest;
    await pool.query(
      `INSERT INTO backup_runs (started_at, ok, encrypted, folder_name, tables, rows_total, files, problems, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        run.startedAt, run.ok, run.encrypted, run.folderName,
        m ? Object.keys(m.tables).length : null, m ? Object.values(m.tables).reduce((a, b) => a + b, 0) : null, m ? m.files.length : null,
        run.problems, run.message?.slice(0, 1000) ?? null,
      ],
    );
  } finally {
    await pool.end();
  }
}

/** Backup folders under a root, newest first (for retention reports; nothing is deleted here). */
export async function listBackups(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter((n) => n.startsWith('fleetora-backup-')).sort().reverse();
  } catch {
    return [];
  }
}
