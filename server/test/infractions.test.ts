import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;
let managerId: string;
let employeeId: string;
let cas: string;
let rak: string;
let vehicle: string;
let otherVehicle: string;

const body = (vehicleId: string, noticeNumber = 'DEMO-PV-001', overrides: Record<string, unknown> = {}) => ({
  vehicleId, issuer: 'NARSA', noticeNumber, occurredLocal: '2026-10-15T14:22',
  notifiedOn: '2026-11-12', location: 'Casablanca (demo)', kind: 'Radar demo',
  amountCents: 30000, ...overrides,
});
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
};
async function newCar(branchId: string, plate: string) {
  const res = await manager.post('/api/vehicles').set(CSRF).send({
    branchId, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual',
    mileageKm: 1000, dailyRateCents: 30000,
  }).expect(201);
  return res.body.id as string;
}
async function openContract() {
  await manager.post(`/api/vehicles/${vehicle}/transitions`).set(CSRF).send({
    to: 'available', expectedStatus: 'inspection_pending', mileageKm: 1000, fuelEighths: 8,
  }).expect(200);
  const customer = (await manager.post('/api/customers').set(CSRF).send({
    fullName: 'Client entièrement fictif', phone: '0600000099', birthDate: '1990-01-01',
    licenceNumber: 'TEST-L-001', preferredLanguage: 'fr',
  }).expect(201)).body.customer.id as string;
  const reservation = (await manager.post('/api/reservations').set(CSRF).send({
    customerId: customer, vehicleId: vehicle, start: at(0, 0), end: at(3, 23),
  }).expect(201)).body.reservation;
  const contract = (await manager.post('/api/contracts/checkout').set(CSRF).send({
    reservationId: reservation.id, kmOut: 1000, fuelOut: 8, payments: [],
  }).expect(201)).body.contract;
  // Select a synthetic incident INSIDE the actual contractual occupancy window.
  const time = (await ctx.pool.query(
    `SELECT to_char((out_at + interval '1 hour') AT TIME ZONE 'Africa/Casablanca', 'YYYY-MM-DD"T"HH24:MI') AS local
      FROM contracts WHERE id = $1`, [contract.id],
  )).rows[0].local as string;
  return { contractId: contract.id as string, occurredLocal: time };
}

beforeAll(async () => { ctx = await setupTestApp(); });
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'manager-infractions@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'employee-infractions@example.test', role: 'employee' });
  managerId = m.id;
  employeeId = e.id;
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' }).expect(201)).body.id;
  rak = (await manager.post('/api/branches').set(CSRF).send({ code: 'RAK', name: 'Marrakech', city: 'Marrakech' }).expect(201)).body.id;
  await manager.put(`/api/users/${employeeId}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
  await ctx.pool.query("UPDATE company_settings SET trade_name = 'Location Démo' WHERE id = 1");
  vehicle = await newCar(cas, '00001-أ-1');
  otherVehicle = await newCar(rak, '00002-أ-1');
});
afterAll(async () => { await ctx.pool.end(); });

describe('Infractions & Amendes MVP (synthetic fixtures only)', () => {
  it('manager records a manual notice, deduplicates source/number, and never modifies cash', async () => {
    const res = await manager.post('/api/infractions').set(CSRF).send(body(vehicle)).expect(201);
    expect(res.body.infraction).toMatchObject({
      issuer: 'NARSA', noticeNumber: 'DEMO-PV-001',
      occurredLocal: '2026-10-15T14:22', notifiedOn: '2026-11-12',
      amountCents: 30000, status: 'new', matchStatus: 'pending', contractId: null,
    });
    await manager.post('/api/infractions').set(CSRF).send(body(vehicle, 'demo-pv-001', { issuer: 'narsa' })).expect(409);
    await manager.post('/api/infractions').set(CSRF).send(body(vehicle, 'DEMO-PV-001', { issuer: 'Gendarmerie' })).expect(201);
    const list = await manager.get(`/api/infractions?vehicleId=${vehicle}`).expect(200);
    expect(list.body.items).toHaveLength(2);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM payments')).rows[0].n).toBe(0);
    expect((await auditRows(ctx.pool, 'infraction.registered'))).toHaveLength(2);
    await expect(ctx.pool.query('DELETE FROM road_infraction_events')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM road_infractions')).rejects.toThrow(/never deleted/);
    await manager.post('/api/infractions').set(CSRF).send({ ...body(vehicle), status: 'paid' }).expect(400);
  });

  it('suggests matching rentals, requires explicit manager decision, rejects a different vehicle, and never collects a fine', async () => {
    const { contractId, occurredLocal } = await openContract();
    const item = (await manager.post('/api/infractions').set(CSRF).send(
      body(vehicle, 'DEMO-PV-002', { occurredLocal }),
    ).expect(201)).body.infraction;
    const other = (await manager.post('/api/infractions').set(CSRF).send(
      body(otherVehicle, 'DEMO-PV-003', { occurredLocal }),
    ).expect(201)).body.infraction;

    const candidates = (await manager.get(`/api/infractions/${item.id}/candidates`).expect(200)).body.candidates;
    expect(candidates.map((c: { id: string }) => c.id)).toContain(contractId);
    expect((await manager.get(`/api/infractions/${other.id}/candidates`).expect(200)).body.candidates).toHaveLength(0);
    await manager.post(`/api/infractions/${other.id}/match`).set(CSRF).send({
      contractId, reason: 'Incorrect vehicle; never accept a different plate',
    }).expect(400);
    const accepted = await manager.post(`/api/infractions/${item.id}/match`).set(CSRF).send({
      contractId, reason: 'Contrat original comparé avec la date de l’avis synthétique',
    }).expect(200);
    expect(accepted.body.infraction).toMatchObject({ contractId, matchStatus: 'confirmed' });
    await manager.post(`/api/infractions/${item.id}/match`).set(CSRF).send({
      contractId, reason: 'Repeated confirmation should not duplicate',
    }).expect(409);
    await manager.post(`/api/infractions/${item.id}/status`).set(CSRF).send({
      status: 'paid', reason: 'Avis affiché comme réglé avec preuve à vérifier',
    }).expect(400);
    const paid = await manager.post(`/api/infractions/${item.id}/status`).set(CSRF).send({
      status: 'paid', reason: 'Preuve de paiement test reçue et vérifiée',
      paymentReference: 'PAID-DEMO-002',
    }).expect(200);
    expect(paid.body.infraction).toMatchObject({ status: 'paid', paymentReference: 'PAID-DEMO-002' });
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM payments')).rows[0].n).toBe(0);
    const e = await ctx.pool.query('SELECT action FROM road_infraction_events WHERE infraction_id = $1 ORDER BY id', [item.id]);
    expect(e.rows.map((x) => x.action)).toEqual(['registered', 'match_reviewed', 'status_changed']);
    await expect(ctx.pool.query('UPDATE road_infraction_events SET action = action')).rejects.toThrow(/append-only/);
  });

  it('keeps an overdue open rental as a provisional candidate after the planned return time', async () => {
    const { contractId } = await openContract();
    const overdue = (await ctx.pool.query(
      `SELECT to_char((planned_end_at + interval '1 day') AT TIME ZONE 'Africa/Casablanca', 'YYYY-MM-DD"T"HH24:MI') AS local
       FROM contracts WHERE id = $1`, [contractId],
    )).rows[0].local as string;
    const item = (await manager.post('/api/infractions').set(CSRF)
      .send(body(vehicle, 'DEMO-OVERDUE', { occurredLocal: overdue })).expect(201)).body.infraction;
    const candidates = (await manager.get(`/api/infractions/${item.id}/candidates`).expect(200)).body.candidates;
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: contractId, provisional: true }),
    ]));
    // Explicit approval is still required; no contract, client or payment is assigned on creation.
    expect(item).toMatchObject({ contractId: null, matchStatus: 'pending' });
    const review = await manager.post(`/api/infractions/${item.id}/match`).set(CSRF).send({
      contractId, reason: 'Retard de restitution vérifié, attribution à contrôler avec le dossier',
    }).expect(200);
    expect(review.body.infraction.matchStatus).toBe('confirmed');
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM payments')).rows[0].n).toBe(0);
  });

  it('denies employees by default and keeps a separately granted read permission within branch scope', async () => {
    await manager.post('/api/infractions').set(CSRF).send(body(vehicle)).expect(201);
    await manager.post('/api/infractions').set(CSRF).send(body(otherVehicle, 'DEMO-PV-RAK')).expect(201);
    await employee.get('/api/infractions').expect(403);
    await employee.post('/api/infractions').set(CSRF).send(body(vehicle, 'DEMO-PV-EMP')).expect(403);

    // Synthetic only: simulate a deliberate future read-only grant to test branch SQL isolation.
    await ctx.pool.query(
      'INSERT INTO user_permission_grants (user_id, permission_code, granted_by) VALUES ($1, $2, $3)',
      [employeeId, 'infractions.read', managerId],
    );
    const delegated = await loginAgent(ctx.app, 'employee-infractions@example.test', 'Correct-Horse-9');
    const list = await delegated.get('/api/infractions').expect(200);
    expect(list.body.items.map((i: { vehicle: { id: string } }) => i.vehicle.id)).toEqual([vehicle]);
    await delegated.get(`/api/infractions?vehicleId=${otherVehicle}`).expect(200)
      .then((res) => expect(res.body.items).toHaveLength(0));
    const id = list.body.items[0].id as string;
    await delegated.get(`/api/infractions/${id}/candidates`).expect(403);
    await delegated.post(`/api/infractions/${id}/match`).set(CSRF).send({
      contractId: null, reason: 'No contract matches this incident time',
    }).expect(403);
  });

  it('allows human no-contract decision but never presumes the customer was driving', async () => {
    const id = (await manager.post('/api/infractions').set(CSRF).send(body(vehicle, 'DEMO-PV-004')).expect(201)).body.infraction.id;
    const review = await manager.post(`/api/infractions/${id}/match`).set(CSRF).send({
      contractId: null, reason: 'Outside any verified rental period; follow up with manager',
    }).expect(200);
    expect(review.body.infraction).toMatchObject({ matchStatus: 'no_contract', contractId: null });
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM payments')).rows[0].n).toBe(0);
  });
});
