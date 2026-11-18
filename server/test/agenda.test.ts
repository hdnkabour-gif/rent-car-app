import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let manager: TestAgent;
let casEmployee: TestAgent;
let cas: string;
let rak: string;
let casCar: string;
let rakCar: string;
let customerId: string;

const DATE = '2026-12-15';
async function newVehicle(branchId: string, plate: string) {
  const response = await manager.post('/api/vehicles').set(CSRF).send({
    branchId, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel',
    transmission: 'manual', mileageKm: 1200, dailyRateCents: 30000,
  }).expect(201);
  return response.body.id as string;
}
async function booking(vehicleId: string, start: string) {
  return (await manager.post('/api/reservations').set(CSRF).send({
    customerId, vehicleId, start, end: '2026-12-18T11:00',
  }).expect(201)).body.reservation;
}
beforeAll(async () => { ctx = await setupTestApp(); });
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'manager-agenda@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'cas-agenda@example.test', role: 'employee' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({code:'CAS',name:'Casablanca',city:'Casablanca'}).expect(201)).body.id;
  rak = (await manager.post('/api/branches').set(CSRF).send({code:'RAK',name:'Marrakech',city:'Marrakech'}).expect(201)).body.id;
  await manager.put(`/api/users/${e.id}/branches`).set(CSRF).send({branchIds:[cas]}).expect(204);
  casEmployee = await loginAgent(ctx.app, e.email, e.password);
  casCar = await newVehicle(cas,'55551-أ-1');
  rakCar = await newVehicle(rak,'55552-أ-1');
  customerId = (await manager.post('/api/customers').set(CSRF).send({
    fullName:'Client Agenda Fictif',phone:'0600000025',licenceNumber:'L-AG-TEST',birthDate:'1990-01-01',
  }).expect(201)).body.customer.id;
});
afterAll(async () => { await ctx.pool.end(); });

describe('Agenda home, synthetic Morocco-only fixtures', () => {
  it('loads real Casablanca-time reservations for authorized branches and keeps other agency data private', async () => {
    const first = await booking(casCar,'2026-12-15T10:30');
    await booking(rakCar,'2026-12-15T12:00');
    const m = await manager.get(`/api/dashboard/agenda?date=${DATE}`).expect(200);
    expect(m.body.items.filter((x: {kind:string})=>x.kind==='reservation')).toHaveLength(2);
    const employee = await casEmployee.get(`/api/dashboard/agenda?date=${DATE}`).expect(200);
    expect(employee.body.date).toBe(DATE);
    const reservations = employee.body.items.filter((x:{kind:string})=>x.kind==='reservation');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      reference: String(first.number), vehicle:{id:casCar,plate:'55551-أ-1'},
      branch:'Casablanca', amountCents:null, time:expect.any(String),
    });
    expect(JSON.stringify(employee.body)).not.toContain(rakCar);
    expect(JSON.stringify(employee.body)).not.toContain('55552');
    expect(employee.body.totals.reservations).toBe(1);
    const balances = await ctx.pool.query('SELECT count(*)::int AS n FROM payments');
    expect(balances.rows[0].n).toBe(0);
  });

  it('reports the real zero-event day, rejects fake dates and hides agenda from unauthenticated visitors', async () => {
    const empty = await casEmployee.get('/api/dashboard/agenda?date=2026-12-14').expect(200);
    expect(empty.body.items).toEqual([]);
    expect(empty.body.totals.outstandingCents).toBe(0);
    await casEmployee.get('/api/dashboard/agenda?date=2026-02-30').expect(400);
    await casEmployee.get('/api/dashboard/agenda?date=not-a-date').expect(400);
    const { default: request } = await import('supertest');
    await request(ctx.app).get('/api/dashboard/agenda').expect(401);
  });
});
