import { mkdtempSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createBackup, LEGACY_WARNING, recordBackupRun, recordDrill, restoreBackup, toolPool, verifyBackup, type Manifest } from '../src/backup/backup.js';
import { checkBackupLocations } from '../src/backup/locations.js';
import { DirTarget, listOffsite, offsiteFromEnv, pullBackup, pushBackup, removeOffsiteBackup, S3Target } from '../src/backup/offsite.js';
import { planLocalRetention, planRetention } from '../src/backup/retention.js';
import { DRILL_DB_PATTERN, FlakyTarget, runDrill } from '../src/backup/drill.js';
import { createUser, CSRF, loginAgent, resetDatabase, RUN_DB_URL, setupTestApp, TEST_STORAGE_DIR, type TestContext } from './helpers.js';

// Issue #14 — off-site copies and restore drills. Synthetic data only; the "provider" is a local fake.
const PDF = Buffer.from('%PDF-1.4\n% fleetora synthetic off-site test\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fleetora-offsite-photo')]);
const PASS = 'synthetic-offsite-passphrase-0001';
const quick = { attempts: 4, baseMs: 5 };

let ctx: TestContext;
let manager: TestAgent;
let maintenance: pg.Pool;
let work: string;
let backupDir: string;
let manifest: Manifest;

/** Minimal private S3-compatible server (path style) keeping objects in memory; can drop requests. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; sha256: string | null }>();
  const state = { failNext: 0, requests: 0, down: false };
  const server: Server = createServer((req, res) => {
    state.requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (state.down || state.failNext > 0) {
        if (state.failNext > 0) state.failNext -= 1;
        res.writeHead(503, { 'Content-Type': 'application/xml' }).end('<Error><Code>SlowDown</Code></Error>');
        return;
      }
      const u = new URL(req.url!, 'http://x');
      const [, bucket, ...rest] = u.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      if (bucket !== 'fleetora-private') return void res.writeHead(404).end();
      if (req.method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), sha256: (req.headers['x-amz-meta-sha256'] as string) ?? null });
        return void res.writeHead(200, { ETag: '"x"' }).end();
      }
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('')}</ListBucketResult>`;
        return void res.writeHead(200, { 'Content-Type': 'application/xml' }).end(xml);
      }
      const o = objects.get(key);
      if (req.method === 'HEAD') {
        if (!o) return void res.writeHead(404).end();
        return void res.writeHead(200, { 'Content-Length': o.body.length, ...(o.sha256 ? { 'x-amz-meta-sha256': o.sha256 } : {}) }).end();
      }
      if (req.method === 'GET') {
        if (!o) return void res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
        return void res.writeHead(200, { 'Content-Length': o.body.length }).end(o.body);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return void res.writeHead(204).end();
      }
      res.writeHead(405).end();
    });
  });
  return { server, objects, state };
}

beforeAll(async () => {
  ctx = await setupTestApp({ BACKUP_OFFSITE_REQUIRED: 'true' });
  maintenance = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  work = mkdtempSync(path.join(tmpdir(), 'fleetora-offsite-test-'));
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  const cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  const car = (await manager.post('/api/vehicles').set(CSRF).send({ branchId: cas, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 10 })).body.id;
  const client = (await manager.post('/api/customers').set(CSRF).send({ fullName: 'Client Démo', phone: '0600000001' })).body.customer.id;
  await manager.post(`/api/customers/${client}/documents?kind=passport`).set(CSRF).set('Content-Type', 'application/pdf').send(PDF).expect(201);
  await manager.post(`/api/vehicles/${car}/photos`).set(CSRF).set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
  const r = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: path.join(work, 'local'), passphrase: PASS, requireEncryption: true, keyLabel: 'test-2026-11' });
  backupDir = r.dir;
  manifest = r.manifest;
});
afterAll(async () => {
  await maintenance.end();
  await ctx.pool.end();
  await rm(work, { recursive: true, force: true });
});

describe('encryption and manifest authentication', () => {
  it('production / off-site backups must be encrypted; the manifest is authenticated (format 2) and labelled', async () => {
    await expect(createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: path.join(work, 'plain'), requireEncryption: true })).rejects.toThrow(/encrypted backup is required/);
    expect(manifest.format).toBe('fleetora-backup-2');
    expect(manifest.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.encryption?.keyLabel).toBe('test-2026-11');
    expect((await verifyBackup(backupDir, PASS)).problems).toEqual([]);
  });

  it('an altered manifest is detected (counts, file list, or a stripped MAC)', async () => {
    const alter = async (label: string, fn: (m: Manifest) => void) => {
      const dir = path.join(work, `alter-${label}`, path.basename(backupDir));
      await cp(backupDir, dir, { recursive: true });
      const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
      fn(m);
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
      return (await verifyBackup(dir, PASS)).problems.join(' | ');
    };
    expect(await alter('count', (m) => (m.tables.customers = 99))).toMatch(/manifest was altered/);
    expect(await alter('files', (m) => m.files.pop())).toMatch(/manifest was altered/);
    expect(await alter('mac', (m) => delete m.mac)).toMatch(/manifest was altered/);
    expect(await alter('plain', (m) => delete m.encryption)).toMatch(/manifest is invalid|manifest was altered/);
  });
});

describe('where backups may live', () => {
  it('never inside the uploads folder; in production never on the same disk as the uploads', async () => {
    const storage = path.join(work, 'files');
    await expect(checkBackupLocations({ storageDir: storage, backupDir: path.join(storage, 'backups'), production: false })).rejects.toThrow(/inside STORAGE_DIR/);
    await expect(checkBackupLocations({ storageDir: storage, backupDir: path.join(work, 'b'), offsiteDir: path.join(storage, 'o'), production: false })).rejects.toThrow(/OFFSITE_DIR must not be inside STORAGE_DIR/);
    await expect(checkBackupLocations({ storageDir: storage, backupDir: path.join(work, 'b'), offsiteDir: path.join(work, 'b', 'o'), production: false })).rejects.toThrow(/inside BACKUP_DIR/);
    // Same temporary disk here: refused in production, a warning in development, allowed as a staging area.
    await expect(checkBackupLocations({ storageDir: storage, backupDir: path.join(work, 'b'), production: true })).rejects.toThrow(/same disk/);
    expect(await checkBackupLocations({ storageDir: storage, backupDir: path.join(work, 'b'), production: false })).toEqual([expect.stringMatching(/same disk/)]);
    await expect(checkBackupLocations({ storageDir: storage, backupDir: path.join(work, 'b'), production: true, localIsStagingOnly: true })).resolves.toEqual([]);
    await expect(checkBackupLocations({ storageDir: storage, backupDir: path.join(work, 'b'), offsiteDir: path.join(work, 'o'), production: true, localIsStagingOnly: true })).rejects.toThrow(/not an off-site copy/);
  });

  it('off-site settings come from the environment; secrets are required but never part of the label', () => {
    expect(offsiteFromEnv({})).toBeNull();
    expect(() => offsiteFromEnv({ OFFSITE_KIND: 'ftp' })).toThrow(/dir" or "s3/);
    expect(() => offsiteFromEnv({ OFFSITE_KIND: 's3', OFFSITE_S3_BUCKET: 'b' })).toThrow(/OFFSITE_S3_ACCESS_KEY_ID, OFFSITE_S3_SECRET_ACCESS_KEY/);
    const t = offsiteFromEnv({ OFFSITE_KIND: 's3', OFFSITE_S3_BUCKET: 'b', OFFSITE_S3_PREFIX: 'p', OFFSITE_S3_ACCESS_KEY_ID: 'AKIDSYNTHETIC', OFFSITE_S3_SECRET_ACCESS_KEY: 'synthetic-secret-value' })!;
    expect(t.label).toBe('s3:b/p/');
    expect(JSON.stringify(t.label)).not.toMatch(/AKID|secret/);
  });
});

describe('off-site copy to a detached folder (external disk / NAS)', () => {
  it('uploads every object, writes the completion marker last, downloads into a fresh folder and verifies', async () => {
    const target = new DirTarget(path.join(work, 'disk2'));
    const r = await pushBackup(backupDir, target, { retry: quick });
    expect(r.objects).toBe(2 + manifest.files.length); // manifest + dump + files
    expect((await listOffsite(target)).complete).toEqual([path.basename(backupDir)]);
    await expect(pushBackup(backupDir, target, { retry: quick })).rejects.toThrow(/never overwritten/);
    const { dir } = await pullBackup(target, path.basename(backupDir), path.join(work, 'pulled-dir'), { retry: quick });
    expect((await verifyBackup(dir, PASS)).problems).toEqual([]);
    // A tampered object at the target is caught on download, before anything is used.
    const victim = (await target.list(`${path.basename(backupDir)}/files/`))[0]!;
    await writeFile(path.join(work, 'disk2', victim), Buffer.from('tampered'));
    await expect(pullBackup(target, path.basename(backupDir), path.join(work, 'pulled-dir-2'), { retry: quick })).rejects.toThrow(/differs from the off-site record/);
  });

  it('an unencrypted backup never leaves the host', async () => {
    const plain = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: path.join(work, 'plain-ok') });
    await expect(pushBackup(plain.dir, new DirTarget(path.join(work, 'disk3')), { retry: quick })).rejects.toThrow(/UNENCRYPTED/);
  });
});

describe('off-site copy to a private S3-compatible bucket', () => {
  let s3: ReturnType<typeof fakeS3>;
  let target: S3Target;
  beforeAll(async () => {
    s3 = fakeS3();
    await new Promise<void>((r) => s3.server.listen(0, '127.0.0.1', r));
    target = new S3Target({
      bucket: 'fleetora-private', prefix: 'company/', region: 'eu-west-3', forcePathStyle: true,
      endpoint: `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`,
      accessKeyId: 'AKIDSYNTHETIC', secretAccessKey: 'synthetic-secret-value',
    });
  });
  afterAll(() => new Promise<void>((r) => s3.server.close(() => r())));

  it('push → list → pull → verify; the provider only ever holds ciphertext', async () => {
    const r = await pushBackup(backupDir, target, { retry: quick });
    expect([...s3.objects.keys()].every((k) => k.startsWith(`company/${path.basename(backupDir)}/`))).toBe(true);
    expect(s3.objects.size).toBe(r.objects + 1); // + completion marker
    for (const [, o] of s3.objects) {
      expect(o.body.includes(Buffer.from('Client Démo'))).toBe(false);
      expect(o.body.includes(PDF)).toBe(false);
    }
    expect((await listOffsite(target)).complete).toEqual([path.basename(backupDir)]);
    const { dir } = await pullBackup(target, path.basename(backupDir), path.join(work, 'pulled-s3'), { retry: quick });
    expect((await verifyBackup(dir, PASS)).problems).toEqual([]);
  });

  it('network failures: temporary errors are retried; a lasting outage is reported, never a partial success', async () => {
    const name = path.basename(backupDir);
    s3.state.failNext = 3;
    const { dir } = await pullBackup(target, name, path.join(work, 'pulled-s3-flaky'), { retry: quick });
    expect((await verifyBackup(dir, PASS)).problems).toEqual([]);
    s3.state.down = true;
    await expect(pullBackup(target, name, path.join(work, 'pulled-s3-down'), { retry: { attempts: 3, baseMs: 1 } })).rejects.toThrow(/failed after 3 attempts/);
    const other = path.join(work, 'local2');
    const b2 = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: other, passphrase: PASS });
    await expect(pushBackup(b2.dir, target, { retry: { attempts: 2, baseMs: 1 } })).rejects.toThrow(/failed after 2 attempts/);
    s3.state.down = false;
    // The interrupted upload has no completion marker: it is listed apart and never restored.
    const listed = await listOffsite(target);
    expect(listed.complete).not.toContain(path.basename(b2.dir));
    // Retention removes the marker first, then the objects.
    expect(await removeOffsiteBackup(target, name)).toBeGreaterThan(2);
    expect((await listOffsite(target)).complete).toEqual([]);
  });
});

describe('retention', () => {
  const at = (iso: string) => `fleetora-backup-${iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-000`;
  it('keeps daily/weekly/monthly, the newest and anything younger than the minimum age; removes the rest', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const names: string[] = [];
    for (let d = 0; d < 120; d += 1) names.push(at(new Date(now.getTime() - d * 86400_000 - 3600_000).toISOString()));
    names.push(at(new Date(now.getTime() - 2 * 3600_000).toISOString())); // second backup today
    const plan = planRetention(names, { daily: 7, weekly: 4, monthly: 3, minAgeHours: 48 }, now);
    expect(plan.keep[0]!.reasons).toContain('newest');
    expect(plan.keep.length).toBeGreaterThanOrEqual(7);
    expect(plan.keep.length).toBeLessThanOrEqual(7 + 4 + 3 + 2);
    expect(plan.remove.length).toBe(names.length - plan.keep.length);
    expect(plan.remove.every((n) => !plan.keep.some((k) => k.name === n))).toBe(true);
    expect(planRetention([names[0]!], { daily: 1, weekly: 0, monthly: 0, minAgeHours: 24 }, now).remove).toEqual([]);
    expect(planRetention(['not-a-backup', names[0]!]).ignored).toEqual(['not-a-backup']);
  });
});

describe('restore drill', () => {
  it('off-site copy → detached folder → fresh isolated database → every SHA-256 → negative checks → dropped', async () => {
    const target = new DirTarget(path.join(work, 'disk-drill'));
    await pushBackup(backupDir, new FlakyTarget(target, 1), { retry: quick });
    const report = await runDrill({ adminDatabaseUrl: process.env.TEST_DATABASE_URL!, passphrase: PASS, target, workRoot: work, retry: quick });
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.negative.filter((n) => !n.passed)).toEqual([]);
    expect(report).toMatchObject({ ok: true, source: 'offsite', offsiteKind: 'dir', encrypted: true, files: manifest.files.length, filesVerified: manifest.files.length });
    expect(report.negative.map((n) => n.check)).toEqual(
      expect.arrayContaining([
        'wrong passphrase is refused', 'truncated dump is detected', 'missing file is detected', 'damaged file is detected',
        'altered manifest is detected', 'interrupted upload (no completion marker) is never restored',
        'network failures are retried, then the copy is verified', 'a lasting network failure is reported, nothing half-restored',
        'an unencrypted backup is never copied off-site', 'restore into a non-empty database is refused',
      ]),
    );
    // The drill database is gone and the source database is untouched.
    const left = await maintenance.query(`SELECT datname FROM pg_database WHERE datname LIKE 'fleetora\\_drill\\_%'`);
    expect(left.rows.filter((r) => DRILL_DB_PATTERN.test(r.datname))).toEqual([]);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n).toBe(manifest.tables.customers);
    // No data in the evidence: no customer name, no file content, no passphrase.
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/Client Démo|synthetic-offsite-passphrase|%PDF/);
  });

  it('a drill with the wrong passphrase fails and says why', async () => {
    const target = new DirTarget(path.join(work, 'disk-drill'));
    const report = await runDrill({ adminDatabaseUrl: process.env.TEST_DATABASE_URL!, passphrase: 'wrong-passphrase-0000', target, workRoot: work, retry: quick });
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => !s.ok)).toMatchObject({ step: 'verify backup', detail: expect.stringMatching(/Wrong backup passphrase/) });
  });
});

describe('RC-01 (independent audit #22): one snapshot for dump, counts and files', () => {
  it('writes committed while the backup runs are in neither the dump nor the manifest; the restore proof passes', async () => {
    const count = async (t: string) => (await ctx.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
    const [branches, files] = [await count('branches'), await count('stored_files')];
    const late = Buffer.from('%PDF-1.4\n% fleetora synthetic file committed during the backup\n');
    const root = path.join(work, 'rc01');
    const { dir, manifest: m } = await createBackup({
      databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: root, passphrase: PASS,
      _afterSnapshot: async () => {
        // Separate connection, committed immediately — exactly the concurrent write of the audit scenario.
        await manager.post('/api/branches').set(CSRF).send({ code: 'LATE', name: 'Agence tardive', city: 'Rabat' }).expect(201);
        const c = (await ctx.pool.query(`SELECT id FROM customers LIMIT 1`)).rows[0].id;
        await manager.post(`/api/customers/${c}/documents?kind=passport`).set(CSRF).set('Content-Type', 'application/pdf').send(late).expect(201);
      },
    });
    expect(await count('branches')).toBe(branches + 1); // the write really happened…
    expect(m.tables.branches).toBe(branches); // …but after the snapshot: not in the manifest
    expect(m.tables.stored_files).toBe(files);
    expect(m.files).toHaveLength(files);
    expect((await verifyBackup(dir, PASS)).problems).toEqual([]);
    // Restore into a fresh isolated database: counts and every file must match the manifest exactly.
    const report = await runDrill({ adminDatabaseUrl: process.env.TEST_DATABASE_URL!, passphrase: PASS, target: null, localBackupDir: root, workRoot: work, negative: false });
    expect(report.steps.filter((x) => !x.ok)).toEqual([]);
    expect(report).toMatchObject({ ok: true, rowsTotal: Object.values(m.tables).reduce((a, b) => a + b, 0), filesVerified: files });
  });
});

describe('RC-02 (independent audit #22): a crafted backup can never steer reads or writes', () => {
  /** A copy of the real backup turned into an UNENCRYPTED one, as an attacker could prepare it. */
  async function plainCopy(label: string) {
    const plain = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: path.join(work, `rc02-src-${label}`) });
    const dir = path.join(work, `rc02-${label}`, path.basename(plain.dir));
    await cp(plain.dir, dir, { recursive: true });
    const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    return { dir, m, save: (x: unknown) => writeFile(path.join(dir, 'manifest.json'), JSON.stringify(x)) };
  }
  const restoreInto = async (dir: string, storage: string) => {
    const name = `fleetora_drill_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    await maintenance.query(`CREATE DATABASE ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    try {
      return await import('../src/backup/backup.js').then(({ restoreBackup }) => restoreBackup({ dir, databaseUrl: u.toString(), storageDir: storage }));
    } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  };

  it("the audit's scenario: a traversal key with matching hashes is refused before any file is written", async () => {
    const { dir, m, save } = await plainCopy('traversal');
    const f = m.files[0]!;
    await mkdir(path.join(dir, 'escaped'), { recursive: true });
    await cp(path.join(dir, 'files', f.key), path.join(dir, 'escaped', 'x'));
    m.files[0] = { ...f, key: '../../escaped' };
    await save(m);
    const outside = path.join(work, 'rc02-outside');
    const storage = path.join(outside, 'a', 'b', 'storage');
    expect((await verifyBackup(dir)).problems.join()).toMatch(/manifest is invalid/);
    await expect(restoreInto(dir, storage)).rejects.toThrow(/not intact; nothing was restored/);
    expect(await readdir(outside).catch(() => [])).toEqual([]); // nothing created anywhere
  });

  it('absolute paths, keys that are not their own content address, unknown dump names and huge KDF settings are refused', async () => {
    const cases: Array<[string, (m: Manifest) => void, RegExp]> = [
      ['absolute key', (m) => (m.files[0]!.key = '/etc/passwd'), /manifest is invalid/],
      ['key of another file', (m) => (m.files[0]!.key = `aa/${'a'.repeat(64)}`), /content address/],
      ['dump path', (m) => ((m.dump as { file: string }).file = '../database.dump'), /manifest is invalid/],
      ['extra field', (m) => Object.assign(m, { restoreTo: '/' }), /manifest is invalid/],
    ];
    for (const [label, fn, re] of cases) {
      const { dir, m, save } = await plainCopy(label.replace(/ /g, '-'));
      fn(m);
      await save(m);
      expect((await verifyBackup(dir)).problems.join(), label).toMatch(re);
    }
    const enc = path.join(work, 'rc02-kdf', path.basename(backupDir));
    await cp(backupDir, enc, { recursive: true });
    const m = JSON.parse(await readFile(path.join(enc, 'manifest.json'), 'utf8')) as Manifest;
    m.encryption!.N = 2 ** 30; // would need ~1 TiB of memory
    await writeFile(path.join(enc, 'manifest.json'), JSON.stringify(m));
    const t0 = Date.now();
    expect((await verifyBackup(enc, PASS)).problems.join()).toMatch(/N must be a power of two between/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('symbolic links are refused: inside the backup, in the restore destination, and on an off-site disk', async () => {
    // Inside the backup: a "file" that is a link to something else on the machine.
    const { dir, m } = await plainCopy('link-in');
    const victim = path.join(dir, 'files', m.files[0]!.key);
    await rm(victim);
    await symlink(path.join(TEST_STORAGE_DIR, m.files[0]!.key), victim);
    expect((await verifyBackup(dir)).problems.join()).toMatch(/symbolic link refused/);
    // In the destination: storage/<xx> points outside; nothing may be written through it.
    const clean = await plainCopy('link-out');
    const storage = path.join(work, 'rc02-storage');
    const elsewhere = path.join(work, 'rc02-elsewhere');
    await mkdir(storage, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(storage, clean.m.files[0]!.key.slice(0, 2)));
    await expect(restoreInto(clean.dir, storage)).rejects.toThrow(/symbolic link refused/);
    expect(await readdir(elsewhere)).toEqual([]);
    // Off-site disk: a linked object is never followed.
    const disk = path.join(work, 'rc02-disk');
    const t = new DirTarget(disk);
    await pushBackup(backupDir, t, { retry: quick });
    const obj = (await t.list(`${path.basename(backupDir)}/files/`))[0]!;
    await rm(path.join(disk, obj));
    await symlink(path.join(TEST_STORAGE_DIR, 'x'), path.join(disk, obj));
    await expect(pullBackup(t, path.basename(backupDir), path.join(work, 'rc02-pulled'), { retry: { attempts: 1, baseMs: 1 } })).rejects.toThrow(/symbolic link refused/);
  });

  it('an off-site completion marker cannot introduce other paths', async () => {
    const disk = path.join(work, 'rc02-marker');
    const t = new DirTarget(disk);
    await pushBackup(backupDir, t, { retry: quick });
    const markerPath = path.join(disk, path.basename(backupDir), 'COMPLETE.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.objects.push({ path: '../../outside.json', bytes: 1, sha256: 'a'.repeat(64) });
    await writeFile(markerPath, JSON.stringify(marker));
    await expect(pullBackup(t, path.basename(backupDir), path.join(work, 'rc02-pulled-2'), { retry: quick })).rejects.toThrow(/invalid object in completion marker/);
  });
});

describe('B23-1 (integration gate #23): failed attempts never displace the last recoverable backup', () => {
  it('daily=1, weekly=0, monthly=0: the old complete backup survives newer incomplete folders', async () => {
    const root = path.join(work, 'b231');
    const good = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: root, passphrase: PASS });
    const goodName = 'fleetora-backup-20261101-020000-000'; // make it older than the 48 h minimum age
    await rename(good.dir, path.join(root, goodName));
    for (const n of ['fleetora-backup-20261110-020000-000', 'fleetora-backup-20261115-020000-000']) {
      await mkdir(path.join(root, n, 'files'), { recursive: true }); // run died before writing manifest.json
      await writeFile(path.join(root, n, 'database.dump.enc'), 'partial');
    }
    const now = new Date('2026-11-17T12:00:00Z');
    const policy = { daily: 1, weekly: 0, monthly: 0, minAgeHours: 48 };
    // The bug the gate found: planning on raw folder names deletes the only good backup.
    const raw = planRetention([goodName, 'fleetora-backup-20261110-020000-000', 'fleetora-backup-20261115-020000-000'], policy, now);
    expect(raw.remove).toContain(goodName);
    // Fixed: only complete backups are planned; the good one is the newest complete and is kept.
    const plan = await planLocalRetention(root, policy, now);
    expect(plan.keep.map((k) => k.name)).toEqual([goodName]);
    expect(plan.remove).toEqual([]);
    expect(plan.incomplete.sort()).toEqual(['fleetora-backup-20261110-020000-000', 'fleetora-backup-20261115-020000-000']);
    expect(plan.incompleteToRemove.sort()).toEqual(['fleetora-backup-20261110-020000-000', 'fleetora-backup-20261115-020000-000']);
    // A drill on this folder uses the newest COMPLETE backup, not a failed attempt.
    const report = await runDrill({ adminDatabaseUrl: process.env.TEST_DATABASE_URL!, passphrase: PASS, target: null, localBackupDir: root, workRoot: work, negative: false });
    expect(report).toMatchObject({ ok: true, backupName: goodName });
  });
});

describe('B23-2 (integration gate #23): no authentication downgrade', () => {
  async function downgraded(label: string, extra: (m: Manifest) => void = () => undefined) {
    const dir = path.join(work, `b232-${label}`, path.basename(backupDir));
    await cp(backupDir, dir, { recursive: true });
    const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
    m.format = 'fleetora-backup-1';
    delete m.mac;
    extra(m);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
    return dir;
  }

  it('a v2 manifest turned into v1 without MAC (and altered) is refused, by verify and by restore', async () => {
    const dir = await downgraded('tamper', (m) => { m.tables.customers = 99; m.files.pop(); });
    const v = await verifyBackup(dir, PASS);
    expect(v.problems.join()).toMatch(/not authenticated/);
    await expect(restoreBackup({ dir, databaseUrl: 'postgres://unused/x', storageDir: path.join(work, 'b232-never'), passphrase: PASS })).rejects.toThrow(/nothing was restored/);
    expect(await readdir(path.join(work, 'b232-never')).catch(() => [])).toEqual([]);
  });

  it('the explicit legacy opt-in accepts it only with a visible warning, never as authentic', async () => {
    const dir = await downgraded('legacy');
    const v = await verifyBackup(dir, PASS, { allowUnauthenticatedLegacy: true });
    expect(v.problems).toEqual([]);
    expect(v.warnings).toEqual([LEGACY_WARNING]);
    // The opt-in does not hide tampering that the contents reveal: altered counts fail the restore proof.
    const altered = await downgraded('legacy-altered', (m) => { m.tables.branches = (m.tables.branches ?? 0) + 5; });
    expect((await verifyBackup(altered, PASS, { allowUnauthenticatedLegacy: true })).warnings).toEqual([LEGACY_WARNING]);
    const db = `fleetora_drill_${Date.now().toString(16).slice(-12).padStart(12, '0')}`;
    await maintenance.query(`CREATE DATABASE ${db}`);
    try {
      const u = new URL(process.env.TEST_DATABASE_URL!);
      u.pathname = `/${db}`;
      const r = await restoreBackup({ dir: altered, databaseUrl: u.toString(), storageDir: path.join(work, 'b232-legacy-files'), passphrase: PASS, allowUnauthenticatedLegacy: true });
      expect(r.warnings).toEqual([LEGACY_WARNING]);
      expect(r.problems.join()).toMatch(/table branches: \d+ rows instead of/); // the proof exposes the alteration
    } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
    // …and a wrong passphrase is still refused with or without the opt-in.
    expect((await verifyBackup(dir, 'wrong-passphrase-0000', { allowUnauthenticatedLegacy: true })).problems.join()).toMatch(/Wrong backup passphrase/);
  });

  it('drills never use the opt-in, and an unencrypted copy found off-site is refused', async () => {
    const t = new DirTarget(path.join(work, 'b232-disk'));
    await pushBackup(backupDir, t, { retry: quick });
    const name = path.basename(backupDir);
    // Downgrade the copy on the "off-site disk" and re-sign the completion marker (needs no secret).
    const remote = path.join(work, 'b232-disk', name);
    const m = JSON.parse(await readFile(path.join(remote, 'manifest.json'), 'utf8')) as Manifest;
    m.format = 'fleetora-backup-1';
    delete m.mac;
    await writeFile(path.join(remote, 'manifest.json'), JSON.stringify(m));
    const marker = JSON.parse(await readFile(path.join(remote, 'COMPLETE.json'), 'utf8'));
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(await readFile(path.join(remote, 'manifest.json'))).digest('hex');
    marker.objects = marker.objects.map((o: { path: string; bytes: number; sha256: string }) => (o.path === 'manifest.json' ? { ...o, sha256: sha, bytes: Buffer.byteLength(JSON.stringify(m)) } : o));
    marker.manifestSha256 = sha;
    await writeFile(path.join(remote, 'COMPLETE.json'), JSON.stringify(marker));
    const report = await runDrill({ adminDatabaseUrl: process.env.TEST_DATABASE_URL!, passphrase: PASS, target: t, workRoot: work, negative: false });
    expect(report.ok).toBe(false);
    expect(report.steps.find((x) => !x.ok)).toMatchObject({ step: 'verify backup', detail: expect.stringMatching(/not authenticated/) });
    // A planted UNENCRYPTED backup with a valid-looking marker is refused at download.
    const plain = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot: path.join(work, 'b232-plain') });
    const disk2 = path.join(work, 'b232-disk2');
    await cp(plain.dir, path.join(disk2, path.basename(plain.dir)), { recursive: true });
    const objects = [];
    for (const rel of ['manifest.json', 'database.dump', ...plain.manifest.files.map((f) => `files/${f.key}`)]) {
      const b = await readFile(path.join(plain.dir, rel));
      objects.push({ path: rel, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') });
    }
    await writeFile(path.join(disk2, path.basename(plain.dir), 'COMPLETE.json'), JSON.stringify({ format: 'fleetora-offsite-1', backup: path.basename(plain.dir), uploadedAt: new Date().toISOString(), manifestSha256: objects[0]!.sha256, objects }));
    await expect(pullBackup(new DirTarget(disk2), path.basename(plain.dir), path.join(work, 'b232-pulled'), { retry: quick })).rejects.toThrow(/not encrypted: refused/);
  });
});

describe('robustness of the backup tools', () => {
  it('REGRESSION (CI 44129665683): an idle connection ended by the server (57P01) does not crash the process', async () => {
    const pool = toolPool(RUN_DB_URL);
    const pid = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid; // client now idle
    await ctx.pool.query('SELECT pg_terminate_backend($1)', [pid]); // what DROP DATABASE … WITH (FORCE) does
    await new Promise((r) => setTimeout(r, 300));
    expect((await pool.query<{ n: number }>('SELECT 1 AS n')).rows[0]!.n).toBe(1); // a fresh connection is used
    await pool.end();
  });
});

describe('alerts for the manager', () => {
  it('warns until an off-site copy and a restore drill are recorded; failures are shown', async () => {
    const st = async () => (await manager.get('/api/system/status').expect(200)).body.backup;
    expect((await st()).offsite).toMatchObject({ required: true, warning: true, lastOkAt: null });
    expect((await st()).drill).toMatchObject({ warning: true, lastOkAt: null });
    await recordBackupRun(RUN_DB_URL, { startedAt: new Date(), ok: true, encrypted: true, folderName: 'fleetora-backup-20261117-010000-000', manifest, problems: 0, message: null, offsite: { kind: 's3', ok: false, message: 'simulated outage' } });
    expect((await st()).offsite).toMatchObject({ warning: true, last: { ok: false, kind: 's3' } });
    await recordBackupRun(RUN_DB_URL, { startedAt: new Date(), ok: true, encrypted: true, folderName: 'fleetora-backup-20261117-020000-000', manifest, problems: 0, message: null, offsite: { kind: 's3', ok: true, objects: 4, bytes: 1000 } });
    expect((await st()).offsite).toMatchObject({ warning: false, last: { ok: true } });
    await recordDrill(RUN_DB_URL, { startedAt: new Date(), ok: false, source: 'offsite', offsiteKind: 's3', backupName: null, tables: null, rowsTotal: null, filesVerified: null, negativePassed: 0, negativeTotal: 0, message: 'simulated' });
    expect((await st()).drill).toMatchObject({ warning: true, last: { ok: false } });
    await recordDrill(RUN_DB_URL, { startedAt: new Date(), ok: true, source: 'offsite', offsiteKind: 's3', backupName: 'fleetora-backup-20261117-020000-000', tables: 30, rowsTotal: 100, filesVerified: 2, negativePassed: 10, negativeTotal: 10, message: null });
    expect((await st()).drill).toMatchObject({ warning: false, last: { ok: true } });
    await expect(ctx.pool.query('DELETE FROM backup_drills')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('UPDATE backup_runs SET offsite_ok = true')).rejects.toThrow(/append-only/);
  });
});
