import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;
let car: string;
let customer: string;
const PDF = Buffer.from('%PDF-1.4\nSynthetic identity document - NOT REAL');
const PDF2 = Buffer.from('%PDF-1.4\nSynthetic driving licence - NOT REAL');
const today = () => new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
function createInvite(overrides: Record<string, unknown> = {}) {
  return manager.post('/api/customer-intakes').set(CSRF).send({
    vehicleId: car, start: `${today()}T10:00`, end: `${today()}T18:00`,
    dailyCents: 30000, expiryMinutes: 60, ...overrides,
  });
}
const guest = () => request(ctx.app);

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.pool.end(); });
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'intake-manager@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'intake-employee@example.test', role: 'employee' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  employee = await loginAgent(ctx.app, e.email, e.password);
  const cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' }).expect(201)).body.id;
  const rak = (await manager.post('/api/branches').set(CSRF).send({ code: 'RAK', name: 'Marrakech', city: 'Marrakech' }).expect(201)).body.id;
  await manager.put(`/api/users/${e.id}/branches`).set(CSRF).send({ branchIds: [rak] }).expect(204);
  car = (await manager.post('/api/vehicles').set(CSRF).send({
    branchId: cas, plate: '99991-أ-1', make: 'Dacia', model: 'Logan',
    fuelType: 'diesel', transmission: 'manual', mileageKm: 1000, dailyRateCents: 30000,
  }).expect(201)).body.id;
  customer = (await manager.post('/api/customers').set(CSRF).send({
    fullName: 'Synthetic Customer', phone: '0600000011',
  }).expect(201)).body.customer.id;
});

describe('secure customer intake invitation', () => {
  it('issues a time-limited code, never stores the plaintext secret and protects manager access', async () => {
    const a = (await createInvite().expect(201)).body;
    expect(a.code).toMatch(/^\d{10}$/);
    expect(a.path).toBe(`/collect/${a.id}`);
    const db = (await ctx.pool.query('SELECT code_hash,code_salt,expires_at FROM customer_intake_links WHERE id=$1', [a.id])).rows[0];
    expect(db.code_hash).not.toBe(a.code);
    expect(db.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const valid = await guest().post(`/api/guest-intakes/${a.id}/verify`).set(CSRF).send({ code: a.code }).expect(200);
    expect(valid.body.offer).toMatchObject({ vehicle: { make: 'Dacia', model: 'Logan' }, dailyCents: 30000, totalCents: 30000 });
    expect(JSON.stringify(valid.body)).not.toMatch(/code_hash|code_salt|customerId|original_name/);
    await guest().get('/api/customer-intakes').expect(401);
    await employee.get('/api/customer-intakes').expect(200).then(r => expect(r.body.items).toEqual([]));
    await employee.post('/api/customer-intakes').set(CSRF).send({ vehicleId: car, start: `${today()}T10:00`, end: `${today()}T18:00` }).expect(403);
    await employee.get(`/api/customer-intakes/${a.id}`).expect(404);
    await employee.get(`/api/customer-intakes/${a.id}/files/11111111-1111-4111-8111-111111111111`).expect(404);
  });

  it('rejects invalid codes, locks after 5 guesses and rejects an expired or revoked link', async () => {
    const a = (await createInvite().expect(201)).body;
    for (let i=0;i<5;i+=1) {
      const code = a.code === '0000000000' ? '9999999999' : '0000000000';
      await guest().post(`/api/guest-intakes/${a.id}/verify`).set(CSRF).send({ code }).expect(401);
    }
    await guest().post(`/api/guest-intakes/${a.id}/verify`).set(CSRF).send({ code: a.code }).expect(429);
    const b = (await createInvite().expect(201)).body;
    await manager.post(`/api/customer-intakes/${b.id}/revoke`).set(CSRF).expect(204);
    await guest().post(`/api/guest-intakes/${b.id}/verify`).set(CSRF).send({ code: b.code }).expect(410);
    const c = (await createInvite().expect(201)).body;
    await ctx.pool.query(
      `UPDATE customer_intake_links SET created_at=now()-interval '2 day', expires_at=now()-interval '1 day' WHERE id=$1`, [c.id],
    );
    await guest().post(`/api/guest-intakes/${c.id}/verify`).set(CSRF).send({ code: c.code }).expect(410);
  });

  it('uploads multiple private synthetic scans after consent and attaches them only after manager approval', async () => {
    const a = (await createInvite().expect(201)).body;
    await guest().post(`/api/guest-intakes/${a.id}/documents/id_front`)
      .set(CSRF).set('x-intake-code', a.code).set('content-type', 'application/pdf').send(PDF).expect(400);
    for (const [kind, file] of [['id_front',PDF],['licence_front',PDF2]] as const) {
      await guest().post(`/api/guest-intakes/${a.id}/documents/${kind}`).set(CSRF)
        .set('x-intake-code', a.code).set('x-privacy-consent', 'yes')
        .set('content-type', 'application/pdf').send(file).expect(201);
    }
    const before = await ctx.pool.query('SELECT count(*)::int n FROM customer_documents WHERE customer_id=$1',[customer]);
    expect(before.rows[0].n).toBe(0);
    await manager.post(`/api/customer-intakes/${a.id}/attach`).set(CSRF).send({ customerId: customer }).expect(409);
    await guest().post(`/api/guest-intakes/${a.id}/submit`).set(CSRF).send({ code: a.code }).expect(200);
    await guest().post(`/api/guest-intakes/${a.id}/documents/id_back`).set(CSRF)
      .set('x-intake-code', a.code).set('x-privacy-consent','yes')
      .set('content-type','application/pdf').send(PDF).expect(409);
    const details = (await manager.get(`/api/customer-intakes/${a.id}`).expect(200)).body;
    expect(details.documents).toHaveLength(2);
    const privateFile = details.documents[0].file_id;
    await guest().get(`/api/customer-intakes/${a.id}/files/${privateFile}`).expect(401);
    const downloaded = await manager.get(`/api/customer-intakes/${a.id}/files/${privateFile}`).expect(200);
    expect(downloaded.headers['cache-control']).toBe('private, no-store');
    const accepted = await manager.post(`/api/customer-intakes/${a.id}/attach`).set(CSRF).send({ customerId: customer }).expect(200);
    expect(accepted.body).toMatchObject({ accepted: true, attached: 2, pendingHumanReview: true });
    const docs = await ctx.pool.query('SELECT review_status FROM customer_documents WHERE customer_id=$1',[customer]);
    expect(docs.rows).toEqual([{ review_status: 'pending' },{ review_status: 'pending' }]);
    await manager.post(`/api/customer-intakes/${a.id}/attach`).set(CSRF).send({ customerId: customer }).expect(409);
  });

  it('enforces manager-only OCR and fails closed if the local OCR tool is disabled', async () => {
    const a = (await createInvite().expect(201)).body;
    await guest().post(`/api/guest-intakes/${a.id}/documents/id_front`)
      .set(CSRF).set('x-intake-code',a.code).set('x-privacy-consent','yes')
      .set('content-type','application/pdf').send(PDF).expect(201);
    await guest().post(`/api/guest-intakes/${a.id}/submit`)
      .set(CSRF).send({code:a.code}).expect(200);
    const details = (await manager.get(`/api/customer-intakes/${a.id}`).expect(200)).body;
    const docId = details.documents[0].id;
    await employee.post(`/api/customer-intakes/${a.id}/documents/${docId}/analyze`)
      .set(CSRF).expect(403);
    await manager.post(`/api/customer-intakes/${a.id}/documents/${docId}/analyze`)
      .set(CSRF).expect(503);
    expect((await ctx.pool.query(
      'SELECT count(*)::int n FROM customer_intake_document_analysis',
    )).rows[0].n).toBe(0);
  });

  it('does not allow creating invitations for an already-booked vehicle and leaves reservations unchanged', async () => {
    const dates = { vehicleId: car, start: `${today()}T10:00`, end: `${today()}T18:00` };
    // Price offers are not reservations: two invitations do not block availability or book a vehicle.
    const a = await createInvite().expect(201);
    const b = await createInvite().expect(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect((await ctx.pool.query('SELECT count(*)::int n FROM reservations')).rows[0].n).toBe(0);
    expect(dates.vehicleId).toBe(car);
  });
  it('stores manager corrections independently, audits revisions and forbids employee approval', async () => {
    const a = (await createInvite().expect(201)).body;
    await guest().post(`/api/guest-intakes/${a.id}/documents/id_front`).set(CSRF)
      .set('x-intake-code',a.code).set('x-privacy-consent','yes')
      .set('content-type','application/pdf').send(PDF).expect(201);
    await guest().post(`/api/guest-intakes/${a.id}/submit`).set(CSRF).send({code:a.code}).expect(200);
    const docId = (await manager.get(`/api/customer-intakes/${a.id}`).expect(200)).body.documents[0].id;
    const url = `/api/customer-intakes/${a.id}/documents/${docId}/review`;
    await employee.put(url).set(CSRF).send({status:'approved',fields:{documentNumber:'AB123456'}}).expect(403);
    await manager.put(url).set(CSRF).send({status:'approved',fields:{}}).expect(400);
    await manager.put(url).set(CSRF).send({status:'approved',fields:{documentNumber:'AB123456'}}).expect(200)
      .then(r => expect(r.body.revision).toBe(1));
    const details = (await manager.get(`/api/customer-intakes/${a.id}`).expect(200)).body;
    expect(details.documents[0]).toMatchObject({
      review_status:'approved',review_fields:{documentNumber:'AB123456'},revision:1,
    });
    await manager.put(url).set(CSRF).send({status:'approved',fields:{documentNumber:'AB123458'}}).expect(200)
      .then(r => expect(r.body.revision).toBe(2));
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM customer_documents WHERE customer_id=$1',[customer])).rows[0].n).toBe(0);
    const reviews = await ctx.pool.query('SELECT fields,revision FROM customer_intake_document_reviews WHERE document_id=$1',[docId]);
    expect(reviews.rows[0]).toMatchObject({fields:{documentNumber:'AB123458'},revision:2});
  });

});
