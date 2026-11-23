import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

// RC-03 (#26): after a paid late fee is waived, the customer has paid too much. The manager
// gives back the exact difference as ONE refund entry linked to the original rental receipt.
// Synthetic data only.

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;
let cas: string;
let client: string;
let employeeId: string;

const at = (days: number, hour = 10) => {
  const d = new Date(Date.now() + days * 86400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });

async function vehicle(plate: string, dailyRateCents = 10000) {
  const v = await manager.post('/api/vehicles').set(CSRF)
    .send({ branchId: cas, plate, make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', mileageKm: 1000, dailyRateCents, depositCents: 50000 })
    .expect(201);
  await manager.post(`/api/vehicles/${v.body.id}/transitions`).set(CSRF)
    .send({ to: 'available', expectedStatus: 'inspection_pending', mileageKm: 1000, fuelEighths: 8, cleaned: true }).expect(200);
  return v.body.id as string;
}

/** Rent 100.00 for one day, deposit 500.00 cash, returned 2 h late, fee 20.00 charged and paid in one receipt of 120.00. */
async function paidLateFee(plate: string, method: 'cash' | 'transfer' = 'cash') {
  const v = await vehicle(plate);
  const r = (await employee.post('/api/reservations').set(CSRF).send({ customerId: client, vehicleId: v, start: at(0, 0), end: at(0, 23) }).expect(201)).body.reservation;
  const k = (await employee.post('/api/contracts/checkout').set(CSRF)
    .send({ reservationId: r.id, kmOut: 1000, fuelOut: 8, washedOut: true, documentsOut: ['Carte grise'], payments: [{ kind: 'deposit_in', method: 'cash', amountCents: 50000 }] })
    .expect(201)).body.contract;
  await ctx.pool.query(`UPDATE contracts SET out_at = now() - interval '2 days', planned_end_at = now() - interval '2 hours' WHERE id = $1`, [k.id]);
  await employee.post(`/api/contracts/${k.id}/checkin`).set(CSRF).send({ kmIn: 1100, fuelIn: 8 }).expect(200);
  await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'charge', unit: 'hour', quantity: 1, unitCents: 2000 }).expect(200);
  await manager.post(`/api/contracts/${k.id}/payments`).set(CSRF).send({ kind: 'rental', method, amountCents: k.totalCents + 2000 }).expect(201);
  const detail = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body;
  const receipt = detail.payments.find((p: { kind: string }) => p.kind === 'rental');
  return { k, receipt };
}

/** Parse the accountant payments CSV into rows keyed by header (amounts back to cents). */
async function paymentsCsv(from = today(), to = from) {
  const res = await manager.get(`/api/reports/export.csv?type=payments&from=${from}&to=${to}`).expect(200);
  const [header, ...lines] = res.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  const cols = header!.split(';');
  const cell = (v: string) => v.replace(/^"|"$/g, '').replace(/""/g, '"').replace(/^'/, '');
  return lines.map((l) => {
    const vals = l.split(';').map(cell);
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    return { ...row, cents: Math.round(Number(row['Montant MAD']!.replace(',', '.')) * 100) } as Record<string, string> & { cents: number };
  });
}
const sumBy = (rows: Array<Record<string, string> & { cents: number }>, heading: string) =>
  rows.filter((r) => r.Rubrique === heading).reduce((a, r) => a + r.cents, 0);
const refund = (agent: TestAgent, contractId: string, paymentId: string, body: Record<string, unknown>) =>
  agent.post(`/api/contracts/${contractId}/payments/${paymentId}/refund`).set(CSRF).send(body);

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager', fullName: 'TEST Gérant' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee', fullName: 'TEST Employé' });
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'TEST Casablanca', city: 'Casablanca' })).body.id;
  await manager.put(`/api/users/${e.id}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
  employeeId = e.id;
  client = (await manager.post('/api/customers').set(CSRF)
    .send({ fullName: 'TEST Client 01', phone: '0600000001', birthDate: '1990-01-01', idDocType: 'cin', idDocNumber: 'TEST000001', licenceNumber: 'TEST-L-1', licenceIssueDate: '2015-01-01' })
    .expect(201)).body.customer.id;
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('RC-03 partial rental refund after a paid late fee is waived', () => {
  it('refunds exactly the overpaid 20.00 as one entry linked to the receipt; deposit untouched; audited', async () => {
    const { k, receipt } = await paidLateFee('TEST-01-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST geste commercial' }).expect(200);
    const before = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body.balances;
    expect(before).toMatchObject({ totalCents: 10000, paidCents: 12000, restCents: -2000, overpaidCents: 2000 });

    const res = (await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Remise de la pénalité annulée' }).expect(201)).body;
    expect(res.balances).toMatchObject({
      totalCents: 10000, paidCents: 10000, restCents: 0, overpaidCents: 0,
      depositReceivedCents: 50000, depositReturnedCents: 0, depositKeptCents: 0, depositHeldCents: 50000,
    });
    const detail = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body;
    const refunds = detail.payments.filter((p: { kind: string }) => p.kind === 'rental_refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountCents: 2000, method: 'cash', refundsId: receipt.id });
    expect(await auditRows(ctx.pool, 'payment.refund')).toHaveLength(1);
    await expect(ctx.pool.query('UPDATE payments SET amount_cents = 1')).rejects.toThrow(/append-only/);
  });

  it('a repeated refund is rejected once nothing is left to give back; partial refunds add up exactly', async () => {
    const { k, receipt } = await paidLateFee('TEST-02-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(manager, k.id, receipt.id, { amountCents: 2001, method: 'cash', reason: 'Trop' }).expect(409);
    await refund(manager, k.id, receipt.id, { amountCents: 1234, method: 'cash', reason: 'Première partie' }).expect(201);
    const second = (await refund(manager, k.id, receipt.id, { amountCents: 766, method: 'cash', reason: 'Reste' }).expect(201)).body.balances;
    expect(second).toMatchObject({ paidCents: 10000, restCents: 0, overpaidCents: 0 });
    const again = await refund(manager, k.id, receipt.id, { amountCents: 766, method: 'cash', reason: 'Rejeu' }).expect(409);
    expect(again.body.error.code).toBe('nothing_to_refund');
  });

  it('cannot refund while nothing is overpaid, nor from a deposit or reversal entry; method must be cash or transfer', async () => {
    const { k, receipt } = await paidLateFee('TEST-03-A');
    expect((await refund(manager, k.id, receipt.id, { amountCents: 100, method: 'cash', reason: 'Pas de trop-perçu' }).expect(409)).body.error.code).toBe('nothing_to_refund');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    const detail = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body;
    const deposit = detail.payments.find((p: { kind: string }) => p.kind === 'deposit_in');
    expect((await refund(manager, k.id, deposit.id, { amountCents: 2000, method: 'cash', reason: 'Mauvaise ligne' }).expect(409)).body.error.code).toBe('not_a_rental_receipt');
    await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'card', reason: 'Carte' }).expect(400);
    await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash' }).expect(400); // a reason is required
  });

  it('only a manager may give money back', async () => {
    const { k, receipt } = await paidLateFee('TEST-04-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(employee, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Employé' }).expect(403);
    expect(await auditRows(ctx.pool, 'payment.refund')).toHaveLength(0);
  });

  it('the cash of the day and the reports count the refund as money going out', async () => {
    const { k, receipt } = await paidLateFee('TEST-05-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Pénalité annulée' }).expect(201);
    const day = (await manager.get(`/api/cash/day?branchId=${cas}`).expect(200)).body;
    expect(day.expectedCashCents).toBe(12000 + 50000 - 2000); // rental cash in, deposit cash in, refund cash out
    const s = (await manager.get(`/api/reports/summary?from=${today()}&to=${today()}`).expect(200)).body;
    expect(s.income).toMatchObject({ rentalByMethod: { cash: 10000 }, rentalCents: 10000, totalCents: 10000 });
    expect(s.contracts.outstandingCents).toBe(0);
  });

  it('a refund can be corrected by reversal; the receipt it refunds cannot be reversed while the refund stands', async () => {
    const { k, receipt } = await paidLateFee('TEST-06-A', 'transfer');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'transfer', reason: 'Virement retour' }).expect(201);
    expect((await manager.post(`/api/contracts/${k.id}/payments/${receipt.id}/reverse`).set(CSRF).send({ reason: 'Erreur' }).expect(409)).body.error.code).toBe('refunded_receipt');
    const detail = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body;
    const r = detail.payments.find((p: { kind: string }) => p.kind === 'rental_refund');
    const back = (await manager.post(`/api/contracts/${k.id}/payments/${r.id}/reverse`).set(CSRF).send({ reason: 'Remboursement saisi par erreur' }).expect(201)).body.balances;
    expect(back).toMatchObject({ paidCents: 12000, restCents: -2000, overpaidCents: 2000 });
  });
  it('two refunds of the same overpaid amount sent at the same instant: exactly one goes through', async () => {
    const { k, receipt } = await paidLateFee('TEST-07-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    const [a, b] = await Promise.all([
      refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Clic 1' }),
      refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Clic 2' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const detail = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body;
    expect(detail.payments.filter((p: { kind: string }) => p.kind === 'rental_refund')).toHaveLength(1);
    expect(detail.balances).toMatchObject({ paidCents: 10000, restCents: 0, overpaidCents: 0 });
  });
  it('the accountant CSV is signed by direction and reconciles with the report, the cash day and the balances', async () => {
    const { k, receipt } = await paidLateFee('TEST-08-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Pénalité annulée' }).expect(201);
    let rows = await paymentsCsv();
    const s = (await manager.get(`/api/reports/summary?from=${today()}&to=${today()}`).expect(200)).body;
    expect(sumBy(rows, 'Location')).toBe(10000);                                   // 120 in − 20 refunded
    expect(sumBy(rows, 'Location')).toBe(s.income.rentalCents);
    expect(sumBy(rows, 'Caution')).toBe(s.deposits.receivedCents - s.deposits.returnedCents);
    expect(sumBy(rows, 'Caution retenue')).toBe(s.income.depositKeptCents);
    const day = (await manager.get(`/api/cash/day?branchId=${cas}`).expect(200)).body;
    const cashRows = rows.filter((r) => r.Mode === 'cash' && r.Rubrique !== 'Caution retenue');
    expect(cashRows.reduce((a, r) => a + r.cents, 0)).toBe(day.expectedCashCents);  // no expenses in this test
    const balances = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body.balances;
    expect(sumBy(rows, 'Location')).toBe(balances.paidCents);
    expect(rows.find((r) => r.Type === 'rental_refund')!.cents).toBe(-2000);

    // Reversing the refund puts the money back: the reversal row is +20.00 and the sums follow.
    const r = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body.payments.find((p: { kind: string }) => p.kind === 'rental_refund');
    await manager.post(`/api/contracts/${k.id}/payments/${r.id}/reverse`).set(CSRF).send({ reason: 'Saisi par erreur' }).expect(201);
    rows = await paymentsCsv();
    expect(rows.find((x) => x.Type === 'reversal' && x.Corrige === 'rental_refund')!.cents).toBe(2000);
    expect(sumBy(rows, 'Location')).toBe(12000);
  });

  it('giving money back stays manager-only: the right cannot be delegated to an employee (D-052 condition)', async () => {
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['payments.refund'] }).expect(400);
    const { k, receipt } = await paidLateFee('TEST-09-A');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(employee, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Employé' }).expect(403);
  });
});

/* ---------- Astra P2 (#37): the four views after a REVERSED refund, same day and across days ---------- */

const dayBefore = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);

/**
 * The four views an accountant compares, re-fetched: payments CSV, report summary, cash day
 * of each date, and the contract balances. Every equality the books rely on is asserted here.
 */
async function reconcile(contractId: string, from: string, to: string) {
  const rows = await paymentsCsv(from, to);
  const s = (await manager.get(`/api/reports/summary?from=${from}&to=${to}`).expect(200)).body;
  const balances = (await manager.get(`/api/contracts/${contractId}`).expect(200)).body.balances;
  expect(sumBy(rows, 'Location')).toBe(s.income.rentalCents);                                  // CSV = report (rental)
  expect(sumBy(rows, 'Caution')).toBe(s.deposits.receivedCents - s.deposits.returnedCents);     // CSV = report (deposit ledger)
  expect(sumBy(rows, 'Caution retenue')).toBe(s.income.depositKeptCents);
  for (const m of ['cash', 'transfer'] as const) {                                              // CSV = report, per method
    expect(rows.filter((r) => r.Rubrique === 'Location' && r.Mode === m).reduce((a, r) => a + r.cents, 0)).toBe(s.income.rentalByMethod[m] ?? 0);
  }
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) {
    const day = (await manager.get(`/api/cash/day?branchId=${cas}&date=${d}`).expect(200)).body;  // CSV = cash of EACH day
    const cashOfDay = (await paymentsCsv(d)).filter((r) => r.Mode === 'cash' && r.Rubrique !== 'Caution retenue').reduce((a, r) => a + r.cents, 0);
    expect(cashOfDay).toBe(day.expectedCashCents);
    if (day.closing) expect(day.closing.changedSince).toBe(false);                             // a closed day never moves
  }
  return { rows, s, balances };
}

async function backdateContractPayments(contractId: string) {
  await ctx.pool.query('ALTER TABLE payments DISABLE TRIGGER payments_append_only');
  try {
    await ctx.pool.query(`UPDATE payments SET created_at = created_at - interval '1 day' WHERE contract_id = $1`, [contractId]);
  } finally {
    await ctx.pool.query('ALTER TABLE payments ENABLE TRIGGER payments_append_only');
  }
}

describe('RC-03 reconciliation after a refund is reversed (Astra P2)', () => {
  for (const method of ['cash', 'transfer'] as const) {
    it(`same accounting day, ${method}: refund then reversal, deposit returned separately — all four views agree`, async () => {
      const { k, receipt } = await paidLateFee(`TEST-1${method === 'cash' ? 1 : 2}-A`, method);
      await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
      await refund(manager, k.id, receipt.id, { amountCents: 2000, method, reason: 'Pénalité annulée' }).expect(201);
      await manager.post(`/api/contracts/${k.id}/payments`).set(CSRF).send({ kind: 'deposit_out', method: 'cash', amountCents: 50000 }).expect(201);
      let v = await reconcile(k.id, today(), today());
      expect(v.balances).toMatchObject({ paidCents: 10000, overpaidCents: 0, depositHeldCents: 0 });
      expect(sumBy(v.rows, 'Location')).toBe(v.balances.paidCents);

      const r = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body.payments.find((p: { kind: string }) => p.kind === 'rental_refund');
      await manager.post(`/api/contracts/${k.id}/payments/${r.id}/reverse`).set(CSRF).send({ reason: 'Saisi par erreur' }).expect(201);
      v = await reconcile(k.id, today(), today());
      expect(v.balances).toMatchObject({ totalCents: 10000, paidCents: 12000, restCents: -2000, overpaidCents: 2000, depositHeldCents: 0 });
      expect(sumBy(v.rows, 'Location')).toBe(v.balances.paidCents);
      expect(sumBy(v.rows, 'Caution')).toBe(v.balances.depositReceivedCents - v.balances.depositReturnedCents);
      expect(v.s.income.rentalByMethod[method]).toBe(12000);
      const day = (await manager.get(`/api/cash/day?branchId=${cas}`).expect(200)).body;
      expect(day.expectedCashCents).toBe((method === 'cash' ? 12000 : 0) + 50000 - 50000);       // the deposit came in and went back in cash
    });
  }

  it('refund on a CLOSED day, reversal the next day: the closed day does not move; each day and the range reconcile', async () => {
    const { k, receipt } = await paidLateFee('TEST-13-A', 'cash');
    await manager.post(`/api/contracts/${k.id}/late-fee`).set(CSRF).send({ decision: 'waive', reason: 'TEST' }).expect(200);
    await refund(manager, k.id, receipt.id, { amountCents: 2000, method: 'cash', reason: 'Pénalité annulée' }).expect(201);
    await backdateContractPayments(k.id);                       // receipt, deposit and refund now belong to yesterday
    const y = dayBefore(today());
    const yDay = (await manager.get(`/api/cash/day?branchId=${cas}&date=${y}`).expect(200)).body;
    expect(yDay.expectedCashCents).toBe(12000 + 50000 - 2000);
    await manager.post('/api/cash/close').set(CSRF).send({ branchId: cas, date: y, countedCashCents: yDay.expectedCashCents }).expect(201);

    const r = (await manager.get(`/api/contracts/${k.id}`).expect(200)).body.payments.find((p: { kind: string }) => p.kind === 'rental_refund');
    await manager.post(`/api/contracts/${k.id}/payments/${r.id}/reverse`).set(CSRF).send({ reason: 'Saisi par erreur' }).expect(201);

    const yesterday = await reconcile(k.id, y, y);
    expect(sumBy(yesterday.rows, 'Location')).toBe(10000);     // 120 in − 20 refunded, as closed
    const closed = (await manager.get(`/api/cash/day?branchId=${cas}&date=${y}`).expect(200)).body;
    expect(closed.closing).toMatchObject({ expectedCashCents: 60000, countedCashCents: 60000, differenceCents: 0, changedSince: false });
    const todayView = await reconcile(k.id, today(), today());
    expect(todayView.rows).toHaveLength(1);
    expect(todayView.rows[0]).toMatchObject({ Type: 'reversal', Corrige: 'rental_refund', Rubrique: 'Location', cents: 2000 });
    expect((await manager.get(`/api/cash/day?branchId=${cas}`).expect(200)).body.expectedCashCents).toBe(2000);
    const range = await reconcile(k.id, y, today());
    expect(sumBy(range.rows, 'Location')).toBe(12000);
    expect(sumBy(range.rows, 'Location')).toBe(range.balances.paidCents);
    expect(range.balances).toMatchObject({ overpaidCents: 2000, depositHeldCents: 50000 });
  });
});

