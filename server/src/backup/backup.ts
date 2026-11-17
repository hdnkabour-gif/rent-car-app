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
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { z } from 'zod';

interface Encryption {
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  salt: string; // hex
  N: number;
  r: number;
  p: number;
  /** "fleetora" encrypted with the key: tells a wrong passphrase from a damaged file. */
  check: string;
  /** Non-secret name of the passphrase generation (BACKUP_KEY_LABEL), to know which one opens it. */
  keyLabel?: string;
}

export interface Manifest {
  /** 1 = legacy (no manifest MAC); 2 = encrypted backups carry `mac` over the whole manifest. */
  format: 'fleetora-backup-1' | 'fleetora-backup-2';
  createdAt: string;
  database: string;
  migrations: string[];
  tables: Record<string, number>;
  /** sha256 = of the PLAIN content; storedSha256 = of the file on disk when encrypted. */
  dump: { file: string; sha256: string; bytes: number; storedSha256?: string };
  files: Array<{ key: string; sha256: string; bytes: number }>;
  encryption?: Encryption;
  problems: string[];
  /** HMAC-SHA256 of the manifest (without this field) with a key derived from the backup key. */
  mac?: string;
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
/** Authenticates the manifest itself, so a copy altered off-site (counts, file list…) is detected. */
function manifestMac(key: Buffer, manifest: Manifest): string {
  const { mac: _mac, ...body } = manifest;
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'fleetora-manifest-mac', 32));
  return createHmac('sha256', macKey).update(JSON.stringify(body)).digest('hex');
}
function macMatches(key: Buffer, manifest: Manifest): boolean {
  if (!manifest.mac || !/^[0-9a-f]{64}$/.test(manifest.mac)) return false;
  return timingSafeEqual(Buffer.from(manifest.mac, 'hex'), Buffer.from(manifestMac(key, manifest), 'hex'));
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

/**
 * A short-lived pool for one backup tool operation. An IDLE connection can be ended by the server
 * (e.g. 57P01 when a drill database is dropped WITH (FORCE) while the pool is still closing): without a
 * listener Node would treat that as an unhandled error and stop the process. Queries in progress still
 * reject normally, so no real failure is hidden.
 */
export function toolPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 1 });
  pool.on('error', (err) => {
    if ((err as { code?: string }).code !== '57P01') process.stderr.write(`database connection closed: ${err.message}\n`);
  });
  return pool;
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

async function serverMajorVersion(db: pg.Pool | pg.PoolClient): Promise<number> {
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
export async function createBackup(opts: {
  databaseUrl: string;
  storageDir: string;
  backupRoot: string;
  passphrase?: string;
  /** Production and any off-site copy: an unencrypted backup is refused. */
  requireEncryption?: boolean;
  keyLabel?: string;
  /** Tests only: runs after the snapshot is taken, before the dump (simulates concurrent writes). */
  _afterSnapshot?: () => Promise<void>;
}): Promise<{ dir: string; manifest: Manifest }> {
  if (opts.passphrase !== undefined && opts.passphrase.length < 12) throw new Error('BACKUP_PASSPHRASE must have at least 12 characters.');
  if (opts.requireEncryption && !opts.passphrase) throw new Error('An encrypted backup is required here: set BACKUP_PASSPHRASE (kept outside the backup).');
  if (opts.keyLabel !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(opts.keyLabel)) throw new Error('BACKUP_KEY_LABEL: 1-40 letters, digits, dot, dash or underscore.');
  const dir = path.join(opts.backupRoot, `fleetora-backup-${stamp()}`);
  await mkdir(opts.backupRoot, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }); // fails if it exists: a backup is never overwritten
  await mkdir(path.join(dir, 'files'), { mode: 0o700 });
  let encryption: Encryption | undefined;
  let key: Buffer | null = null;
  if (opts.passphrase) {
    const salt = randomBytes(16).toString('hex');
    key = deriveKey(opts.passphrase, { salt, ...KDF });
    encryption = {
      algorithm: 'aes-256-gcm', kdf: 'scrypt', salt, ...KDF, check: encrypt(key, Buffer.from('fleetora')).toString('base64'),
      ...(opts.keyLabel ? { keyLabel: opts.keyLabel } : {}),
    };
  }
  const pool = toolPool(opts.databaseUrl);
  const problems: string[] = [];
  // RC-01 (independent audit, #22): the dump, the record counts and the list of files must describe the
  // SAME moment. One read-only REPEATABLE READ transaction exports its snapshot; pg_dump --snapshot uses it
  // and the inventory/file list are read inside that transaction. Writes committed meanwhile are in none
  // of them. Files are content-addressed and never deleted, so every listed file still exists on disk.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    if (!/^[0-9A-F-]+$/i.test(snapshot)) throw new Error('unexpected snapshot id');
    await opts._afterSnapshot?.();
    const inv = await inventory(client);
    const rows = (await client.query<{ storage_key: string; sha256: string; size_bytes: number }>('SELECT storage_key, sha256, size_bytes FROM stored_files ORDER BY storage_key')).rows;
    const major = await serverMajorVersion(client);
    const dump = await withTemp(async (tmp) => {
      const plainFile = key ? path.join(tmp, 'database.dump') : path.join(dir, 'database.dump');
      await run(postgresClientCommand('pg_dump', major),
        ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, `--file=${plainFile}`], pgEnv(opts.databaseUrl));
      const plainSha = await sha256File(plainFile);
      const bytes = (await stat(plainFile)).size;
      if (!key) return { file: 'database.dump', sha256: plainSha, bytes };
      const enc = encrypt(key, await readFile(plainFile));
      await writeFile(path.join(dir, 'database.dump.enc'), enc, { mode: 0o600 });
      return { file: 'database.dump.enc', sha256: plainSha, bytes, storedSha256: sha256(enc) };
    });
    await client.query('COMMIT');
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
      format: key ? 'fleetora-backup-2' : 'fleetora-backup-1',
      createdAt: new Date().toISOString(),
      database: inv.name,
      migrations: inv.migrations,
      tables: inv.tables,
      dump,
      files,
      ...(encryption ? { encryption } : {}),
      problems,
    };
    if (key) manifest.mac = manifestMac(key, manifest);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { dir, manifest };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------- RC-02: never trust a backup's own paths
// (independent audit, #22). A backup may come back from an external disk or a bucket: its manifest is
// validated against a strict, bounded schema BEFORE any file is read or written, every file key must be
// the content address of its own SHA-256, the dump name comes from a fixed list, and no path may leave
// its folder or go through a symbolic link.
const HEX64 = /^[0-9a-f]{64}$/;
const ManifestSchema = z
  .object({
    format: z.enum(['fleetora-backup-1', 'fleetora-backup-2']),
    createdAt: z.string().max(40),
    database: z.string().min(1).max(63),
    migrations: z.array(z.string().regex(/^\d{4}_[a-z0-9_]{1,80}$/)).max(1000),
    tables: z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/), z.number().int().min(0)),
    dump: z.object({
      file: z.enum(['database.dump', 'database.dump.enc']),
      sha256: z.string().regex(HEX64),
      bytes: z.number().int().min(0),
      storedSha256: z.string().regex(HEX64).optional(),
    }).strict(),
    files: z.array(z.object({ key: z.string().regex(KEY), sha256: z.string().regex(HEX64), bytes: z.number().int().min(0) }).strict()
      .refine((f) => f.key === `${f.sha256.slice(0, 2)}/${f.sha256}`, 'file key must be the content address of its SHA-256')).max(10_000_000),
    encryption: z.object({
      algorithm: z.literal('aes-256-gcm'),
      kdf: z.literal('scrypt'),
      salt: z.string().regex(/^[0-9a-f]{32}$/),
      // Bounded: a crafted manifest must not make scrypt use gigabytes of memory or hours of CPU.
      N: z.number().int().refine((n) => n >= 2 ** 14 && n <= 2 ** 20 && (n & (n - 1)) === 0, 'N must be a power of two between 2^14 and 2^20'),
      r: z.number().int().min(1).max(16),
      p: z.number().int().min(1).max(4),
      check: z.string().max(200),
      keyLabel: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
    }).strict().optional(),
    problems: z.array(z.string().max(2000)).max(100_000),
    mac: z.string().regex(HEX64).optional(),
  })
  .strict()
  .refine((m) => (m.dump.file === 'database.dump.enc') === Boolean(m.encryption), 'dump file name does not match the encryption setting');

/** Reads and validates a manifest; throws with the first schema problems. No other file is touched. */
export async function readManifest(dir: string): Promise<Manifest> {
  const file = path.join(dir, 'manifest.json');
  if (!(await lstat(file)).isFile()) throw new Error('manifest.json is not a regular file');
  const raw = await readFile(file, 'utf8');
  if (raw.length > 512 * 1024 * 1024) throw new Error('manifest.json is too large');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`manifest is invalid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return parsed.data as Manifest;
}

/** A path inside `root` (resolved), or an error. */
export function insideRoot(root: string, rel: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) throw new Error(`path escapes its folder: ${rel}`);
  return full;
}

/** Refuses symbolic links on the way from `root` (excluded) down to `full` (included, if it exists). */
async function assertNoSymlinkBelow(root: string, full: string): Promise<void> {
  const base = path.resolve(root);
  const parts = path.relative(base, full).split(path.sep);
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    try {
      if ((await lstat(cur)).isSymbolicLink()) throw new Error(`symbolic link refused: ${path.relative(base, cur)}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  }
}

/** Reads one backed-up file as plain bytes (decrypting when needed); regular files inside the backup only. */
async function readBackupFile(dir: string, key: Buffer | null, name: string): Promise<Buffer> {
  const full = insideRoot(dir, key ? `${name}.enc` : name);
  await assertNoSymlinkBelow(dir, full);
  const data = await readFile(full);
  return key ? decrypt(key, data) : data;
}

/** Every byte is checked against the manifest. Returns the list of problems (empty = good backup). */
export async function verifyBackup(dir: string, passphrase?: string): Promise<{ manifest: Manifest; problems: string[] }> {
  let manifest: Manifest;
  try {
    manifest = await readManifest(dir);
  } catch (e) {
    // Nothing else is read: an invalid manifest is never trusted for paths.
    return { manifest: { format: 'fleetora-backup-1', createdAt: '', database: '', migrations: [], tables: {}, dump: { file: 'database.dump', sha256: '', bytes: 0 }, files: [], problems: [] }, problems: [(e as Error).message] };
  }
  const problems = [...manifest.problems.map((p) => `recorded at backup time: ${p}`)];
  let key: Buffer | null;
  try {
    key = keyFor(manifest, passphrase);
  } catch (e) {
    return { manifest, problems: [...problems, (e as Error).message] };
  }
  // Format 2 (all encrypted backups since 2026-11-17): the manifest must carry a valid MAC.
  // An unencrypted manifest claiming format 2, or a missing/wrong MAC, means it was altered.
  if (manifest.format === 'fleetora-backup-2' && (!key || !macMatches(key, manifest))) {
    problems.push('manifest was altered (authentication failed)');
  }
  await withTemp(async (tmp) => {
    try {
      let dumpFile = insideRoot(dir, manifest.dump.file);
      await assertNoSymlinkBelow(dir, dumpFile);
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
      const msg = (e as Error).message;
      problems.push(
        (e as NodeJS.ErrnoException).code === 'ENOENT' ? `file ${f.key} is missing from the backup`
          : /symbolic link|escapes/.test(msg) ? `file ${f.key}: ${msg}` : `file ${f.key} is damaged in the backup`,
      );
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
  const pool = toolPool(opts.databaseUrl);
  try {
    const existing = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
    );
    if (existing.rows[0]!.n > 0) throw new Error('The target database is not empty: restore only into a new, empty database. Nothing was changed.');

    for (const f of manifest.files) {
      // The key was validated by the schema (content address); containment and links are checked again here.
      const dst = insideRoot(opts.storageDir, f.key);
      await assertNoSymlinkBelow(opts.storageDir, dst);
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
      let dumpFile = insideRoot(opts.dir, manifest.dump.file);
      await assertNoSymlinkBelow(opts.dir, dumpFile);
      if (key) {
        dumpFile = path.join(tmp, 'database.dump');
        await writeFile(dumpFile, decrypt(key, await readFile(insideRoot(opts.dir, manifest.dump.file))), { mode: 0o600 });
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
    if (!KEY.test(f.storage_key)) {
      problems.push(`invalid storage key ${f.storage_key}`);
      continue;
    }
    try {
      if ((await sha256File(path.join(storageDir, f.storage_key))) !== f.sha256) problems.push(`file ${f.storage_key} is damaged`);
    } catch {
      problems.push(`file ${f.storage_key} is missing`);
    }
  }
  return problems;
}

export interface OffsiteResult {
  kind: 'dir' | 's3';
  ok: boolean;
  objects?: number;
  bytes?: number;
  message?: string | null;
}

async function hasColumn(pool: pg.Pool, table: string, column: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Records the result of a backup run in the database (table backup_runs, migrations 0009/0017) so the
 * manager sees a missing or failed backup, or a failed off-site copy, in the app. Never stores paths or secrets.
 */
export async function recordBackupRun(
  databaseUrl: string,
  run: {
    startedAt: Date; ok: boolean; encrypted: boolean; folderName: string | null; manifest?: Manifest; problems: number; message: string | null;
    offsite?: OffsiteResult | null;
  },
): Promise<void> {
  const pool = toolPool(databaseUrl);
  try {
    const exists = await pool.query(`SELECT to_regclass('public.backup_runs') IS NOT NULL AS ok`);
    if (!exists.rows[0].ok) return;
    const m = run.manifest;
    const base = [
      run.startedAt, run.ok, run.encrypted, run.folderName,
      m ? Object.keys(m.tables).length : null, m ? Object.values(m.tables).reduce((a, b) => a + b, 0) : null, m ? m.files.length : null,
      run.problems, run.message?.slice(0, 1000) ?? null,
    ];
    if (run.offsite && (await hasColumn(pool, 'backup_runs', 'offsite_ok'))) {
      const o = run.offsite;
      await pool.query(
        `INSERT INTO backup_runs (started_at, ok, encrypted, folder_name, tables, rows_total, files, problems, message,
                                  offsite_kind, offsite_ok, offsite_objects, offsite_bytes, offsite_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [...base, o.kind, o.ok, o.objects ?? null, o.bytes ?? null, o.message?.slice(0, 1000) ?? null],
      );
    } else {
      await pool.query(
        `INSERT INTO backup_runs (started_at, ok, encrypted, folder_name, tables, rows_total, files, problems, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        base,
      );
    }
  } finally {
    await pool.end();
  }
}

/** Records a restore drill (table backup_drills, migration 0017). Counts only: no data, no paths. */
export async function recordDrill(
  databaseUrl: string,
  d: {
    startedAt: Date; ok: boolean; source: 'offsite' | 'local'; offsiteKind: 'dir' | 's3' | null; backupName: string | null;
    tables: number | null; rowsTotal: number | null; filesVerified: number | null; negativePassed: number; negativeTotal: number; message: string | null;
  },
): Promise<void> {
  const pool = toolPool(databaseUrl);
  try {
    const exists = await pool.query(`SELECT to_regclass('public.backup_drills') IS NOT NULL AS ok`);
    if (!exists.rows[0].ok) return;
    await pool.query(
      `INSERT INTO backup_drills (started_at, ok, source, offsite_kind, backup_name, tables, rows_total, files_verified,
                                  negative_checks_passed, negative_checks_total, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [d.startedAt, d.ok, d.source, d.offsiteKind, d.backupName, d.tables, d.rowsTotal, d.filesVerified, d.negativePassed, d.negativeTotal, d.message?.slice(0, 1000) ?? null],
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
