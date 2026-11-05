import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { docNumberKey, phoneKey, phoneSearchKeys } from '../src/domain/customers.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

// Synthetic people only (fictitious names, 0600-000-xxx numbers, made-up document numbers).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fleetora-test-cin-front')]);
const PDF = Buffer.from('%PDF-1.4\n% fleetora synthetic passport scan\n');

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;

const addDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

const resident = {
  fullName: 'Client Démo Résident',
  phone: '06 00 00 01 01',
  idDocType: 'cin',
  idDocNumber: 'ZZ 999001',
  idDocExpiry: addDays(900),
  licenceNumber: 'DEMO-PERMIS-1',
  licenceCategory: 'B',
  licenceExpiry: addDays(2000),
  city: 'Casablanca',
};
const tourist = {
  fullName: 'Demo Tourist',
  phone: '+33 6 00 00 02 02',
  residence: 'abroad_foreign',
  nationality: 'Française',
  country: 'France',
  preferredLanguage: 'fr',
  idDocType: 'passport',
  idDocNumber: 'XX0000001',
  idDocCountry: 'France',
};

async function create(agent: TestAgent, body: Record<string, unknown>, status = 201) {
  const res = await agent.post('/api/customers').set(CSRF).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
}
const upload = (agent: TestAgent, id: string, kind: string, bytes: Buffer, type: string) =>
  agent.post(`/api/customers/${id}/documents?kind=${kind}`).set(CSRF).set('Content-Type', type).set('X-File-Name', 'scan').send(bytes);

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  employee = await loginAgent(ctx.app, e.email, e.password);
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('phone and document keys (unit)', () => {
  it('normalises Moroccan and international numbers to wa.me digits', () => {
    expect(phoneKey('06 12 34 56 78')).toBe('212612345678');
    expect(phoneKey('0612-345-678')).toBe('212612345678');
    expect(phoneKey('٠٦١٢٣٤٥٦٧٨')).toBe('212612345678');
    expect(phoneKey('+212 6 12 34 56 78')).toBe('212612345678');
    expect(phoneKey('00212612345678')).toBe('212612345678');
    expect(phoneKey('+33 6 12 34 56 78')).toBe('33612345678');
    expect(phoneKey('0033612345678')).toBe('33612345678');
    expect(phoneKey('abc')).toBeNull();
    expect(phoneSearchKeys('0612')).toEqual(['0612', '212612']);
    expect(phoneSearchKeys('12')).toEqual([]);
    expect(phoneSearchKeys('ZZ 1234')).toEqual([]);
  });
  it('compares document numbers without spaces, dashes or case', () => {
    expect(docNumberKey('zz 999-001')).toBe('ZZ999001');
    expect(docNumberKey('-')).toBeNull();
  });
});

describe('customers', () => {
  it('requires a session and the right permission', async () => {
    await request(ctx.app).get('/api/customers').expect(401);
  });

  it('employee adds a resident (CIN) and a tourist (passport); details and expiry status are returned', async () => {
    const a = (await create(employee, resident)).customer;
    expect(a).toMatchObject({ fullName: resident.fullName, phone: '06 00 00 01 01', phoneKey: '212600000101', idDocType: 'cin', idDocNumber: 'ZZ 999001', residence: 'morocco', idDocStatus: 'valid', licenceStatus: 'valid', blocked: null });
    const b = (await create(employee, tourist)).customer;
    expect(b).toMatchObject({ residence: 'abroad_foreign', idDocType: 'passport', phoneKey: '33600000202', idDocStatus: null });
    const audit = await auditRows(ctx.pool, 'customer.create');
    expect(audit).toHaveLength(2);
    // Identity numbers and phones never go into the audit log.
    expect(JSON.stringify(audit.map((r) => r.metadata))).not.toMatch(/ZZ|999001|XX0000001|0600|212600/);
  });

  it('validates phone, document type, ICE and e-mail', async () => {
    await create(employee, { ...resident, phone: 'pas de numéro' }, 400);
    await create(employee, { ...resident, idDocType: null }, 400);
    await create(employee, { ...resident, companyIce: '001234567000089' }, 400); // individual
    await create(employee, { ...resident, customerType: 'company', fullName: 'Société Démo SARL', companyIce: '12345' }, 400);
    await create(employee, { ...resident, email: 'not-an-email' }, 400);
    await create(employee, { ...resident, licenceIssueDate: addDays(10), licenceExpiry: addDays(5) }, 400);
    const co = (await create(employee, { ...resident, customerType: 'company', fullName: 'Société Démo SARL', companyIce: '001234567000089', contactPerson: 'Contact Démo', phone: '0522000000', idDocNumber: null, idDocType: null, licenceNumber: null }))
      .customer;
    expect(co).toMatchObject({ customerType: 'company', companyIce: '001234567000089' });
  });

  it('warns about a possible duplicate (same phone typed differently, same passport) and never merges', async () => {
    const first = (await create(employee, resident)).customer;
    const dup = await create(employee, { ...resident, fullName: 'Autre Personne', phone: '+212600000101', idDocNumber: 'AB1' }, 409);
    expect(dup.error.code).toBe('possible_duplicate');
    expect(dup.error.details.matches).toEqual([{ id: first.id, fullName: resident.fullName, phone: resident.phone, reasons: ['phone', 'licence'] }]);
    const byDoc = await create(employee, { ...resident, fullName: 'Autre', phone: '0600009999', idDocNumber: 'zz-999 001', licenceNumber: null }, 409);
    expect(byDoc.error.details.matches[0].reasons).toEqual(['id_document']);
    // Staff confirm it is another person: both records exist.
    await create(employee, { ...resident, fullName: 'Autre Personne', phone: '+212600000101', idDocNumber: 'AB1', licenceNumber: null, acknowledgeDuplicates: true });
    expect((await employee.get('/api/customers').expect(200)).body.items).toHaveLength(2);
    const audit = await auditRows(ctx.pool, 'customer.create');
    expect(audit[1].metadata.duplicateWarningAcknowledged).toEqual([first.id]);
  });

  it('searches by name, part of the phone (any format) and document number', async () => {
    await create(employee, resident);
    await create(employee, tourist);
    const names = async (q: string) =>
      (await employee.get(`/api/customers?q=${encodeURIComponent(q)}`).expect(200)).body.items.map((c: { fullName: string }) => c.fullName);
    expect(await names('résident')).toEqual([resident.fullName]);
    expect(await names('0600000101')).toEqual([resident.fullName]);
    expect(await names('+212 600 000 101')).toEqual([resident.fullName]);
    expect(await names('0101')).toEqual([resident.fullName]);
    expect(await names('xx000')).toEqual([tourist.fullName]);
    expect(await names('100%_')).toEqual([]);
  });

  it('edits a customer; the audit keeps field names only', async () => {
    const c = (await create(employee, resident)).customer;
    const res = await employee.put(`/api/customers/${c.id}`).set(CSRF).send({ ...resident, idDocNumber: 'ZZ 999002', city: 'Rabat' }).expect(200);
    expect(res.body.customer).toMatchObject({ idDocNumber: 'ZZ 999002', city: 'Rabat' });
    const [audit] = await auditRows(ctx.pool, 'customer.update');
    expect(audit.metadata.changedFields.sort()).toEqual(['city', 'idDocNumber']);
    expect(JSON.stringify(audit.metadata)).not.toMatch(/999002|Rabat/);
  });

  it('only a manager (or a delegated employee) marks "do not rent", with a reason; lifting it is audited', async () => {
    const c = (await create(employee, resident)).customer;
    await employee.post(`/api/customers/${c.id}/block`).set(CSRF).send({ reason: 'Impayé' }).expect(403);
    await manager.post(`/api/customers/${c.id}/block`).set(CSRF).send({ reason: '' }).expect(400);
    const b = await manager.post(`/api/customers/${c.id}/block`).set(CSRF).send({ reason: 'Impayé démo' }).expect(200);
    expect(b.body.customer.blocked).toMatchObject({ reason: 'Impayé démo', by: 'Test manager' });
    expect((await employee.get('/api/customers?filter=blocked').expect(200)).body.items).toHaveLength(1);
    await manager.post(`/api/customers/${c.id}/block`).set(CSRF).send({ reason: 'encore' }).expect(409);
    await manager.post(`/api/customers/${c.id}/unblock`).set(CSRF).send({ reason: 'Réglé' }).expect(200);
    expect((await auditRows(ctx.pool, 'customer.unblock'))[0].metadata).toMatchObject({ reason: 'Réglé', previousReason: 'Impayé démo' });
  });

  it('flags expired identity documents or licences', async () => {
    await create(employee, { ...resident, licenceExpiry: addDays(-1) });
    await create(employee, { ...tourist, idDocExpiry: addDays(20) });
    const expired = (await employee.get('/api/customers?filter=expired_documents').expect(200)).body.items;
    expect(expired).toHaveLength(1);
    expect(expired[0].licenceStatus).toBe('expired');
    const all = (await employee.get('/api/customers').expect(200)).body.items;
    expect(all.find((c: { fullName: string }) => c.fullName === tourist.fullName).idDocStatus).toBe('expiring');
  });
});

describe('customer document scans', () => {
  it('employee attaches scans (pending review); a manager verifies or rejects with a reason', async () => {
    const c = (await create(employee, resident)).customer;
    const up = await upload(employee, c.id, 'id_front', JPEG, 'image/jpeg').expect(201);
    expect(up.body).toMatchObject({ kind: 'id_front', reviewStatus: 'pending', duplicate: false, alsoLinkedTo: [] });
    // Retry of the same scan does not duplicate it.
    expect((await upload(employee, c.id, 'id_front', JPEG, 'image/jpeg').expect(200)).body.duplicate).toBe(true);
    await upload(employee, c.id, 'passport', Buffer.from('<html></html>'), 'text/html').expect(415);
    await upload(employee, c.id, 'nope', JPEG, 'image/jpeg').expect(400);

    await employee.post(`/api/customers/${c.id}/documents/${up.body.id}/review`).set(CSRF).send({ status: 'verified' }).expect(403);
    await manager.post(`/api/customers/${c.id}/documents/${up.body.id}/review`).set(CSRF).send({ status: 'rejected' }).expect(400);
    const v = await manager.post(`/api/customers/${c.id}/documents/${up.body.id}/review`).set(CSRF).send({ status: 'verified' }).expect(200);
    expect(v.body).toMatchObject({ reviewStatus: 'verified', reviewedBy: 'Test manager' });

    const detail = (await employee.get(`/api/customers/${c.id}`).expect(200)).body.customer;
    expect(detail).toMatchObject({ documentCount: 1, pendingDocuments: 0 });
    const file = await employee.get(`/api/customers/${c.id}/files/${up.body.file.id}`).expect(200);
    expect(Buffer.compare(file.body, JPEG)).toBe(0);
    expect(file.headers['cache-control']).toBe('private, no-store');
  });

  it('REVIEW CASE: the same scan on another customer is flagged; files are only served for their own customer', async () => {
    const a = (await create(employee, resident)).customer;
    const b = (await create(employee, tourist)).customer;
    const up = await upload(employee, a.id, 'passport', PDF, 'application/pdf').expect(201);
    const again = await upload(employee, b.id, 'passport', PDF, 'application/pdf').expect(201);
    expect(again.body.alsoLinkedTo).toEqual([{ id: a.id, fullName: resident.fullName }]);
    const c = (await create(employee, { ...resident, fullName: 'Troisième', phone: '0600000303', idDocNumber: 'QQ1', licenceNumber: null })).customer;
    await employee.get(`/api/customers/${c.id}/files/${up.body.file.id}`).expect(404);
    // Vehicle routes never serve customer scans.
    await employee.get(`/api/vehicles/${a.id}/files/${up.body.file.id}`).expect(404);
  });

  it('archives a scan with a reason; the summary counts pending reviews', async () => {
    const c = (await create(employee, resident)).customer;
    const up = await upload(employee, c.id, 'licence_front', JPEG, 'image/jpeg').expect(201);
    expect((await employee.get('/api/customers/summary').expect(200)).body).toEqual({ total: 1, blocked: 0, pendingDocuments: 1 });
    expect((await employee.get('/api/customers?filter=pending_documents').expect(200)).body.items).toHaveLength(1);
    await employee.post(`/api/customers/${c.id}/documents/${up.body.id}/archive`).set(CSRF).send({}).expect(400);
    await employee.post(`/api/customers/${c.id}/documents/${up.body.id}/archive`).set(CSRF).send({ reason: 'Mauvaise photo' }).expect(204);
    expect((await employee.get(`/api/customers/${c.id}/documents`).expect(200)).body.items).toHaveLength(0);
    expect((await employee.get(`/api/customers/${c.id}/documents?includeArchived=true`).expect(200)).body.items).toHaveLength(1);
    // Archived originals stay downloadable for history.
    await employee.get(`/api/customers/${c.id}/files/${up.body.file.id}`).expect(200);
  });
});
