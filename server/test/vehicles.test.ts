import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { plateKey } from '../src/domain/plates.js';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

describe('plate search key', () => {
  it.each([
    ['12345-أ-6', '12345ا6'],
    ['12345 أ 6', '12345ا6'],
    ['12345|أ|6', '12345ا6'],
    ['١٢٣٤٥-أ-٦', '12345ا6'],
    ['12345-ا-6', '12345ا6'],
    ['99994-هـ-1', '99994ه1'],
    ['ww-123-456', 'WW123456'],
  ])('%s -> %s', (input, key) => {
    expect(plateKey(input)).toBe(key);
  });

  it('does not transliterate Arabic letters to Latin (no unapproved mapping)', () => {
    expect(plateKey('12345-ب-6')).not.toBe(plateKey('12345-B-6'));
  });
});

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent; // assigned to branch CAS only
let employeeId: string;
let cas: string;
let rak: string;

const vehicleBody = (branchId: string, plate: string, extra: Record<string, unknown> = {}) => ({
  branchId,
  plate,
  make: 'Dacia',
  model: 'Logan',
  fuelType: 'diesel',
  transmission: 'manual',
  mileageKm: 10000,
  ...extra,
});

async function createVehicle(branchId: string, plate: string, extra: Record<string, unknown> = {}) {
  const res = await manager.post('/api/vehicles').set(CSRF).send(vehicleBody(branchId, plate, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; status: string; mileageKm: number };
}

const move = (agent: TestAgent, id: string, body: Record<string, unknown>) =>
  agent.post(`/api/vehicles/${id}/transitions`).set(CSRF).send(body);

/** Brings a new vehicle (inspection_pending) to available through a real inspection. */
async function makeAvailable(id: string, km = 10000) {
  await move(manager, id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: km, fuelEighths: 8 }).expect(200);
}

beforeAll(async () => {
  ctx = await setupTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee' });
  employeeId = e.id;
  manager = await loginAgent(ctx.app, m.email, m.password);
  cas = (await manager.post('/api/branches').set(CSRF).send({ code: 'CAS', name: 'Agence Casablanca', city: 'Casablanca' }).expect(201)).body.id;
  rak = (await manager.post('/api/branches').set(CSRF).send({ code: 'RAK', name: 'Agence Marrakech', city: 'Marrakech' }).expect(201)).body.id;
  await manager.put(`/api/users/${employeeId}/branches`).set(CSRF).send({ branchIds: [cas] }).expect(204);
  employee = await loginAgent(ctx.app, e.email, e.password);
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('branches', () => {
  it('manager creates and edits branches; duplicate codes are refused', async () => {
    await manager.post('/api/branches').set(CSRF).send({ code: 'cas', name: 'X', city: 'Y' }).expect(409);
    const res = await manager.put(`/api/branches/${rak}`).set(CSRF).send({ code: 'RAK', name: 'Agence Marrakech Gueliz', city: 'Marrakech' }).expect(200);
    expect(res.body.name).toBe('Agence Marrakech Gueliz');
    expect((await auditRows(ctx.pool, 'branch.update')).at(-1).metadata.changes.name.to).toBe('Agence Marrakech Gueliz');
  });

  it('employees cannot manage branches and only see their own', async () => {
    await employee.post('/api/branches').set(CSRF).send({ code: 'TNG', name: 'X', city: 'Tanger' }).expect(403);
    const list = await employee.get('/api/branches').expect(200);
    expect(list.body.items.map((b: { code: string }) => b.code)).toEqual(['CAS']);
    const all = await manager.get('/api/branches').expect(200);
    expect(all.body.items).toHaveLength(2);
  });
});

describe('vehicles: creation, plates and search', () => {
  it('a new vehicle starts in inspection_pending with a history entry and an audit record', async () => {
    const v = await createVehicle(cas, '12345-أ-6');
    expect(v.status).toBe('inspection_pending');
    const detail = await manager.get(`/api/vehicles/${v.id}`).expect(200);
    expect(detail.body.history).toHaveLength(1);
    expect(detail.body.history[0]).toMatchObject({ from: null, to: 'inspection_pending', mileageKm: 10000, reason: null });
    expect(await auditRows(ctx.pool, 'vehicle.create')).toHaveLength(1);
  });

  it('the same plate typed differently is a duplicate', async () => {
    await createVehicle(cas, '12345-أ-6');
    const dup = await manager.post('/api/vehicles').set(CSRF).send(vehicleBody(rak, '12345 أ 6'));
    expect(dup.status).toBe(409);
  });

  it('search finds a plate however it is typed, and by model', async () => {
    await createVehicle(cas, '12345-أ-6');
    await createVehicle(cas, '67890-ب-1', { make: 'Renault', model: 'Clio' });
    for (const q of ['12345', '12345 أ 6', '12345|ا|6', '١٢٣٤٥']) {
      const res = await manager.get('/api/vehicles').query({ q }).expect(200);
      expect(res.body.items.map((v: { plate: string }) => v.plate), q).toEqual(['12345-أ-6']);
    }
    const byModel = await manager.get('/api/vehicles').query({ q: 'clio' }).expect(200);
    expect(byModel.body.items).toHaveLength(1);
    const wildcard = await manager.get('/api/vehicles').query({ q: '%' }).expect(200);
    expect(wildcard.body.items).toHaveLength(0);
  });

  it('validates input and refuses unknown fields such as status or mileage edits', async () => {
    await manager.post('/api/vehicles').set(CSRF).send(vehicleBody(cas, 'x')).expect(400);
    await manager.post('/api/vehicles').set(CSRF).send(vehicleBody(cas, '11111-أ-1', { fuelType: 'kerosene' })).expect(400);
    await manager.post('/api/vehicles').set(CSRF).send(vehicleBody(cas, '11111-أ-1', { status: 'available' })).expect(400);
    const v = await createVehicle(cas, '11111-أ-1');
    const { mileageKm: _km, ...editable } = vehicleBody(cas, '11111-أ-1');
    await manager.put(`/api/vehicles/${v.id}`).set(CSRF).send({ ...editable, mileageKm: 1 }).expect(400);
    const ok = await manager.put(`/api/vehicles/${v.id}`).set(CSRF).send({ ...editable, color: 'Blanc' }).expect(200);
    expect(ok.body.color).toBe('Blanc');
  });
});

describe('vehicles: branch scope', () => {
  it('an employee only sees and acts on vehicles of their branches', async () => {
    const own = await createVehicle(cas, '11111-أ-1');
    const other = await createVehicle(rak, '22222-ب-2');
    const list = await employee.get('/api/vehicles').expect(200);
    expect(list.body.items.map((v: { id: string }) => v.id)).toEqual([own.id]);
    await employee.get(`/api/vehicles/${other.id}`).expect(404);
    await move(employee, other.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 10000, fuelEighths: 4 }).expect(404);
    const summary = await employee.get('/api/vehicles/summary').expect(200);
    expect(summary.body.total).toBe(1);
  });

  it('REVIEW CASE: direct API access by ID to another branch\'s vehicle is refused for every endpoint', async () => {
    const other = await createVehicle(rak, '22222-ب-2');
    // Even with vehicles.manage delegated, the branch scope still applies.
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.manage'] }).expect(204);
    const { mileageKm: _km, ...editable } = vehicleBody(rak, '22222-ب-2');
    await employee.get(`/api/vehicles/${other.id}`).expect(404);
    await employee.put(`/api/vehicles/${other.id}`).set(CSRF).send(editable).expect(403);
    await employee.put(`/api/vehicles/${other.id}`).set(CSRF).send({ ...editable, branchId: cas }).expect(404);
    await move(employee, other.id, { to: 'maintenance', expectedStatus: 'inspection_pending', reason: 'x' }).expect(404);
    await employee.get('/api/vehicles').query({ branchId: rak }).expect(200).then((r) => expect(r.body.items).toHaveLength(0));
    const unchanged = await manager.get(`/api/vehicles/${other.id}`).expect(200);
    expect(unchanged.body.vehicle).toMatchObject({ status: 'inspection_pending', branch: { id: rak } });
  });

  it('an employee without any branch sees nothing', async () => {
    await createVehicle(cas, '11111-أ-1');
    await manager.put(`/api/users/${employeeId}/branches`).set(CSRF).send({ branchIds: [] }).expect(204);
    const res = await employee.get('/api/vehicles').expect(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('employees cannot create vehicles unless the manager grants vehicles.manage, and only in their branches', async () => {
    await employee.post('/api/vehicles').set(CSRF).send(vehicleBody(cas, '11111-أ-1')).expect(403);
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.manage'] }).expect(204);
    await employee.post('/api/vehicles').set(CSRF).send(vehicleBody(cas, '11111-أ-1')).expect(201);
    await employee.post('/api/vehicles').set(CSRF).send(vehicleBody(rak, '22222-ب-2')).expect(403);
  });
});

describe('vehicles: lifecycle (owner-reviewed state model)', () => {
  it('inspection requires mileage and fuel, records cleaning, and makes the vehicle available', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await move(employee, v.id, { to: 'available', expectedStatus: 'inspection_pending' }).expect(400);
    const res = await move(employee, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 10050, fuelEighths: 6, cleaned: true }).expect(200);
    expect(res.body.vehicle).toMatchObject({ status: 'available', mileageKm: 10050, fuelEighths: 6 });
    const detail = await manager.get(`/api/vehicles/${v.id}`).expect(200);
    expect(detail.body.history[0]).toMatchObject({ from: 'inspection_pending', to: 'available', cleaned: true, fuelEighths: 6 });
  });

  it('mileage cannot go down, except by a vehicles.admin user with a reason', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    const low = await move(employee, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 9000, fuelEighths: 4 });
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('mileage_decrease');
    await move(manager, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 9000, fuelEighths: 4 }).expect(422);
    await move(manager, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 9000, fuelEighths: 4, reason: 'Erreur de saisie à la création' }).expect(200);
    const audit = (await auditRows(ctx.pool, 'vehicle.status_change')).at(-1);
    expect(audit.metadata.mileageCorrected).toBe(true);
  });

  it('after maintenance the vehicle goes back to inspection, never straight to available', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await makeAvailable(v.id);
    await move(manager, v.id, { to: 'maintenance', expectedStatus: 'available' }).expect(400); // reason required
    await move(manager, v.id, { to: 'maintenance', expectedStatus: 'available', reason: 'Vidange' }).expect(200);
    const direct = await move(manager, v.id, { to: 'available', expectedStatus: 'maintenance' });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('invalid_transition');
    await move(manager, v.id, { to: 'inspection_pending', expectedStatus: 'maintenance' }).expect(200);
    await move(employee, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 10010, fuelEighths: 8 }).expect(200);
  });

  it('an employee may send a returned car to maintenance, but planned maintenance needs the delegated right', async () => {
    const a = await createVehicle(cas, '11111-أ-1');
    await move(employee, a.id, { to: 'maintenance', expectedStatus: 'inspection_pending', reason: 'Pneu crevé' }).expect(200);
    const b = await createVehicle(cas, '22222-ب-2');
    await makeAvailable(b.id);
    await move(employee, b.id, { to: 'maintenance', expectedStatus: 'available', reason: 'Vidange' }).expect(403);
    expect((await auditRows(ctx.pool, 'authz.denied')).at(-1).metadata.transition).toBe('available->maintenance');
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.maintenance'] }).expect(204);
    await move(employee, b.id, { to: 'maintenance', expectedStatus: 'available', reason: 'Vidange' }).expect(200);
  });

  it('unblocking goes through inspection; retiring only from out_of_service; retired is final', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await makeAvailable(v.id);
    await move(employee, v.id, { to: 'out_of_service', expectedStatus: 'available', reason: 'Assurance expirée' }).expect(403);
    await move(manager, v.id, { to: 'out_of_service', expectedStatus: 'available', reason: 'Assurance expirée' }).expect(200);
    await move(manager, v.id, { to: 'available', expectedStatus: 'out_of_service', reason: 'x' }).expect(409);
    await move(manager, v.id, { to: 'inspection_pending', expectedStatus: 'out_of_service', reason: 'Assurance renouvelée' }).expect(200);
    await move(manager, v.id, { to: 'out_of_service', expectedStatus: 'inspection_pending', reason: 'Vendue' }).expect(200);
    await move(manager, v.id, { to: 'retired', expectedStatus: 'out_of_service', reason: 'Vendue' }).expect(200);
    const { mileageKm: _km, ...editable } = vehicleBody(cas, '11111-أ-1');
    await manager.put(`/api/vehicles/${v.id}`).set(CSRF).send(editable).expect(409);
    await move(manager, v.id, { to: 'inspection_pending', expectedStatus: 'retired', reason: 'x' }).expect(409);
    // The plate can be used again by a new vehicle once the old one is retired; history stays.
    await createVehicle(cas, '11111-أ-1');
    const hist = await manager.get(`/api/vehicles/${v.id}`).expect(200);
    expect(hist.body.history.length).toBe(6);
  });

  it('rented and check-in transitions are reserved for the rental workflow', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await makeAvailable(v.id);
    const res = await move(manager, v.id, { to: 'rented', expectedStatus: 'available' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workflow_only');
  });

  it('a stale screen (expectedStatus differs) is refused', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await makeAvailable(v.id);
    const res = await move(employee, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 10001, fuelEighths: 8 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('stale_status');
  });

  it('two people acting on the same car at the same moment: exactly one succeeds', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    const results = await Promise.all([
      move(employee, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 10020, fuelEighths: 8 }),
      move(manager, v.id, { to: 'maintenance', expectedStatus: 'inspection_pending', reason: 'Bruit moteur' }),
      move(manager, v.id, { to: 'available', expectedStatus: 'inspection_pending', mileageKm: 10030, fuelEighths: 7 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const detail = await manager.get(`/api/vehicles/${v.id}`).expect(200);
    expect(detail.body.history).toHaveLength(2);
  });

  it('allowedTransitions reflects the user and the state', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    const asEmployee = await employee.get(`/api/vehicles/${v.id}`).expect(200);
    expect(asEmployee.body.allowedTransitions.map((t: { to: string }) => t.to).sort()).toEqual(['available', 'maintenance']);
    const asManager = await manager.get(`/api/vehicles/${v.id}`).expect(200);
    expect(asManager.body.allowedTransitions.map((t: { to: string }) => t.to).sort()).toEqual(['available', 'maintenance', 'out_of_service']);
  });
});

describe('vehicles: database-level protection', () => {
  it('the database refuses an invalid status jump even from raw SQL', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await expect(ctx.pool.query(`UPDATE vehicles SET status = 'rented' WHERE id = $1`, [v.id])).rejects.toThrow(/not allowed/);
    await expect(
      ctx.pool.query(
        `INSERT INTO vehicles (branch_id, plate, plate_key, make, model, fuel_type, transmission, status)
         VALUES ($1, 'X1', 'X1', 'A', 'B', 'diesel', 'manual', 'available')`,
        [cas],
      ),
    ).rejects.toThrow(/inspection_pending/);
  });

  it('status history is append-only and vehicles cannot be deleted while they have history', async () => {
    const v = await createVehicle(cas, '11111-أ-1');
    await expect(ctx.pool.query('DELETE FROM vehicle_status_history')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query(`UPDATE vehicle_status_history SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM vehicles WHERE id = $1', [v.id])).rejects.toThrow();
  });
});

describe('permission grants', () => {
  it('only delegable permissions can be granted, changes apply immediately and are audited', async () => {
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['users.manage'] }).expect(400);
    await employee.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.admin'] }).expect(403);
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.admin'] }).expect(204);
    const me = await employee.get('/api/auth/me').expect(200);
    expect(me.body.permissions).toContain('vehicles.admin');
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: [] }).expect(204);
    const after = await employee.get('/api/auth/me').expect(200);
    expect(after.body.permissions).not.toContain('vehicles.admin');
    const audit = await auditRows(ctx.pool, 'user.grants_update');
    expect(audit.map((a) => a.metadata.to)).toEqual([['vehicles.admin'], []]);
  });

  it('a user can only delegate permissions they hold themselves', async () => {
    // A second manager whose role permission was removed in the database (simulated) cannot grant it.
    const m2 = await createUser(ctx.pool, { email: 'm2@example.test', role: 'manager' });
    const agent = await loginAgent(ctx.app, m2.email, m2.password);
    await ctx.pool.query(`DELETE FROM role_permissions WHERE role_code = 'manager' AND permission_code = 'vehicles.admin'`);
    const res = await agent.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.admin'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('cannot_delegate');
    await agent.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.manage'] }).expect(204);
  });

  it('lists the delegable permissions and shows grants and branches in the user list', async () => {
    const g = await manager.get('/api/users/grantable-permissions').expect(200);
    expect(g.body.items.map((p: { code: string }) => p.code)).toEqual(['branches.all', 'customers.block', 'customers.verify', 'pricing.change', 'vehicles.admin', 'vehicles.documents', 'vehicles.maintenance', 'vehicles.manage']);
    await manager.put(`/api/users/${employeeId}/grants`).set(CSRF).send({ permissions: ['vehicles.manage'] }).expect(204);
    const users = await manager.get('/api/users').expect(200);
    const e = users.body.items.find((u: { id: string }) => u.id === employeeId);
    expect(e).toMatchObject({ branchIds: [cas], grants: ['vehicles.manage'] });
  });

  it('unauthenticated access to vehicles is refused', async () => {
    await request(ctx.app).get('/api/vehicles').expect(401);
  });
});
