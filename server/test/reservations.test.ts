import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

// Synthetic data only.
let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent; // Casablanca only
let employeeId: string;
let cas: string;
let rak: string;
let car: string; // CAS, 300 MAD/day, deposit 3000 MAD
let car2: string; // CAS, no price
let rakCar: string;
let client: string;

/** Local date-time `days` from today at `hour`:00, as typed in the form. */
const at = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
};

async function vehicle(branchId: string, plate: string, extra: Record<string, unknown> = {}) {
  const res = await manager
    .post('/api/vehicles')
    .set(CSRF)
    .send({ branchId, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 1000, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
async function customer(name: string, phone: string, extra: Record<string, unknown> = {}) {
  const res = await manager.post('/api/customers').set(CSRF).send({ fullName: name, phone, licenceNumber: `L-${phone}`, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.customer.id as string;
}
const book = (agent: TestAgent, body: Record<string, unknown>) =>
  agent.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId: car, start: at(5), end: at(8), ...body });

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee', fullName: 'Employé Démo' });
  employeeId = e.id;
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  rak = (await manager.post('/api/branches').set(CSRF).send({ code: 'RAK', name: 'Marrakech', city: 'Marrakech' })).body.id;
  await manager.put(`/api/users/${employeeId}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
  car = await vehicle(cas, '99991-أ-1', { dailyRateCents: 30000, depositCents: 300000 });
  car2 = await vehicle(cas, '99992-أ-1');
  rakCar = await vehicle(rak, '99993-أ-1', { dailyRateCents: 25000 });
  client = await customer('Client Démo', '0600000001');
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('reservations', () => {
  it('books a vehicle: 24-hour days, vehicle price and deposit, reference number, history', async () => {
    const res = await book(employee, { pickupPlace: 'airport', pickupDetails: 'Mohammed V, vol AT 800', returnPlace: 'hotel' }).expect(201);
    const r = res.body.reservation;
    expect(r).toMatchObject({
      reference: 'R-00001',
      status: 'confirmed',
      days: 3,
      listDailyCents: 30000,
      dailyCents: 30000,
      totalCents: 90000,
      depositCents: 300000,
      startLocal: at(5),
      endLocal: at(8),
      pickupPlace: 'airport',
      returnPlace: 'hotel',
      customer: { fullName: 'Client Démo' },
      vehicle: { plate: '99991-أ-1' },
      branch: { name: 'Casablanca' },
      returnBranch: { name: 'Casablanca' },
    });
    // One hour late = one more day (the manager decides at the return, BR-05).
    const r2 = (await book(employee, { start: at(20), end: at(21, 11) }).expect(201)).body.reservation;
    expect(r2.days).toBe(2);
    const detail = (await employee.get(`/api/reservations/${r.id}`).expect(200)).body;
    expect(detail.events.map((e: { event: string }) => e.event)).toEqual(['created']);
    expect(await auditRows(ctx.pool, 'reservation.create')).toHaveLength(2);
  });

  it('never allows two overlapping active reservations on the same vehicle; back-to-back is fine', async () => {
    await book(employee, {}).expect(201);
    const clash = await book(employee, { start: at(7), end: at(10) }).expect(409);
    expect(clash.body.error.code).toBe('vehicle_unavailable');
    await book(employee, { start: at(8), end: at(10) }).expect(201); // starts exactly at the previous return
    await book(employee, { vehicleId: car2, start: at(6), end: at(7), dailyCents: 20000 }).expect(201); // other vehicle
    const avail = (await employee.get(`/api/reservations/availability?start=${at(6)}&end=${at(7)}`).expect(200)).body.items;
    const mine = avail.find((v: { id: string }) => v.id === car);
    expect(mine).toMatchObject({ available: false, conflictReference: 'R-00001' });
  });

  it('REVIEW CASE: simultaneous bookings of the same slot — the database lets exactly one through', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => book(employee, {})));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM reservations WHERE status = 'confirmed'`);
    expect(rows[0].n).toBe(1);
  });

  it('a cancellation needs a reason and frees the vehicle; reopening checks the vehicle is still free', async () => {
    const r = (await book(employee, {}).expect(201)).body.reservation;
    await employee.post(`/api/reservations/${r.id}/cancel`).set(CSRF).send({ reason: '' }).expect(400);
    await employee.post(`/api/reservations/${r.id}/cancel`).set(CSRF).send({ reason: 'Client a annulé' }).expect(200);
    const other = (await book(employee, {}).expect(201)).body.reservation;
    const reopen = await employee.post(`/api/reservations/${r.id}/reopen`).set(CSRF).send({ reason: 'Erreur' }).expect(409);
    expect(reopen.body.error.code).toBe('vehicle_unavailable');
    await employee.post(`/api/reservations/${other.id}/cancel`).set(CSRF).send({ reason: 'Doublon' }).expect(200);
    await employee.post(`/api/reservations/${r.id}/reopen`).set(CSRF).send({ reason: 'Erreur de saisie' }).expect(200);
    const ev = (await employee.get(`/api/reservations/${r.id}`).expect(200)).body.events.map((e: { event: string }) => e.event);
    expect(ev).toEqual(['created', 'cancelled', 'reopened']);
    await employee.put(`/api/reservations/${other.id}`).set(CSRF).send({ customerId: client, vehicleId: car, start: at(5), end: at(9) }).expect(409);
  });

  it('a different price needs the pricing right and a reason (BR-06, BR-14)', async () => {
    await book(employee, { dailyCents: 25000, priceReason: 'Client fidèle' }).expect(403);
    await book(manager, { dailyCents: 25000 }).expect(400);
    const r = (await book(manager, { dailyCents: 25000, priceReason: 'Client fidèle' }).expect(201)).body.reservation;
    expect(r).toMatchObject({ listDailyCents: 30000, dailyCents: 25000, totalCents: 75000, priceReason: 'Client fidèle' });
    const [audit] = await auditRows(ctx.pool, 'reservation.create');
    expect(audit.metadata).toMatchObject({ priceChanged: true, priceReason: 'Client fidèle' });
    // Delegated right: the employee may now do it too.
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['pricing.change'] }).expect(204);
    await book(employee, { start: at(10), end: at(12), dailyCents: 28000, priceReason: 'Longue durée' }).expect(201);
    // The employee edits dates without touching the agreed price: allowed, price kept.
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: [] }).expect(204);
    const upd = await employee.put(`/api/reservations/${r.id}`).set(CSRF).send({ customerId: client, vehicleId: car, start: at(5), end: at(9) }).expect(200);
    expect(upd.body.reservation).toMatchObject({ days: 4, dailyCents: 25000, totalCents: 100000 });
    const ev = (await manager.get(`/api/reservations/${r.id}`).expect(200)).body.events;
    expect(ev[1]).toMatchObject({ event: 'changed', changes: { end: { from: at(8), to: at(9) }, totalCents: { from: 75000, to: 100000 } } });
  });

  it('refuses a "do not rent" customer and warns about licence expiry and a vehicle in maintenance', async () => {
    const blocked = await customer('Client Bloqué', '0600000002');
    await manager.post(`/api/customers/${blocked}/block`).set(CSRF).send({ reason: 'Impayé démo' }).expect(200);
    expect((await book(employee, { customerId: blocked }).expect(409)).body.error.code).toBe('customer_blocked');

    const expiring = await customer('Client Permis', '0600000003', { licenceExpiry: at(6).slice(0, 10) });
    await manager.post(`/api/vehicles/${car}/transitions`).set(CSRF).send({ to: 'maintenance', expectedStatus: 'inspection_pending', reason: 'Vidange' }).expect(200);
    const q = await employee.post('/api/reservations/quote').set(CSRF).send({ customerId: expiring, vehicleId: car, start: at(5), end: at(8) }).expect(200);
    expect(q.body).toMatchObject({ days: 3, totalCents: 90000, available: true });
    expect(q.body.warnings.sort()).toEqual(['customer_licence_expires', 'vehicle_not_ready']);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM reservations')).rows[0].n).toBe(0); // quote saves nothing
    const res = await book(employee, { customerId: expiring }).expect(201);
    expect(res.body.warnings.sort()).toEqual(['customer_licence_expires', 'vehicle_not_ready']);
  });

  it('validates dates: return after pickup, not entirely in the past', async () => {
    await book(employee, { start: at(5), end: at(4) }).expect(400);
    await book(employee, { start: at(-5), end: at(-3) }).expect(400);
    await book(employee, { start: '05/12/2026 10:00' }).expect(400);
  });

  it('branch scope: an employee of Casablanca neither sees nor books Marrakech vehicles', async () => {
    await book(employee, { vehicleId: rakCar }).expect(404);
    const rakRes = (await book(manager, { vehicleId: rakCar }).expect(201)).body.reservation;
    await employee.get(`/api/reservations/${rakRes.id}`).expect(404);
    expect((await employee.get('/api/reservations').expect(200)).body.items).toHaveLength(0);
    expect((await manager.get('/api/reservations').expect(200)).body.items).toHaveLength(1);
    const avail = (await employee.get(`/api/reservations/availability?start=${at(5)}&end=${at(6)}`).expect(200)).body.items;
    expect(avail.map((v: { id: string }) => v.id).sort()).toEqual([car, car2].sort());
  });

  it('lists by view, customer and vehicle; searches by reference, name or plate', async () => {
    const r = (await book(employee, {}).expect(201)).body.reservation;
    await book(employee, { vehicleId: car2, start: at(0, 0), end: at(1, 23), dailyCents: 1000 }).expect(201);
    expect((await employee.get('/api/reservations?view=upcoming').expect(200)).body.items).toHaveLength(2);
    expect((await employee.get(`/api/reservations?customerId=${client}`).expect(200)).body.items).toHaveLength(2);
    expect((await employee.get(`/api/reservations?vehicleId=${car}`).expect(200)).body.items).toHaveLength(1);
    expect((await employee.get('/api/reservations?q=R-00001').expect(200)).body.items.map((x: { id: string }) => x.id)).toEqual([r.id]);
    expect((await employee.get('/api/reservations?q=client').expect(200)).body.items).toHaveLength(2);
    const s = (await employee.get('/api/reservations/summary').expect(200)).body;
    expect(s.upcoming).toBe(2);
    expect(s.departures).toBe(1);
  });

  it('no-show only after the pickup time; closed reservations cannot be changed', async () => {
    const r = (await book(employee, {}).expect(201)).body.reservation;
    expect((await employee.post(`/api/reservations/${r.id}/no-show`).set(CSRF).send({ reason: 'Absent' }).expect(409)).body.error.code).toBe('not_started');
    await employee.post(`/api/reservations/${r.id}/cancel`).set(CSRF).send({ reason: 'Annulé' }).expect(200);
    await employee.put(`/api/reservations/${r.id}`).set(CSRF).send({ customerId: client, vehicleId: car, start: at(5), end: at(9) }).expect(409);
  });

  it('a vehicle with upcoming reservations cannot be retired', async () => {
    await book(employee, {}).expect(201);
    await manager.post(`/api/vehicles/${car}/transitions`).set(CSRF).send({ to: 'out_of_service', expectedStatus: 'inspection_pending', reason: 'Accident' }).expect(200);
    const res = await manager.post(`/api/vehicles/${car}/transitions`).set(CSRF).send({ to: 'retired', expectedStatus: 'out_of_service', reason: 'Vendu' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('has_reservations');
  });
});

describe('company data is never deleted (database level)', () => {
  it('DELETE and TRUNCATE are refused on business tables, whatever the code does', async () => {
    const r = (await book(employee, {}).expect(201)).body.reservation;
    for (const t of ['reservations', 'customers', 'vehicles', 'branches', 'users', 'company_settings', 'reservation_events']) {
      await expect(ctx.pool.query(`DELETE FROM ${t}`), t).rejects.toThrow();
      await expect(ctx.pool.query(`TRUNCATE ${t} CASCADE`), t).rejects.toThrow();
    }
    await expect(ctx.pool.query(`UPDATE reservation_events SET reason = 'x'`)).rejects.toThrow(/append-only/);
    expect((await employee.get(`/api/reservations/${r.id}`).expect(200)).body.reservation.id).toBe(r.id);
  });
});
