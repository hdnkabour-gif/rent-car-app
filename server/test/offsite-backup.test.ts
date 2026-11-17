import { mkdtempSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createBackup, recordBackupRun, recordDrill, toolPool, verifyBackup, type Manifest } from '../src/backup/backup.js';
import { checkBackupLocations } from '../src/backup/locations.js';
import { DirTarget, listOffsite, offsiteFromEnv, pullBackup, pushBackup, removeOffsiteBackup, S3Target } from '../src/backup/offsite.js';
import { planRetention } from '../src/backup/retention.js';
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
    expect(await alter('plain', (m) => delete m.encryption)).toMatch(/manifest was altered|damaged|unreadable/);
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
