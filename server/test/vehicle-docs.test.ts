import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { detectType, sanitizeName } from '../src/storage/storage.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, TEST_STORAGE_DIR, type TestContext } from './helpers.js';

// Minimal valid file signatures (synthetic content, no real document).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fleetora-test-jpeg-1')]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fleetora-test-jpeg-2')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);
const PDF = Buffer.from('%PDF-1.4\n% fleetora synthetic test document\n');
const EXE = Buffer.from('MZ\x90\x00 fake executable');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent; // CAS only, no vehicles.documents
let employeeId: string;
let cas: string;
let rak: string;

const addDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function vehicle(branchId: string, plate: string) {
  const res = await manager
    .post('/api/vehicles')
    .set(CSRF)
    .send({ branchId, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 1000 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const upload = (agent: TestAgent, url: string, bytes: Buffer, type: string, name = 'photo.jpg') =>
  agent.post(url).set(CSRF).set('Content-Type', type).set('X-File-Name', encodeURIComponent(name)).send(bytes);

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee' });
  employeeId = e.id;
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  rak = (await manager.post('/api/branches').set(CSRF).send({ code: 'RAK', name: 'Marrakech', city: 'Marrakech' })).body.id;
  await manager.put(`/api/users/${employeeId}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('file checks (unit)', () => {
  it('detects real types from content, not from names', () => {
    expect(detectType(JPEG)).toBe('image/jpeg');
    expect(detectType(PNG)).toBe('image/png');
    expect(detectType(PDF)).toBe('application/pdf');
    expect(detectType(EXE)).toBeNull();
    expect(detectType(HTML)).toBeNull();
  });
  it('keeps only a safe display name', () => {
    expect(sanitizeName(encodeURIComponent('../../etc/passwd'))).toBe('passwd');
    expect(sanitizeName('C:\\Users\\x\\carte grise.pdf')).toBe('carte grise.pdf');
    expect(sanitizeName('')).toBeNull();
  });
});

describe('vehicle identity', () => {
  it('stores the first registration date', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const { mileageKm: _m, ...body } = {
      branchId: cas, plate: '11111-أ-1', make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 0,
    };
    const res = await manager.put(`/api/vehicles/${id}`).set(CSRF).send({ ...body, firstRegistrationDate: '2023-03-15' }).expect(200);
    expect(res.body.firstRegistrationDate).toBe('2023-03-15');
    await manager.put(`/api/vehicles/${id}`).set(CSRF).send({ ...body, firstRegistrationDate: '15/03/2023' }).expect(400);
  });
});

describe('vehicle documents', () => {
  it('manager adds insurance with expiry; status is computed (valid / expiring / expired) and shown on the fleet', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const ins = await manager
      .post(`/api/vehicles/${id}/documents`)
      .set(CSRF)
      .send({ docType: 'insurance', number: 'POL-123', issuer: 'Assureur Démo', issueDate: addDays(-300), expiryDate: addDays(65) })
      .expect(201);
    expect(ins.body).toMatchObject({ docType: 'insurance', status: 'valid', number: 'POL-123' });
    const vt = await manager
      .post(`/api/vehicles/${id}/documents`)
      .set(CSRF)
      .send({ docType: 'technical_inspection', expiryDate: addDays(10) })
      .expect(201);
    expect(vt.body.status).toBe('expiring');
    expect(vt.body.daysLeft).toBeGreaterThanOrEqual(9);
    let list = await manager.get('/api/vehicles').expect(200);
    expect(list.body.items[0].documentAlert).toBe('expiring');
    await manager.post(`/api/vehicles/${id}/documents`).set(CSRF).send({ docType: 'vignette', expiryDate: addDays(-2) }).expect(201);
    list = await manager.get('/api/vehicles').expect(200);
    expect(list.body.items[0].documentAlert).toBe('expired');
    const summary = await manager.get('/api/vehicles/summary').expect(200);
    expect(summary.body.documents).toEqual({ expired: 1, expiring: 1 });
    expect(await auditRows(ctx.pool, 'vehicle.document_create')).toHaveLength(3);

    // "Documents to renew" filter: only vehicles with an expired / soon-expiring document.
    const calm = await vehicle(cas, '11112-أ-1');
    await manager.post(`/api/vehicles/${calm}/documents`).set(CSRF).send({ docType: 'insurance', expiryDate: addDays(200) }).expect(201);
    const all = await manager.get('/api/vehicles').expect(200);
    expect(all.body.items).toHaveLength(2);
    const alert = await manager.get('/api/vehicles?docs=alert').expect(200);
    expect(alert.body.items.map((v: { id: string }) => v.id)).toEqual([id]);
    await manager.get('/api/vehicles?docs=nope').expect(400);
  });

  it('validates documents (type, dates, name for "other")', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const post = (b: object) => manager.post(`/api/vehicles/${id}/documents`).set(CSRF).send(b);
    await post({ docType: 'passport' }).expect(400);
    await post({ docType: 'insurance', issueDate: '2026-05-01', expiryDate: '2026-04-01' }).expect(400);
    await post({ docType: 'insurance', expiryDate: '01/05/2026' }).expect(400);
    await post({ docType: 'other' }).expect(400);
    await post({ docType: 'other', label: 'Carte W' }).expect(201);
  });

  it('archiving keeps history and needs a reason; archived documents cannot be edited', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const doc = (await manager.post(`/api/vehicles/${id}/documents`).set(CSRF).send({ docType: 'insurance', expiryDate: addDays(-1) })).body;
    await manager.post(`/api/vehicles/${id}/documents/${doc.id}/archive`).set(CSRF).send({}).expect(400);
    await manager.post(`/api/vehicles/${id}/documents/${doc.id}/archive`).set(CSRF).send({ reason: 'Renouvelée' }).expect(204);
    const active = await manager.get(`/api/vehicles/${id}/documents`).expect(200);
    expect(active.body.items).toHaveLength(0);
    const all = await manager.get(`/api/vehicles/${id}/documents?includeArchived=true`).expect(200);
    expect(all.body.items[0].status).toBe('archived');
    await manager.put(`/api/vehicles/${id}/documents/${doc.id}`).set(CSRF).send({ docType: 'insurance' }).expect(409);
    const list = await manager.get('/api/vehicles').expect(200);
    expect(list.body.items[0].documentAlert).toBeNull();
  });

  it('attaches a scanned PDF or photo to a document; replacing keeps the earlier file stored', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const doc = (await manager.post(`/api/vehicles/${id}/documents`).set(CSRF).send({ docType: 'registration', number: 'CG-1' })).body;
    const put = (bytes: Buffer, type: string) =>
      manager.put(`/api/vehicles/${id}/documents/${doc.id}/file`).set(CSRF).set('Content-Type', type).set('X-File-Name', 'carte-grise.pdf').send(bytes);
    const first = await put(PDF, 'application/pdf').expect(200);
    expect(first.body.file).toMatchObject({ mimeType: 'application/pdf', name: 'carte-grise.pdf' });
    const dl = await manager.get(`/api/vehicles/${id}/files/${first.body.file.id}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0); // original bytes unchanged
    await put(PNG, 'image/png').expect(200);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM stored_files');
    expect(rows[0].n).toBe(2); // the earlier scan is still stored (history)
  });
});


describe('independent vehicle document OCR review', () => {
  it('requires manager approval, does not edit the vehicle, and invalidates approval on scan replacement', async () => {
    const id = await vehicle(cas,'44441-أ-1');
    const doc = (await manager.post(`/api/vehicles/${id}/documents`).set(CSRF)
      .send({docType:'registration',number:'REF-0'}).expect(201)).body;
    const filePath = `/api/vehicles/${id}/documents/${doc.id}/file`;
    const first = (await manager.put(filePath).set(CSRF)
      .set('Content-Type','application/pdf').send(PDF).expect(200)).body.file.id;
    const base = `/api/vehicles/${id}/documents/${doc.id}`;
    await employee.put(`${base}/review`).set(CSRF).send({
      status:'approved',fields:{plateNumber:'44441-أ-1'},expectedRevision:0,
    }).expect(403);
    await manager.post(`${base}/analyze`).set(CSRF).expect(503);
    await manager.put(`${base}/review`).set(CSRF).send({
      status:'approved',fields:{plateNumber:'44441-أ-1'},expectedRevision:0,
    }).expect(200).then(r=>expect(r.body.revision).toBe(1));
    const rows=(await manager.get(`/api/vehicles/${id}/documents`).expect(200)).body.items;
    expect(rows[0]).toMatchObject({number:'REF-0',review:{status:'approved',revision:1,fields:{plateNumber:'44441-أ-1'}}});
    await manager.put(`${base}/review`).set(CSRF).send({
      status:'approved',fields:{plateNumber:'wrong'},expectedRevision:0,
    }).expect(409);
    const replacement=(await manager.put(filePath).set(CSRF)
      .set('Content-Type','image/jpeg').send(JPEG2).expect(200)).body.file.id;
    expect(replacement).not.toBe(first);
    const current=(await manager.get(`/api/vehicles/${id}/documents`).expect(200)).body.items[0];
    expect(current.review).toBeNull();
    expect(current.number).toBe('REF-0');
    await manager.put(`${base}/review`).set(CSRF).send({
      status:'rejected',fields:{},expectedRevision:0,
    }).expect(200).then(r=>expect(r.body.revision).toBe(1));
    expect((await manager.get(`/api/vehicles/${id}`).expect(200)).body.vehicle.plate).toBe('44441-أ-1');
  });
});

describe('vehicle photos', () => {
  it('uploads several photos; the same photo sent twice (network retry) is not duplicated', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    await upload(manager, `/api/vehicles/${id}/photos`, JPEG, 'image/jpeg').expect(201);
    await upload(manager, `/api/vehicles/${id}/photos`, PNG, 'image/png', 'arriere.png').expect(201);
    const retry = await upload(manager, `/api/vehicles/${id}/photos`, JPEG, 'image/jpeg').expect(200);
    expect(retry.body.duplicate).toBe(true);
    const list = await manager.get(`/api/vehicles/${id}/photos`).expect(200);
    expect(list.body.items).toHaveLength(2);
    // Files are stored under random content keys, never under the client's name.
    const dirs = await readdir(TEST_STORAGE_DIR, { recursive: true });
    expect(dirs.some((d) => String(d).includes('arriere'))).toBe(false);
  });

  it('rejects unsupported, spoofed, empty and oversized files', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const url = `/api/vehicles/${id}/photos`;
    expect((await upload(manager, url, EXE, 'image/jpeg', 'virus.jpg')).status).toBe(415);
    expect((await upload(manager, url, HTML, 'image/png', 'x.png')).status).toBe(415);
    expect((await upload(manager, url, PDF, 'application/pdf', 'doc.pdf')).status).toBe(415); // photos are images only
    expect((await upload(manager, url, JPEG, 'image/png', 'x.png')).body.error.code).toBe('type_mismatch');
    expect((await upload(manager, url, Buffer.alloc(0), 'image/jpeg')).status).toBe(400);
    const small = await setupTestApp({ MAX_UPLOAD_MB: '1' });
    try {
      const m2 = await createUser(small.pool, { email: 'm2@example.test', role: 'manager' });
      const a2 = await loginAgent(small.app, m2.email, m2.password);
      const b = (await a2.post('/api/branches').set(CSRF).send({ code: 'TST', name: 'T', city: 'T' })).body.id;
      const v = (await a2.post('/api/vehicles').set(CSRF).send({ branchId: b, plate: '22222-ب-2', make: 'A', model: 'B', fuelType: 'diesel', transmission: 'manual' })).body.id;
      const big = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024 + 10)]);
      expect((await upload(a2, `/api/vehicles/${v}/photos`, big, 'image/jpeg')).status).toBe(413);
    } finally {
      await small.pool.end();
    }
  });

  it('archived photos disappear from the gallery but stay downloadable for history', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    const p = (await upload(manager, `/api/vehicles/${id}/photos`, JPEG, 'image/jpeg')).body;
    await manager.post(`/api/vehicles/${id}/photos/${p.id}/archive`).set(CSRF).send({}).expect(204);
    expect((await manager.get(`/api/vehicles/${id}/photos`)).body.items).toHaveLength(0);
    await manager.get(`/api/vehicles/${id}/files/${p.fileId}`).expect(200);
    await expect(ctx.pool.query('DELETE FROM stored_files')).rejects.toThrow(/never deleted/);
  });
});

describe('permissions and branch scope for documents and files', () => {
  it('employees see documents/photos of their branch but cannot add without the delegated right', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    await manager.post(`/api/vehicles/${id}/documents`).set(CSRF).send({ docType: 'insurance', expiryDate: addDays(100) }).expect(201);
    await employee.get(`/api/vehicles/${id}/documents`).expect(200);
    await employee.post(`/api/vehicles/${id}/documents`).set(CSRF).send({ docType: 'vignette' }).expect(403);
    await upload(employee, `/api/vehicles/${id}/photos`, JPEG, 'image/jpeg').expect(403);
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.documents'] }).expect(204);
    await upload(employee, `/api/vehicles/${id}/photos`, JPEG, 'image/jpeg').expect(201);
  });

  it('REVIEW CASE: files of another branch, or files not linked to the vehicle, are never served', async () => {
    const mine = await vehicle(cas, '11111-أ-1');
    const other = await vehicle(rak, '22222-ب-2');
    const otherPhoto = (await upload(manager, `/api/vehicles/${other}/photos`, JPEG2, 'image/jpeg')).body;
    await employee.get(`/api/vehicles/${other}/files/${otherPhoto.fileId}`).expect(404);
    await employee.get(`/api/vehicles/${other}/documents`).expect(404);
    // Asking for the other branch's file through a vehicle the employee CAN see: not linked, refused.
    await employee.get(`/api/vehicles/${mine}/files/${otherPhoto.fileId}`).expect(404);
    await request(ctx.app).get(`/api/vehicles/${other}/files/${otherPhoto.fileId}`).expect(401);
  });

  it('a retired vehicle accepts no new documents or photos', async () => {
    const id = await vehicle(cas, '11111-أ-1');
    await manager.post(`/api/vehicles/${id}/transitions`).set(CSRF).send({ to: 'out_of_service', expectedStatus: 'inspection_pending', reason: 'Vendue' }).expect(200);
    await manager.post(`/api/vehicles/${id}/transitions`).set(CSRF).send({ to: 'retired', expectedStatus: 'out_of_service', reason: 'Vendue' }).expect(200);
    await manager.post(`/api/vehicles/${id}/documents`).set(CSRF).send({ docType: 'insurance' }).expect(409);
    await upload(manager, `/api/vehicles/${id}/photos`, JPEG, 'image/jpeg').expect(409);
  });
});
