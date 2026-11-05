import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { csvCell } from '../src/routes/reports.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

// Synthetic data only.
const PDF = Buffer.from('%PDF-1.4\n% fleetora synthetic receipt\n');
const SCAN = Buffer.from('%PDF-1.4\n% fleetora synthetic customer id scan\n');

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent; // Casablanca only
let cas: string;
let rak: string;
let car: string;
let client: string;

const at = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());

async function readyVehicle(branchId: string, plate: string) {
  const v = await manager
    .post('/api/vehicles')
    .set(CSRF)
    .send({ branchId, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 1000, dailyRateCents: 30000 })
    .expect(201);
  await manager.post(`/api/vehicles/${v.body.id}/transitions`).set(CSRF).send({ to: 'available', expectedStatus: 'inspection_pending', mileageKm: 1000, fuelEighths: 8 }).expect(200);
  return v.body.id as string;
}
async function openContract(payments: unknown[] = []) {
  const r = (await employee.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId: car, start: at(0, 0), end: at(2, 23) }).expect(201)).body.reservation;
  return (await employee.post('/api/contracts/checkout').set(CSRF).send({ reservationId: r.id, kmOut: 1000, fuelOut: 8, payments }).expect(201)).body.contract as { id: string };
}

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager', fullName: 'Gérant Démo' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee', fullName: 'Employé Démo' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Casablanca', city: 'Casablanca' })).body.id;
  rak = (await manager.post('/api/branches').set(CSRF).send({ code: 'RAK', name: 'Marrakech', city: 'Marrakech' })).body.id;
  await manager.put(`/api/users/${e.id}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
  await ctx.pool.query(`UPDATE company_settings SET trade_name = 'Location Démo' WHERE id = 1`);
  car = await readyVehicle(cas, '99991-أ-1');
  client = (await manager.post('/api/customers').set(CSRF).send({ fullName: 'Client Démo', phone: '0600000001', birthDate: '1990-01-01', licenceNumber: 'L-1', preferredLanguage: 'ar' }).expect(201)).body.customer.id;
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('expenses', () => {
  it('employee records an expense in his branch only; dates not in the future; corrections by reversal (manager)', async () => {
    const res = await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, vehicleId: car, category: 'fuel', amountCents: 25000, method: 'cash', supplier: 'Station Démo' }).expect(201);
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: rak, category: 'fuel', amountCents: 100, method: 'cash' }).expect(403);
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'fuel', amountCents: 100, method: 'cash', spentOn: at(3).slice(0, 10) }).expect(400);
    await employee.post(`/api/cash/expenses/${res.body.id}/reverse`).set(CSRF).send({ reason: 'Erreur' }).expect(403);
    await manager.post(`/api/cash/expenses/${res.body.id}/reverse`).set(CSRF).send({ reason: 'Saisi deux fois' }).expect(201);
    await manager.post(`/api/cash/expenses/${res.body.id}/reverse`).set(CSRF).send({ reason: 'Encore' }).expect(409);
    const list = (await employee.get('/api/cash/expenses').expect(200)).body.items;
    expect(list.map((x: { kind: string }) => x.kind).sort()).toEqual(['expense', 'reversal']);
    await expect(ctx.pool.query('UPDATE expenses SET amount_cents = 1')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM expenses')).rejects.toThrow(/append-only/);
  });

  it('REVIEW CASE: a receipt id can never be used to reach another document (IDOR)', async () => {
    // A customer ID scan uploaded by the manager…
    const scan = (await manager.post(`/api/customers/${client}/documents?kind=id_front`).set(CSRF).set('Content-Type', 'application/pdf').send(SCAN).expect(201)).body;
    // …cannot be attached as "receipt" by someone else to download it.
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'office', amountCents: 100, method: 'cash', receiptFileId: scan.file.id }).expect(400);
    const own = (await employee.post('/api/cash/expenses/receipt').set(CSRF).set('Content-Type', 'application/pdf').send(PDF).expect(201)).body;
    const e = (await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'office', amountCents: 100, method: 'cash', receiptFileId: own.fileId }).expect(201)).body;
    const f = await employee.get(`/api/cash/expenses/${e.id}/receipt`).expect(200);
    expect(Buffer.compare(f.body, PDF)).toBe(0);
  });
});

describe('cash closing', () => {
  it('expected cash = cash in − cash out; cheques and cards apart; closing once, with a reason for any difference', async () => {
    const k = await openContract([
      { kind: 'rental', method: 'cash', amountCents: 50000 },
      { kind: 'deposit_in', method: 'cheque', amountCents: 300000, reference: 'CHQ 1' },
      { kind: 'deposit_in', method: 'cash', amountCents: 100000 },
    ]);
    await manager.post(`/api/contracts/${k.id}/payments`).set(CSRF).send({ kind: 'deposit_out', method: 'cash', amountCents: 100000 }).expect(201);
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'washing', amountCents: 10000, method: 'cash' }).expect(201);
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'repair', amountCents: 90000, method: 'transfer' }).expect(201);
    const day = (await employee.get(`/api/cash/day?branchId=${cas}`).expect(200)).body;
    expect(day.expectedCashCents).toBe(50000 + 100000 - 100000 - 10000);
    expect(day.totals.depositIn).toMatchObject({ cheque: 300000, cash: 100000 });
    expect(day.totals.expenses).toMatchObject({ cash: 10000, transfer: 90000 });
    expect(day.movements).toHaveLength(6);
    await employee.get(`/api/cash/day?branchId=${rak}`).expect(403);

    await employee.post('/api/cash/close').set(CSRF).send({ branchId: cas, date: today(), countedCashCents: 40000 }).expect(403); // cash.close: manager / delegated
    await manager.post('/api/cash/close').set(CSRF).send({ branchId: cas, date: today(), countedCashCents: 39000 }).expect(400); // difference needs a reason
    const c = (await manager.post('/api/cash/close').set(CSRF).send({ branchId: cas, date: today(), countedCashCents: 39000, notes: 'Pièce de 10 DH manquante' }).expect(201)).body;
    expect(c).toEqual({ expectedCashCents: 40000, differenceCents: -1000 });
    await manager.post('/api/cash/close').set(CSRF).send({ branchId: cas, date: today(), countedCashCents: 40000 }).expect(409);
    await manager.post('/api/cash/close').set(CSRF).send({ branchId: cas, date: at(2).slice(0, 10), countedCashCents: 0 }).expect(400);
    // A movement after the closing is visible as a change since the closing.
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'parking', amountCents: 500, method: 'cash' }).expect(201);
    const after = (await employee.get(`/api/cash/day?branchId=${cas}`).expect(200)).body;
    expect(after.closing).toMatchObject({ countedCashCents: 39000, differenceCents: -1000, changedSince: true });
    expect((await employee.get('/api/cash/closings').expect(200)).body.items).toHaveLength(1);
    await expect(ctx.pool.query('UPDATE cash_closings SET counted_cash_cents = 0')).rejects.toThrow(/append-only/);
  });
});

describe('maintenance by km and date (BR-16)', () => {
  it('plans become soon/due from the vehicle mileage or the date; recording the work resets them and books the expense', async () => {
    const months = new Date(Date.now() - 7 * 30 * 86400_000).toISOString().slice(0, 10);
    const oil = (await manager.post(`/api/maintenance/vehicles/${car}/plans`).set(CSRF).send({ item: 'oil_change', intervalKm: 1500, lastDoneKm: 0 }).expect(201)).body.id;
    await manager.post(`/api/maintenance/vehicles/${car}/plans`).set(CSRF).send({ item: 'general_service', intervalMonths: 6, lastDoneOn: months }).expect(201);
    await manager.post(`/api/maintenance/vehicles/${car}/plans`).set(CSRF).send({ item: 'oil_change', intervalKm: 1000 }).expect(409);
    await manager.post(`/api/maintenance/vehicles/${car}/plans`).set(CSRF).send({ item: 'brakes' }).expect(400);
    await employee.post(`/api/maintenance/vehicles/${car}/plans`).set(CSRF).send({ item: 'tyres', intervalKm: 40000 }).expect(403);
    expect((await employee.get('/api/maintenance/summary').expect(200)).body).toEqual({ due: 1, soon: 1 });
    const due = (await employee.get('/api/maintenance/due').expect(200)).body.items;
    expect(due.map((p: { item: string; status: string }) => [p.item, p.status])).toEqual([['general_service', 'due'], ['oil_change', 'soon']]);
    expect(due[1].kmLeft).toBe(500);

    await manager.post(`/api/maintenance/vehicles/${car}/records`).set(CSRF).send({ planId: oil, item: 'oil_change', doneOn: at(1).slice(0, 10), km: 1000 }).expect(400); // future
    await manager.post(`/api/maintenance/vehicles/${car}/records`).set(CSRF).send({ planId: oil, item: 'oil_change', doneOn: today(), km: 1000, garage: 'Garage Démo', costCents: 40000, paidWith: 'cash' }).expect(201);
    const v = (await employee.get(`/api/maintenance/vehicles/${car}`).expect(200)).body;
    expect(v.plans.find((p: { item: string }) => p.item === 'oil_change')).toMatchObject({ status: 'ok', nextKm: 2500, kmLeft: 1500 });
    expect(v.records[0]).toMatchObject({ item: 'oil_change', km: 1000, garage: 'Garage Démo', costCents: 40000 });
    expect(v.records[0].expenseId).toBeTruthy();
    const exp = (await manager.get('/api/cash/expenses').expect(200)).body.items;
    expect(exp[0]).toMatchObject({ category: 'maintenance', amountCents: 40000, method: 'cash', vehicle: { id: car } });
    expect((await employee.get('/api/maintenance/summary').expect(200)).body).toEqual({ due: 1, soon: 0 });
    await expect(ctx.pool.query('DELETE FROM maintenance_records')).rejects.toThrow(/append-only/);
  });
});

describe('WhatsApp reminders (wa.me, sent by a person — D-016)', () => {
  it('prepares the message in the customer language with a wa.me link; only a person confirms it was sent', async () => {
    await ctx.pool.query(`UPDATE customers SET licence_expiry = (now() + interval '1 day')::date WHERE id = $1`, [client]);
    const r = (await employee.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId: car, start: at(1, 9), end: at(4, 9) }).expect(201)).body.reservation;
    const items = (await employee.get('/api/reminders').expect(200)).body.items;
    const pickup = items.find((x: { kind: string }) => x.kind === 'pickup');
    expect(pickup.text).toMatch(/^مرحباً Client Démo، Location Démo/);
    expect(pickup.link.startsWith('https://wa.me/212600000001?text=')).toBe(true);
    expect(decodeURIComponent(pickup.link.split('text=')[1])).toBe(pickup.text);
    expect(pickup.lastSentAt).toBeNull();
    expect(items.find((x: { kind: string }) => x.kind === 'customer_document').text).toMatch(/رخصة السياقة/);
    await employee.post('/api/reminders/sent').set(CSRF).send({ kind: 'pickup', refId: r.id }).expect(201);
    expect((await employee.get('/api/reminders').expect(200)).body.items.find((x: { kind: string }) => x.kind === 'pickup').lastSentAt).toBeTruthy();
    expect(await auditRows(ctx.pool, 'reminder.sent')).toHaveLength(1);
    // Another branch's booking cannot be marked.
    const rakCar = await readyVehicle(rak, '99992-أ-1');
    const rr = (await manager.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId: rakCar, start: at(1, 9), end: at(2, 9) }).expect(201)).body.reservation;
    await employee.post('/api/reminders/sent').set(CSRF).send({ kind: 'pickup', refId: rr.id }).expect(404);
  });
});

describe('reports', () => {
  it('income = rent paid + deposits kept; deposits received are not income; expenses by category; CSV for the accountant', async () => {
    const k = await openContract([
      { kind: 'rental', method: 'cash', amountCents: 50000 },
      { kind: 'rental', method: 'transfer', amountCents: 40000 },
      { kind: 'deposit_in', method: 'cheque', amountCents: 300000 },
    ]);
    await manager.post(`/api/contracts/${k.id}/payments`).set(CSRF).send({ kind: 'deposit_kept', method: 'cheque', amountCents: 20000, reason: 'Rayure' }).expect(201);
    await employee.post('/api/cash/expenses').set(CSRF).send({ branchId: cas, category: 'fuel', amountCents: 15000, method: 'cash', supplier: '=HYPERLINK("x")' }).expect(201);
    const q = `from=${today()}&to=${today()}`;
    await employee.get(`/api/reports/summary?${q}`).expect(403);
    const s = (await manager.get(`/api/reports/summary?${q}`).expect(200)).body;
    expect(s.income).toEqual({ rentalByMethod: { cash: 50000, transfer: 40000 }, rentalCents: 90000, depositKeptCents: 20000, totalCents: 110000 });
    expect(s.deposits).toMatchObject({ receivedCents: 300000, keptCents: 20000 });
    expect(s.expenses).toEqual({ byCategory: { fuel: 15000 }, totalCents: 15000 });
    expect(s.resultCents).toBe(95000);
    expect(s.contracts).toMatchObject({ count: 1, outstandingCents: 90000 - 90000 + (s.contracts.billedCents - 90000) });
    expect(s.fleet[0].utilisation).toBeGreaterThan(0);
    const csv = await manager.get(`/api/reports/export.csv?type=expenses&${q}`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    const pays = await manager.get(`/api/reports/export.csv?type=payments&${q}`).expect(200);
    expect(pays.text.split('\r\n').filter(Boolean)).toHaveLength(1 + 4);
    expect(csvCell('-2+3')).toBe("'-2+3");
  });
});
