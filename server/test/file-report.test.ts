import { mkdtempSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createBackup } from '../src/backup/backup.js';
import { recoverMissingFiles, storedFileReport } from '../src/backup/file-report.js';
import { createUser, CSRF, loginAgent, resetDatabase, RUN_DB_URL, setupTestApp, TEST_STORAGE_DIR, type TestContext } from './helpers.js';

// Issue #16 — missing stored files: classify, explain, recover only identical bytes. Synthetic data only;
// every file here has bytes unique to this test so other tests sharing the storage folder are unaffected.
const PASS = 'synthetic-files-report-pass-0001';
const token = randomBytes(8).toString('hex');
const PDF_A = Buffer.from(`%PDF-1.4\n% fleetora synthetic missing-file test A ${token}\n`);
const PDF_B = Buffer.from(`%PDF-1.4\n% fleetora synthetic damaged-file test B ${token}\n`);
const JPEG_C = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`fleetora synthetic intact photo ${token}`)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const keyOf = (b: Buffer) => `${sha(b).slice(0, 2)}/${sha(b)}`;

let ctx: TestContext;
let manager: TestAgent;
let backupRoot: string;
const GHOST = 'cd'.repeat(32); // a row whose file no backup and no disk holds

/** Row counts and content of every table that holds or references files: must never change. */
async function dbFingerprint() {
  const out: Record<string, string> = {};
  for (const t of ['stored_files', 'customer_documents', 'vehicle_photos']) {
    const r = await ctx.pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  backupRoot = mkdtempSync(path.join(tmpdir(), 'fleetora-files-report-'));
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  const cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  const car = (await manager.post('/api/vehicles').set(CSRF).send({ branchId: cas, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 10 })).body.id;
  const client = (await manager.post('/api/customers').set(CSRF).send({ fullName: 'Client Démo', phone: '0600000001' })).body.customer.id;
  await manager.post(`/api/customers/${client}/documents?kind=passport`).set(CSRF).set('Content-Type', 'application/pdf').send(PDF_A).expect(201);
  await manager.post(`/api/customers/${client}/documents?kind=id_front`).set(CSRF).set('Content-Type', 'application/pdf').send(PDF_B).expect(201);
  await manager.post(`/api/vehicles/${car}/photos`).set(CSRF).set('Content-Type', 'image/jpeg').send(JPEG_C).expect(201);
  await createBackup({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoot, passphrase: PASS });
  // After the backup: A disappears from storage, B is damaged, and a row appears for a file nobody has.
  await rm(path.join(TEST_STORAGE_DIR, keyOf(PDF_A)));
  await writeFile(path.join(TEST_STORAGE_DIR, keyOf(PDF_B)), Buffer.from('damaged bytes'));
  await ctx.pool.query(
    `INSERT INTO stored_files (storage_key, sha256, size_bytes, mime_type, uploaded_by)
     SELECT $1, $2, 10, 'application/pdf', id FROM users LIMIT 1`,
    [`cd/${GHOST}`, GHOST],
  );
});
afterAll(async () => {
  for (const b of [PDF_A, PDF_B, JPEG_C]) await rm(path.join(TEST_STORAGE_DIR, keyOf(b)), { force: true });
  await rm(backupRoot, { recursive: true, force: true });
  await ctx.pool.end();
});

describe('stored-file diagnostic (#16)', () => {
  it('classifies every file and says which records use it — read-only', async () => {
    const before = await dbFingerprint();
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const by = (b: Buffer | string) => r.files.find((f) => f.sha256 === (typeof b === 'string' ? b : sha(b)))!;
    expect(by(JPEG_C)).toMatchObject({ status: 'ok' });
    expect(by(PDF_A)).toMatchObject({ status: 'missing_recoverable', foundIn: [expect.stringMatching(/^fleetora-backup-/)] });
    expect(by(PDF_A).usedBy).toEqual([{ ref: expect.stringMatching(/^customer_documents\./), ids: [expect.any(String)] }]);
    expect(by(PDF_B)).toMatchObject({ status: 'damaged' });
    expect(by(GHOST)).toMatchObject({ status: 'missing_unavailable', foundIn: [], usedBy: [] });
    expect(r.counts).toEqual({ ok: 1, damaged: 1, missing_recoverable: 1, missing_unavailable: 1 });
    // No full path in the printable report (only folder names).
    expect(JSON.stringify(r.files)).not.toContain(backupRoot);
    expect(await dbFingerprint()).toEqual(before);
  });

  it('a wrong passphrase recovers nothing and writes nothing', async () => {
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const res = await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR, passphrase: 'wrong-passphrase-0000' });
    expect(res.recovered).toEqual([]);
    expect(res.failed).toEqual([{ storageKey: keyOf(PDF_A), reason: expect.stringMatching(/Wrong backup passphrase/) }]);
    await expect(readFile(path.join(TEST_STORAGE_DIR, keyOf(PDF_A)))).rejects.toThrow(/ENOENT/);
  });

  it('recovers only the missing file with identical bytes; never overwrites the damaged one; never invents the unavailable one', async () => {
    const before = await dbFingerprint();
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const res = await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR, passphrase: PASS });
    expect(res).toEqual({ recovered: [keyOf(PDF_A)], failed: [], staleTempRemoved: 0 });
    expect(Buffer.compare(await readFile(path.join(TEST_STORAGE_DIR, keyOf(PDF_A))), PDF_A)).toBe(0);
    expect((await readFile(path.join(TEST_STORAGE_DIR, keyOf(PDF_B)))).toString()).toBe('damaged bytes'); // left for a person
    await expect(readFile(path.join(TEST_STORAGE_DIR, `cd/${GHOST}`))).rejects.toThrow(/ENOENT/);
    const after = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    expect(after.counts).toEqual({ ok: 2, damaged: 1, missing_recoverable: 0, missing_unavailable: 1 });
    expect(await dbFingerprint()).toEqual(before); // no row created, changed or deleted
  });

  it('B24-1: a write that fails half-way (disk full) leaves no temporary file, and a retry succeeds', async () => {
    const dir = path.join(TEST_STORAGE_DIR, keyOf(PDF_A).slice(0, 2));
    await rm(path.join(TEST_STORAGE_DIR, keyOf(PDF_A)), { force: true }); // missing again
    const before = await dbFingerprint();
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const failing = await recoverMissingFiles(r, {
      storageDir: TEST_STORAGE_DIR, passphrase: PASS,
      _writeTemp: async (file, bytes) => {
        await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)), { flag: 'wx' }); // partial write…
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); // …then disk full
      },
    });
    expect(failing.recovered).toEqual([]);
    expect(failing.failed[0]).toMatchObject({ storageKey: keyOf(PDF_A), reason: expect.stringMatching(/ENOSPC/) });
    expect((await readdir(dir)).filter((n) => n.includes('.recovering'))).toEqual([]); // nothing left behind
    await expect(readFile(path.join(TEST_STORAGE_DIR, keyOf(PDF_A)))).rejects.toThrow(/ENOENT/);
    const retry = await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR, passphrase: PASS });
    expect(retry.recovered).toEqual([keyOf(PDF_A)]);
    expect(Buffer.compare(await readFile(path.join(TEST_STORAGE_DIR, keyOf(PDF_A))), PDF_A)).toBe(0);
    expect(await dbFingerprint()).toEqual(before);
  });

  it('B24-1: leftovers of an interrupted run (old fixed name or attempt names) no longer block recovery', async () => {
    const key = keyOf(PDF_A);
    const dir = path.join(TEST_STORAGE_DIR, key.slice(0, 2));
    await rm(path.join(TEST_STORAGE_DIR, key), { force: true });
    await writeFile(path.join(TEST_STORAGE_DIR, `${key}.recovering`), 'partial from the old version');
    await writeFile(path.join(TEST_STORAGE_DIR, `${key}.recovering-0123456789abcdef`), 'partial from a killed attempt');
    const longAgo = new Date(Date.now() - 2 * 3600_000); // a real interrupted run is older than the stale age
    await utimes(path.join(TEST_STORAGE_DIR, `${key}.recovering`), longAgo, longAgo);
    await utimes(path.join(TEST_STORAGE_DIR, `${key}.recovering-0123456789abcdef`), longAgo, longAgo);
    await writeFile(path.join(dir, 'unrelated-file.txt'), 'must stay'); // not ours: never touched
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const res = await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR, passphrase: PASS });
    expect(res).toMatchObject({ recovered: [key], failed: [], staleTempRemoved: 2 });
    expect((await readdir(dir)).filter((n) => n.includes('.recovering'))).toEqual([]);
    expect(await readFile(path.join(dir, 'unrelated-file.txt'), 'utf8')).toBe('must stay');
    await rm(path.join(dir, 'unrelated-file.txt'));
  });

  it('B24-1: a file that appears at the final name meanwhile is never overwritten', async () => {
    const key = keyOf(PDF_A);
    await rm(path.join(TEST_STORAGE_DIR, key), { force: true });
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const res = await recoverMissingFiles(r, {
      storageDir: TEST_STORAGE_DIR, passphrase: PASS,
      _writeTemp: async (file, bytes) => {
        await writeFile(file, bytes, { flag: 'wx' });
        await writeFile(path.join(TEST_STORAGE_DIR, key), 'someone else wrote this'); // race: final name appears
      },
    });
    expect(res.recovered).toEqual([]);
    expect(res.failed[0]!.reason).toMatch(/EEXIST/);
    expect(await readFile(path.join(TEST_STORAGE_DIR, key), 'utf8')).toBe('someone else wrote this');
    await rm(path.join(TEST_STORAGE_DIR, key));
    expect((await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR, passphrase: PASS })).recovered).toEqual([key]);
  });

  it('round 2: two simultaneous recoveries of the same file — the second never deletes the first one\'s live temporary file', async () => {
    const key = keyOf(PDF_A);
    await rm(path.join(TEST_STORAGE_DIR, key), { force: true });
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    let releaseA!: () => void;
    const aWritten = new Promise<void>((ok) => { releaseA = ok; });
    let continueA!: () => void;
    const aMayLink = new Promise<void>((ok) => { continueA = ok; });
    // A writes its temporary file, then waits (barrier) before checking and linking it.
    const a = recoverMissingFiles(r, {
      storageDir: TEST_STORAGE_DIR, passphrase: PASS,
      _writeTemp: async (file, bytes) => {
        await writeFile(file, bytes, { flag: 'wx' });
        releaseA();
        await aMayLink;
      },
    });
    await aWritten;
    // B starts while A's temporary file is live; its start-up cleanup must leave A's file alone.
    const b = await recoverMissingFiles(r, {
      storageDir: TEST_STORAGE_DIR, passphrase: PASS,
      _writeTemp: async () => { throw Object.assign(new Error('B stops here (test)'), { code: 'ETEST' }); },
    });
    expect(b.staleTempRemoved).toBe(0);
    continueA();
    const resA = await a;
    expect(resA.recovered).toEqual([key]); // A was not broken by B
    expect(Buffer.compare(await readFile(path.join(TEST_STORAGE_DIR, key)), PDF_A)).toBe(0);
  });

  it('round 2: only temporary files older than the stale age are cleaned (interrupted runs)', async () => {
    const key = keyOf(PDF_A);
    const dir = path.join(TEST_STORAGE_DIR, key.slice(0, 2));
    await rm(path.join(TEST_STORAGE_DIR, key), { force: true });
    const old = path.join(TEST_STORAGE_DIR, `${key}.recovering-aaaaaaaaaaaaaaaa`);
    const fresh = path.join(TEST_STORAGE_DIR, `${key}.recovering-bbbbbbbbbbbbbbbb`);
    await writeFile(old, 'killed two hours ago');
    await writeFile(fresh, 'another attempt, still running');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const res = await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR, passphrase: PASS });
    expect(res).toMatchObject({ recovered: [key], staleTempRemoved: 1 });
    expect((await readdir(dir)).filter((n) => n.includes('.recovering'))).toEqual([path.basename(fresh)]);
    await rm(fresh);
  });

  it('a backup manifest cannot point recovery outside the storage folder or at foreign bytes', async () => {
    const crafted = path.join(backupRoot, 'fleetora-backup-20991231-235959-999');
    await mkdir(path.join(crafted, 'files'), { recursive: true });
    await writeFile(path.join(crafted, 'manifest.json'), JSON.stringify({ files: [{ key: `../../../outside/${GHOST}`, sha256: GHOST, bytes: 10 }, { key: `cd/${GHOST}`, sha256: GHOST, bytes: 10 }] }));
    await writeFile(path.join(crafted, 'files', 'x'), 'not the file');
    const r = await storedFileReport({ databaseUrl: RUN_DB_URL, storageDir: TEST_STORAGE_DIR, backupRoots: [backupRoot] });
    const ghost = r.files.find((f) => f.sha256 === GHOST)!;
    expect(ghost.status).toBe('missing_recoverable'); // the crafted manifest claims to have it…
    const res = await recoverMissingFiles(r, { storageDir: TEST_STORAGE_DIR });
    expect(res.recovered).toEqual([]); // …but there are no bytes with that SHA-256, so nothing is written
    expect(res.failed[0]).toMatchObject({ storageKey: `cd/${GHOST}` });
    await expect(readFile(path.join(TEST_STORAGE_DIR, `cd/${GHOST}`))).rejects.toThrow(/ENOENT/);
    await rm(crafted, { recursive: true, force: true });
  });
});
