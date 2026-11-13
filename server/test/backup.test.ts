import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { checkStoredFiles, createBackup, recordBackupRun, restoreBackup, verifyBackup } from '../src/backup/backup.js';
import { readdirSync, statSync } from 'node:fs';
import { createUser, CSRF, loginAgent, resetDatabase, RUN_DB, RUN_DB_URL, setupTestApp, TEST_STORAGE_DIR, type TestContext } from './helpers.js';

// A real backup → damage → restore drill on synthetic data (TEST_PLAN acceptance 10).
const PDF = Buffer.from('%PDF-1.4\n% fleetora synthetic backup test\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fleetora-backup-photo')]);
const RESTORE_DB = RUN_DB.replace(/_test$/, '_restore_test');
const RESTORE_ENC_DB = RUN_DB.replace(/_test$/, '_renc_test');
const PASS = 'demo-passphrase-for-tests-only';

let ctx: TestContext;
let manager: TestAgent;
let maintenance: pg.Pool;
let backupRoot: string;

beforeAll(async () => {
  ctx = await setupTestApp();
  maintenance = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  backupRoot = mkdtempSync(path.join(tmpdir(), 'fleetora-test-backups-'));
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  const cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  const car = (await manager.post('/api/vehicles').set(CSRF).send({ branchId: cas, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 10, dailyRateCents: 30000 })).body.id;
  const client = (await manager.post('/api/customers').set(CSRF).send({ fullName: 'Client Démo', phone: '0600000001' })).body.customer.id;
  await manager.post(`/api/customers/${client}/documents?kind=passport`).set(CSRF).set('Content-Type', 'application/pdf').send(PDF).expect(201);
  await manager.post(`/api/vehicles/${car}/photos`).set(CSRF).set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
  const d = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const e = new Date(Date.now() + 8 * 86400_000).toISOString().slice(0, 10);
  await manager.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId: car, start: `${d}T10:00`, end: `${e}T10:00` }).expect(201);
});
afterAll(async () => {
  await maintenance.query(`DROP DATABASE IF EXISTS "${RESTORE_DB}" WITH (FORCE)`);
  await maintenance.query(`DROP DATABASE IF EXISTS "${RESTORE_ENC_DB}" WITH (FORCE)`);
  await maintenance.end();
  await ctx.pool.end();
});

describe('backup and restore', () => {
  let dir: string;

  it('backs up the database and every file, with checksums; the backup verifies', async () => {
    const res = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot });
    dir = res.dir;
    expect(res.manifest.problems).toEqual([]);
    expect(res.manifest.tables).toMatchObject({ customers: 1, vehicles: 1, reservations: 1, customer_documents: 1, vehicle_photos: 1, stored_files: 2 });
    expect(res.manifest.files).toHaveLength(2);
    expect(res.manifest.migrations.at(-1)).toBe('0015_intake_document_reviews');
    expect((await verifyBackup(dir)).problems).toEqual([]);
    // No secrets in the manifest.
    expect(await readFile(path.join(dir, 'manifest.json'), 'utf8')).not.toMatch(/password|devpass|postgres:\/\//i);
  });

  it('restores into a NEW empty database and proves it: same rows, same files', async () => {
    await maintenance.query(`CREATE DATABASE "${RESTORE_DB}"`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${RESTORE_DB}`;
    const url = u.toString();
    const storage = mkdtempSync(path.join(tmpdir(), 'fleetora-test-restored-files-'));
    const { problems } = await restoreBackup({ dir, databaseUrl: url, storageDir: storage });
    expect(problems).toEqual([]);
    const restored = new pg.Pool({ connectionString: url, max: 1 });
    try {
      expect((await restored.query('SELECT full_name FROM customers')).rows).toEqual([{ full_name: 'Client Démo' }]);
      expect(await checkStoredFiles(restored, storage)).toEqual([]);
      // Protections come back with the data.
      await expect(restored.query('DELETE FROM customers')).rejects.toThrow(/never deleted/);
    } finally {
      await restored.end();
    }
    // A second restore onto the same (now non-empty) database is refused: nothing is overwritten.
    await expect(restoreBackup({ dir, databaseUrl: url, storageDir: storage })).rejects.toThrow(/not empty/);
  });

  it('a damaged backup is detected and never restored', async () => {
    const { manifest } = await verifyBackup(dir);
    const victim = path.join(dir, 'files', manifest.files[0]!.key);
    const good = await readFile(victim);
    await writeFile(victim, Buffer.concat([good, Buffer.from('x')]));
    try {
      expect((await verifyBackup(dir)).problems.join()).toMatch(/damaged in the backup/);
      await expect(restoreBackup({ dir, databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR })).rejects.toThrow(/not intact/);
    } finally {
      await writeFile(victim, good);
    }
  });

  it('encrypted backup: nothing readable on disk, wrong passphrase refused, restore proven (audit P0)', async () => {
    const { dir, manifest } = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot, passphrase: PASS });
    expect(manifest.encryption).toMatchObject({ algorithm: 'aes-256-gcm', kdf: 'scrypt' });
    expect(manifest.dump.file).toBe('database.dump.enc');
    // No plain content anywhere in the backup folder: neither the customer name nor the scan bytes.
    const all = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? all(path.join(d, n)) : [path.join(d, n)]));
    for (const f of all(dir)) {
      const bytes = await readFile(f);
      expect(bytes.includes(Buffer.from('Client Démo')), f).toBe(false);
      expect(bytes.includes(PDF), f).toBe(false);
    }
    expect((await verifyBackup(dir)).problems.join()).toMatch(/encrypted/);
    expect((await verifyBackup(dir, 'wrong-passphrase-xyz')).problems.join()).toMatch(/Wrong backup passphrase/);
    expect((await verifyBackup(dir, PASS)).problems).toEqual([]);
    await maintenance.query(`CREATE DATABASE "${RESTORE_ENC_DB}"`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${RESTORE_ENC_DB}`;
    const storage = mkdtempSync(path.join(tmpdir(), 'fleetora-test-restored-enc-'));
    expect((await restoreBackup({ dir, databaseUrl: u.toString(), storageDir: storage, passphrase: PASS })).problems).toEqual([]);
    await expect(createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot, passphrase: 'short' })).rejects.toThrow(/12 characters/);
  });

  it('each run is recorded; the manager sees a failed or missing backup', async () => {
    const m = await createUser(ctx.pool, { email: 'sys@example.test', role: 'manager' });
    const agent = await loginAgent(ctx.app, m.email, m.password);
    let st = (await agent.get('/api/system/status').expect(200)).body;
    expect(st.backup).toMatchObject({ last: null, warning: true });
    expect(st.storage).toMatchObject({ persistentConfigured: true, warning: false });
    await recordBackupRun(RUN_DB_URL, { startedAt: new Date(), ok: false, encrypted: true, folderName: null, problems: 1, message: 'disk full' });
    st = (await agent.get('/api/system/status').expect(200)).body;
    expect(st.backup).toMatchObject({ last: { ok: false }, warning: true });
    await recordBackupRun(RUN_DB_URL, { startedAt: new Date(), ok: true, encrypted: true, folderName: 'fleetora-backup-x', problems: 0, message: null });
    st = (await agent.get('/api/system/status').expect(200)).body;
    expect(st.backup).toMatchObject({ last: { ok: true, encrypted: true }, warning: false });
    const e = await createUser(ctx.pool, { email: 'sys-e@example.test', role: 'employee' });
    await (await loginAgent(ctx.app, e.email, e.password)).get('/api/system/status').expect(403);
    await expect(ctx.pool.query('DELETE FROM backup_runs')).rejects.toThrow(/append-only/);
  });

  it('a file missing from storage is reported at backup time and by the live check', async () => {
    await ctx.pool.query(
      `INSERT INTO stored_files (storage_key, sha256, size_bytes, mime_type, uploaded_by)
       SELECT 'ab/' || repeat('ab', 32), repeat('ab', 32), 1, 'image/png', id FROM users LIMIT 1`,
    );
    expect(await checkStoredFiles(ctx.pool, TEST_STORAGE_DIR)).toEqual([`file ab/${'ab'.repeat(32)} is missing`]);
    const res = await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot });
    expect(res.manifest.problems).toEqual([`file ab/${'ab'.repeat(32)} is missing from storage`]);
    expect((await verifyBackup(res.dir)).problems.length).toBe(1);
  });
});
