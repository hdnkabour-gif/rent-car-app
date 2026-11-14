import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

// Synthetic data only.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fleetora-contract-photo')]);
const PDF = Buffer.from('%PDF-1.4\n% fleetora synthetic signed contract\n');

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;
let cas: string;
let car: string;
let client: string;

const at = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
};

async function readyVehicle(plate: string) {
  const v = await manager
    .post('/api/vehicles')
    .set(CSRF)
    .send({ branchId: cas, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 1000, dailyRateCents: 30000, depositCents: 300000 })
    .expect(201);
  await manager.post(`/api/vehicles/${v.body.id}/transitions`).set(CSRF).send({ to: 'available', expectedStatus: 'inspection_pending', mileageKm: 1000, fuelEighths: 8, cleaned: true }).expect(200);
  return v.body.id as string;
}
async function reserve(vehicleId = car, start = at(0, 0), end = at(3, 23)) {
  const r = await employee.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId, start, end, dailyCents: undefined }).expect(201);
  return r.body.reservation as { id: string; days: number; totalCents: number };
}
const checkout = (agent: TestAgent, reservationId: string, extra: Record<string, unknown> = {}) =>
  agent
    .post('/api/contracts/checkout')
    .set(CSRF)
    .send({ reservationId, kmOut: 1000, fuelOut: 8, washedOut: true, documentsOut: ['Carte grise', 'Assurance'], ...extra });

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager', fullName: 'Gérant Démo' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee', fullName: 'Employé Démo' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  await manager.put(`/api/users/${e.id}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
  await ctx.pool.query(`UPDATE company_settings SET trade_name = 'Location Démo', ice = '000000000000001', phone = '0500000000' WHERE id = 1`);
  car = await readyVehicle('99991-أ-1');
  client = (
    await manager
      .post('/api/customers')
      .set(CSRF)
      .send({ fullName: 'Client Démo', phone: '0600000001', birthDate: '1990-01-01', idDocType: 'cin', idDocNumber: 'ZZ1', licenceNumber: 'L-1', licenceIssueDate: '2015-01-01', profession: 'Commerçant' })
      .expect(201)
  ).body.customer.id;
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('check-out', () => {
  it('hands over the vehicle: contract with frozen copy, vehicle rented, reservation in progress, payments', async () => {
    const r = await reserve();
    const res = await checkout(employee, r.id, {
      paperNumber: '0660',
      drivers: [{ fullName: 'Second Conducteur Démo', birthDate: '1992-03-03', licenceNumber: 'L-2', licenceIssueDate: '2018-05-05' }],
      payments: [
        { kind: 'rental', method: 'cash', amountCents: 50000 },
        { kind: 'deposit_in', method: 'cheque', amountCents: 300000, reference: 'CHQ 0001' },
      ],
    }).expect(201);
    const k = res.body.contract;
    expect(k).toMatchObject({ reference: 'C-00001', paperNumber: '0660', status: 'open', days: r.days, totalCents: r.totalCents, kmOut: 1000, fuelOut: 8, templateVersion: 1 });
    expect(k.snapshot).toMatchObject({ company: { name: 'Location Démo', ice: '000000000000001' }, customer: { fullName: 'Client Démo', profession: 'Commerçant', idDocNumber: 'ZZ1' }, vehicle: { plate: '99991-أ-1' } });

    const detail = (await employee.get(`/api/contracts/${k.id}`).expect(200)).body;
    // Deposits are never counted as rental paid.
    expect(detail.balances).toMatchObject({ paidCents: 50000, restCents: r.totalCents - 50000, depositHeldCents: 300000 });
    expect(detail.drivers).toHaveLength(1);
    expect(detail.template.handedDocuments).toContain('Carte grise');
    expect((await manager.get(`/api/vehicles/${car}`).expect(200)).body.vehicle.status).toBe('rented');
    expect((await employee.get(`/api/reservations/${r.id}`).expect(200)).body.reservation.status).toBe('in_progress');
    expect(await auditRows(ctx.pool, 'contract.checkout')).toHaveLength(1);

    // Later edits of the customer never change what was printed.
    await manager.put(`/api/customers/${client}`).set(CSRF).send({ fullName: 'Nom Changé', phone: '0600000001', acknowledgeDuplicates: true }).expect(200);
    expect((await employee.get(`/api/contracts/${k.id}`).expect(200)).body.contract.snapshot.customer.fullName).toBe('Client Démo');
  });

  it('refuses: vehicle not inspected, lower mileage, unknown document, paper number used twice, closed reservation', async () => {
    const other = await manager
      .post('/api/vehicles')
      .set(CSRF)
      .send({ branchId: cas, plate: '99992-أ-1', make: 'Dacia', model: 'Sandero', fuelType: 'diesel', transmission: 'manual', mileageKm: 10, dailyRateCents: 20000 })
      .expect(201);
    const r1 = await reserve(other.body.id);
    expect((await checkout(employee, r1.id, { kmOut: 10 }).expect(409)).body.error.code).toBe('vehicle_not_ready');
    const r = await reserve();
    expect((await checkout(employee, r.id, { kmOut: 999 }).expect(422)).body.error.code).toBe('mileage_decrease');
    await checkout(employee, r.id, { documentsOut: ['Passeport du chien'] }).expect(400);
    await checkout(employee, r.id, { paperNumber: '0660' }).expect(201);
    await checkout(employee, r.id).expect(409); // already in progress
    const car3 = await readyVehicle('99993-أ-1');
    const r3 = await reserve(car3);
    expect((await checkout(employee, r3.id, { paperNumber: ' 0660 ' }).expect(409)).body.error.code).toBe('paper_number_used');
  });

  it('the rental is paid in cash or transfer; overpayment and wrong rights are refused', async () => {
    const r = await reserve();
    await checkout(employee, r.id, { payments: [{ kind: 'rental', method: 'cheque', amountCents: 100 }] }).expect(400);
    await checkout(employee, r.id, { payments: [{ kind: 'rental', method: 'cash', amountCents: r.totalCents + 1 }] }).expect(409);
    await checkout(employee, r.id, { payments: [{ kind: 'deposit_out', method: 'cash', amountCents: 100 }] }).expect(403);
    await checkout(employee, r.id, { payments: [{ kind: 'rental', method: 'transfer', amountCents: r.totalCents, reference: 'VIR-1' }] }).expect(201);
  });
});

describe('during and after the rental', () => {
  it('extends the rental unless another booking is in the way — a manager decision (audit P0)', async () => {
    const r = await reserve(car, at(0, 0), at(2, 10));
    const k = (await checkout(employee, r.id).expect(201)).body.contract;
    await reserve(car, at(4, 10), at(6, 10)); // next customer
    // An employee cannot extend on his own…
    await employee.post(`/api/contracts/${k.id}/extend`).set(CSRF).send({ newEnd: at(3, 10), reason: 'Client prolonge' }).expect(403);
    expect((await manager.post(`/api/contracts/${k.id}/extend`).set(CSRF).send({ newEnd: at(5, 10) }).expect(409)).body.error.code).toBe('vehicle_unavailable');
    await manager.post(`/api/contracts/${k.id}/extend`).set(CSRF).send({ newEnd: at(1, 10) }).expect(400);
    const ext = (await manager.post(`/api/contracts/${k.id}/extend`).set(CSRF).send({ newEnd: at(4, 10), reason: 'Client prolonge' }).expect(200)).body.contract;
    expect(ext.days).toBe(k.days + 2);
    expect(ext.totalCents).toBe((k.days + 2) * 30000);
    // …unless the manager delegates this right to him by name.
    const emp = (await ctx.pool.query(`SELECT id FROM users WHERE email = 'e@example.test'`)).rows[0].id;
    await manager.put(`/api/users/${emp}/grants`).set(CSRF).send({ permissions: ['contracts.extend'] }).expect(204);
    // Delegated: the permission now passes; the next booking still blocks these dates (409, not 403).
    expect((await employee.post(`/api/contracts/${k.id}/extend`).set(CSRF).send({ newEnd: at(4, 11) }).expect(409)).body.error.code).toBe('vehicle_unavailable');
  });

  it('other drivers: birth date and licence required; under the minimum age refused (audit P0)', async () => {
    const r = await reserve();
    await checkout(employee, r.id, { drivers: [{ fullName: 'Sans Date', licenceNumber: 'L-9' }] }).expect(400);
    const young = at(-17 * 365).slice(0, 10);
    expect((await checkout(employee, r.id, { drivers: [{ fullName: 'Trop Jeune', birthDate: young, licenceNumber: 'L-9' }] }).expect(409)).body.error.code).toBe('driver_too_young');
    expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM contracts`)).rows[0].n).toBe(0); // nothing half-saved
    const k = (await checkout(employee, r.id, { drivers: [{ fullName: 'Adulte Démo', birthDate: '1990-01-01', licenceNumber: 'L-8' }] }).expect(201)).body.contract;
    await employee.post(`/api/contracts/${k.id}/drivers`).set(CSRF).send({ fullName: 'Trop Jeune', birthDate: young, licenceNumber: 'L-7' }).expect(409);
    const d = (await employee.get(`/api/contracts/${k.id}`).expect(200)).body.drivers;
    expect(d).toEqual([expect.objectContaining({ fullName: 'Adulte Démo', birthDate: '1990-01-01' })]);
  });

  it('the minimum driver age cannot be set below 18 (owner rule)', async () => {
    await manager.put('/api/company-settings').set(CSRF).send({ legalName: 'Démo', tradeName: 'Démo', minDriverAge: 16 }).expect(400);
    await expect(ctx.pool.query('UPDATE company_settings SET min_driver_age = 17')).rejects.toThrow(/min_driver_age_18/);
  });

  it('late return: an employee does the return, the MANAGER decides day / half day / hour (owner rule)', async () => {
    const r = await reserve();
    const k = (await checkout(employee, r.id, { payments: [{ kind: 'deposit_in', method: 'cash', amountCents: 300000 }] }).expect(201)).body.contract;
    await ctx.pool.query(`UPDATE contracts SET out_at = now() - interval '5 days', planned_end_at = now() - interval '26 hours' WHERE id = $1`, [k.id]);
    const preview = (await employee.get(`/api/contracts/${k.id}/return-preview`).expect(200)).body;
    expect(preview).toMatchObject({ graceMinutes: 60, isLate: true, suggestions: { day: 2, half_day: 3, hour: 26 }, unitPrices: { day: 30000, half_day: 15000, hour: 1300 } });
    await employee.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 1500, fuelIn: 6, late: { decision: 'charge', unit: 'day', quantity: 1, unitCents: 30000 } }).expect(403);
    await employee.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 900, fuelIn: 6 }).expect(422);
    const done = (await employee.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 1500, fuelIn: 6 }).expect(200)).body;
    expect(done.contract).toMatchObject({ status: 'closed', kmIn: 1500, kmDriven: 500, totalCents: k.totalCents, late: { status: 'pending', feeCents: 0 } });
    expect(done.contract.late.minutes).toBeGreaterThanOrEqual(26 * 60);
    expect((await manager.get('/api/contracts?status=late_fee').expect(200)).body.items).toHaveLength(1);
    expect((await manager.get('/api/contracts/summary').expect(200)).body.lateFeePending).toBe(1);
    await employee.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'charge', unit: 'hour', quantity: 26, unitCents: 1300 }).expect(403);
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'charge', unit: 'half_day' }).expect(400);
    const charged = (await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'charge', unit: 'half_day', quantity: 3, unitCents: 15000 }).expect(200)).body;
    expect(charged.contract).toMatchObject({ totalCents: k.totalCents + 45000, late: { status: 'charged', unit: 'half_day', quantity: 3, feeCents: 45000 } });
    expect(charged.balances.restCents).toBe(k.totalCents + 45000);
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'charge', unit: 'hour', quantity: 26, unitCents: 1300 }).expect(400);
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive' }).expect(400);
    const waived = (await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'Retard du vol, client fidèle' }).expect(200)).body;
    expect(waived.contract).toMatchObject({ totalCents: k.totalCents, late: { status: 'waived', feeCents: 0 } });
    const ev = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body.events.filter((e: { event: string }) => e.event === 'late_fee');
    expect(ev).toHaveLength(2);
    expect(await auditRows(ctx.pool, 'contract.late_fee')).toHaveLength(2);
    const v = (await manager.get(`/api/vehicles/${car}`).expect(200)).body;
    expect(v.vehicle).toMatchObject({ status: 'inspection_pending', mileageKm: 1500, fuelEighths: 6 });
    expect((await employee.get(`/api/reservations/${r.id}`).expect(200)).body.reservation.status).toBe('completed');
    await manager.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 1600, fuelIn: 6 }).expect(409);
  });

  it('a manager can decide the late charge directly at the return', async () => {
    const r = await reserve();
    const k = (await checkout(employee, r.id).expect(201)).body.contract;
    await ctx.pool.query(`UPDATE contracts SET out_at = now() - interval '5 days', planned_end_at = now() - interval '3 hours' WHERE id = $1`, [k.id]);
    const done = (await manager.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 1100, fuelIn: 8, late: { decision: 'charge', unit: 'hour', quantity: 3, unitCents: 2000 } }).expect(200)).body;
    expect(done.contract.late).toMatchObject({ status: 'charged', feeCents: 6000 });
    expect(done.contract.totalCents).toBe(k.totalCents + 6000);
  });

  it('on-time return: nothing to decide', async () => {
    const r = await reserve();
    const k = (await checkout(employee, r.id).expect(201)).body.contract;
    const done = (await employee.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 1200, fuelIn: 8 }).expect(200)).body;
    expect(done.contract.late.status).toBe('none');
    expect(done.late.isLate).toBe(false);
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'x' }).expect(409);
  });

  it('deposit: refund and keep need their rights; kept needs a reason; mistakes are reversed, never edited', async () => {
    const r = await reserve();
    const k = (await checkout(employee, r.id, { payments: [{ kind: 'deposit_in', method: 'card', amountCents: 300000, reference: 'Empreinte' }, { kind: 'rental', method: 'cash', amountCents: 10000 }] }).expect(201)).body.contract;
    const pay = (body: Record<string, unknown>, agent = manager) => agent.post(`/api/contracts/${k.id}/payments`).set(CSRF).send(body);
    await pay({ kind: 'deposit_out', method: 'card', amountCents: 100000 }, employee).expect(403);
    await pay({ kind: 'deposit_kept', method: 'card', amountCents: 50000 }).expect(400);
    await pay({ kind: 'deposit_kept', method: 'card', amountCents: 50000, reason: 'Rayure portière' }).expect(201);
    await pay({ kind: 'deposit_out', method: 'card', amountCents: 260000 }).expect(409);
    const refund = (await pay({ kind: 'deposit_out', method: 'card', amountCents: 250000 }).expect(201)).body.balances;
    expect(refund).toMatchObject({ depositHeldCents: 0, depositKeptCents: 50000, depositReturnedCents: 250000, paidCents: 10000 });

    const detail = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body;
    const rental = detail.payments.find((p: { kind: string }) => p.kind === 'rental');
    await employee.post(`/api/contracts/${k.id}/payments/${rental.id}/reverse`).set(CSRF).send({ reason: 'Erreur' }).expect(403);
    const rev = (await manager.post(`/api/contracts/${k.id}/payments/${rental.id}/reverse`).set(CSRF).send({ reason: 'Saisi deux fois' }).expect(201)).body.balances;
    expect(rev.paidCents).toBe(0);
    await manager.post(`/api/contracts/${k.id}/payments/${rental.id}/reverse`).set(CSRF).send({ reason: 'Encore' }).expect(409);
    const depositIn = detail.payments.find((p: { kind: string }) => p.kind === 'deposit_in');
    expect((await manager.post(`/api/contracts/${k.id}/payments/${depositIn.id}/reverse`).set(CSRF).send({ reason: 'Erreur' }).expect(409)).body.error.code).toBe('deposit_exceeded');
    await expect(ctx.pool.query('UPDATE payments SET amount_cents = 1')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM payments')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM contracts')).rejects.toThrow(/never deleted/);
  });

  it('signed paper scan and photos are kept with the contract and served only from it', async () => {
    const r = await reserve();
    const k = (await checkout(employee, r.id).expect(201)).body.contract;
    const scan = (await employee.put(`/api/contracts/${k.id}/signed-scan`).set(CSRF).set('Content-Type', 'application/pdf').send(PDF).expect(200)).body.contract;
    const ph = (await employee.post(`/api/contracts/${k.id}/photos?phase=out`).set(CSRF).set('Content-Type', 'image/jpeg').send(JPEG).expect(201)).body;
    expect((await employee.post(`/api/contracts/${k.id}/photos?phase=out`).set(CSRF).set('Content-Type', 'image/jpeg').send(JPEG).expect(200)).body.duplicate).toBe(true);
    const f = await employee.get(`/api/contracts/${k.id}/files/${scan.signedScanFileId}`).expect(200);
    expect(Buffer.compare(f.body, PDF)).toBe(0);
    await employee.get(`/api/contracts/${k.id}/files/${ph.fileId}`).expect(200);
    await employee.get(`/api/vehicles/${car}/files/${scan.signedScanFileId}`).expect(404);
    await employee.put(`/api/contracts/${k.id}/paper-number`).set(CSRF).send({ paperNumber: '0661' }).expect(200);
  });
});

describe('contract template and driver rules', () => {
  it('each saved template is a new version; existing contracts keep the version they were made with', async () => {
    const body = { title: 'CONTRAT DE LOCATION', handedDocuments: ['Carte grise', 'Assurance', 'Vignette'], responsibilityClause: 'Le conducteur est responsable.', termsTitle: 'CONDITIONS GÉNÉRALES', terms: [{ title: 'ART 01', body: 'Texte démo.' }, { title: 'ART 10', body: 'La journée de location correspond à 24 heures.' }] };
    await employee.post('/api/contract-templates').set(CSRF).send(body).expect(403);
    const r1 = await reserve(car, at(0, 0), at(1, 23));
    const k1 = (await checkout(employee, r1.id).expect(201)).body.contract;
    const t2 = (await manager.post('/api/contract-templates').set(CSRF).send(body).expect(201)).body.template;
    expect(t2.version).toBe(2);
    expect((await employee.get('/api/contract-templates/current').expect(200)).body.template.terms).toHaveLength(2);
    const car2 = await readyVehicle('99994-أ-1');
    const r2 = await reserve(car2);
    const k2 = (await checkout(employee, r2.id).expect(201)).body.contract;
    expect(k2.templateVersion).toBe(2);
    expect((await employee.get(`/api/contracts/${k1.id}`).expect(200)).body.template.version).toBe(1);
    await expect(ctx.pool.query(`UPDATE contract_templates SET title = 'x'`)).rejects.toThrow(/append-only/);
    const list = (await manager.get('/api/contract-templates').expect(200)).body.items;
    expect(list.map((t: { version: number; contracts: number }) => [t.version, t.contracts])).toEqual([[2, 1], [1, 1]]);
  });

  it('a driver under the minimum age is refused; a new licence is a warning (owner rules)', async () => {
    const young = (await manager.post('/api/customers').set(CSRF).send({ fullName: 'Jeune Démo', phone: '0600000009', birthDate: at(-17 * 365).slice(0, 10), licenceNumber: 'L-9' }).expect(201)).body.customer.id;
    const res = await employee.post('/api/reservations').set(CSRF).send({ customerId: young, vehicleId: car, start: at(1), end: at(2) }).expect(409);
    expect(res.body.error.code).toBe('driver_too_young');
    const fresh = (await manager.post('/api/customers').set(CSRF).send({ fullName: 'Nouveau Permis', phone: '0600000008', birthDate: '2000-01-01', licenceNumber: 'L-8', licenceIssueDate: at(-200).slice(0, 10) }).expect(201)).body.customer.id;
    const q = (await employee.post('/api/reservations/quote').set(CSRF).send({ customerId: fresh, vehicleId: car, start: at(1), end: at(40) }).expect(200)).body;
    expect(q.warnings.sort()).toEqual(['customer_licence_new', 'over_max_days']);
    await manager.put('/api/company-settings').set(CSRF).send({ legalName: 'Démo', tradeName: 'Démo', minDriverAge: 21, newLicenceYears: 0, maxContractDays: 60 }).expect(200);
    const q2 = (await employee.post('/api/reservations/quote').set(CSRF).send({ customerId: fresh, vehicleId: car, start: at(1), end: at(40) }).expect(200)).body;
    expect(q2.warnings).toEqual([]);
  });

  it('manually reviews a scanned contract without altering the signed snapshot or payments', async () => {
    const r=await reserve();
    const contract=(await checkout(employee,r.id).expect(201)).body.contract;
    const id=contract.id as string;
    const original=JSON.stringify(contract.snapshot);
    await employee.put(`/api/contracts/${id}/signed-scan`).set(CSRF)
      .set('Content-Type','application/pdf').send(PDF).expect(200);
    await employee.post(`/api/contracts/${id}/signed-scan/analyze`).set(CSRF).expect(403);
    await manager.post(`/api/contracts/${id}/signed-scan/analyze`).set(CSRF).expect(503);
    await employee.get(`/api/contracts/${id}/signed-scan/review`).expect(403);
    const reviewUrl=`/api/contracts/${id}/signed-scan/review`;
    await manager.put(reviewUrl).set(CSRF).send({
      status:'approved',fields:{contractNumber:'C-00001'},expectedRevision:0,
    }).expect(200).then(x=>expect(x.body.revision).toBe(1));
    const saved=(await manager.get(reviewUrl).expect(200)).body;
    expect(saved.review).toMatchObject({status:'approved',revision:1,fields:{contractNumber:'C-00001'}});
    expect(saved.mimeType).toBe('application/pdf');
    await manager.put(reviewUrl).set(CSRF).send({
      status:'approved',fields:{contractNumber:'bad'},expectedRevision:0,
    }).expect(409);
    const current=(await manager.get(`/api/contracts/${id}`).expect(200)).body;
    expect(JSON.stringify(current.contract.snapshot)).toBe(original);
    expect(current.payments).toHaveLength(0);
    await employee.put(`/api/contracts/${id}/signed-scan`).set(CSRF)
      .set('Content-Type','image/jpeg').send(JPEG).expect(200);
    expect((await manager.get(reviewUrl).expect(200)).body.review).toBeNull();
  });

  it('the company logo can be uploaded and is printed on new contracts', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('logo-demo')]);
    await employee.put('/api/company-settings/logo').set(CSRF).set('Content-Type', 'image/png').send(PNG).expect(403);
    const s = (await manager.put('/api/company-settings/logo').set(CSRF).set('Content-Type', 'image/png').send(PNG).expect(200)).body;
    expect(s.logo.configured).toBe(true);
    const logo = await employee.get('/api/company-settings/logo').expect(200);
    expect(Buffer.compare(logo.body, PNG)).toBe(0);
    const r = await reserve();
    const k = (await checkout(employee, r.id).expect(201)).body.contract;
    expect(k.snapshot.company.logoFileId).toBe(s.logo.fileId);
    await employee.get(`/api/contracts/${k.id}/files/${s.logo.fileId}`).expect(200);
  });
});
