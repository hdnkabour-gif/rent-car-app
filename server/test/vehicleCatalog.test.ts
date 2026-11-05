import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let manager: TestAgent;
let branchId: string;

beforeAll(async () => {
  ctx = await setupTestApp();
});

beforeEach(async () => {
  await resetDatabase(ctx.pool);
  const managerUser = await createUser(ctx.pool, { email: 'catalog-manager@example.test', role: 'manager' });
  manager = await loginAgent(ctx.app, managerUser.email, managerUser.password);
  branchId = (await manager.post('/api/branches').set(CSRF).send({
    code: 'CAT', name: 'Agence Catalogue', city: 'Casablanca',
  }).expect(201)).body.id as string;
});

afterAll(async () => {
  await ctx.pool.end();
});

describe('shared vehicle reference catalogue', () => {
  it('returns the reference catalogue without any fleet or customer records', async () => {
    const response = await manager.get('/api/vehicle-catalog').expect(200);
    expect(response.body.compatibilityIsAdvisory).toBe(true);
    expect(response.body.brands.length).toBeGreaterThanOrEqual(39);
    expect(response.body.models.some((m: { brandName: string; name: string }) => m.brandName === 'Nissan' && m.name === 'Magnite')).toBe(true);
    expect(response.body.generations.length).toBeGreaterThanOrEqual(3);
    expect(response.body.engines.length).toBeGreaterThanOrEqual(5);
    expect(response.body).not.toHaveProperty('vehicles');
    expect(response.body).not.toHaveProperty('customers');
  });

  it('stores optional model, generation and engine reference IDs against a real fleet vehicle', async () => {
    const model = await ctx.pool.query<{ id: string }>(
      `SELECT m.id FROM vehicle_catalog_models m
        JOIN vehicle_catalog_brands b ON b.id = m.brand_id
        WHERE b.name = 'Dacia' AND m.name = 'Logan'`,
    );
    const generation = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM vehicle_catalog_generations WHERE id = 'GEN-DAC-LOG-CUR'`,
    );
    const engine = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM vehicle_catalog_engines WHERE id = 'ENG-DAC-LOG-TCE100-BVM'`,
    );
    expect(model.rowCount).toBe(1);
    expect(generation.rowCount).toBe(1);
    expect(engine.rowCount).toBe(1);

    const created = await manager.post('/api/vehicles').set(CSRF).send({
      branchId, plate: '99991-أ-1', make: 'Dacia', model: 'Logan',
      fuelType: 'petrol', transmission: 'manual', mileageKm: 1000,
      catalogModelId: model.rows[0]!.id,
      catalogGenerationId: generation.rows[0]!.id,
      catalogEngineId: engine.rows[0]!.id,
    }).expect(201);

    const detail = await manager.get(`/api/vehicles/${created.body.id}`).expect(200);
    expect(detail.body.vehicle).toMatchObject({
      catalogModelId: model.rows[0]!.id,
      catalogGenerationId: 'GEN-DAC-LOG-CUR',
      catalogEngineId: 'ENG-DAC-LOG-TCE100-BVM',
      catalogGenerationLabel: 'Nouvelle Logan – gamme actuelle Maroc',
      catalogEngineVersion: 'TCe 100',
    });
  });

  const LOGAN = 'MODEL-DACIA-LOGAN';
  const base = { fuelType: 'diesel', transmission: 'manual', mileageKm: 1000 };
  /** The field the API names as wrong — proves which rule refused the request. */
  const refusedField = (res: { body: { error: { details?: Array<{ path: string }> } } }) => res.body.error.details?.map((d) => d.path);

  it('refuses a catalogue model whose brand/model names do not match the selected names (the mismatch rule, not the id format)', async () => {
    const res = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99992-أ-1', make: 'Renault', model: 'Logan', catalogModelId: LOGAN }).expect(400);
    expect(res.body.error.message).toMatch(/does not match the make and model/);
    expect(refusedField(res)).toEqual(['catalogModelId']);
  });

  it('rejects a generation or engine that does not belong to the selected model chain, naming the wrong field', async () => {
    const wrongGen = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99993-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: LOGAN, catalogGenerationId: 'GEN-KIA-PIC-MA24' }).expect(400);
    expect(refusedField(wrongGen)).toEqual(['catalogGenerationId']);
    const wrongEngine = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99993-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: LOGAN, catalogGenerationId: 'GEN-DAC-LOG-CUR', catalogEngineId: 'ENG-KIA-PIC-10MPI' }).expect(400);
    expect(refusedField(wrongEngine)).toEqual(['catalogEngineId']);
    const engineAlone = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99993-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: LOGAN, catalogEngineId: 'ENG-DAC-LOG-DCI95' }).expect(400);
    expect(refusedField(engineAlone)).toEqual(['catalogGenerationId']);
    const noModel = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99993-أ-1', make: 'Dacia', model: 'Logan', catalogGenerationId: 'GEN-DAC-LOG-CUR' }).expect(400);
    expect(refusedField(noModel)).toEqual(['catalogModelId']);
    const unknown = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99993-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: 'MODEL-DOES-NOT-EXIST' }).expect(400);
    expect(refusedField(unknown)).toEqual(['catalogModelId']);
    const badFormat = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99993-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: "x'; DROP TABLE vehicles;--" }).expect(400);
    expect(refusedField(badFormat)).toEqual(['catalogModelId']);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM vehicles')).rows[0].n).toBe(0);
  });

  it('a vehicle outside the catalogue ("Autre") still works, with no catalogue link', async () => {
    const res = await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99994-أ-1', make: 'Marque Démo', model: 'Modèle Démo', catalogModelId: null }).expect(201);
    const v = (await manager.get(`/api/vehicles/${res.body.id}`).expect(200)).body.vehicle;
    expect(v).toMatchObject({ make: 'Marque Démo', catalogModelId: null, catalogGenerationId: null, catalogEngineId: null });
  });

  it('on update, an omitted catalogue field keeps the link; null clears it; changing the model needs a matching link', async () => {
    const id = (await manager.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99995-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: LOGAN, catalogGenerationId: 'GEN-DAC-LOG-CUR', catalogEngineId: 'ENG-DAC-LOG-DCI95' }).expect(201)).body.id;
    const edit = { branchId, plate: '99995-أ-1', make: 'Dacia', model: 'Logan', fuelType: 'diesel', transmission: 'manual', color: 'Blanc' };
    await manager.put(`/api/vehicles/${id}`).set(CSRF).send(edit).expect(200); // an older client that does not know the fields
    expect((await manager.get(`/api/vehicles/${id}`)).body.vehicle).toMatchObject({ color: 'Blanc', catalogModelId: LOGAN, catalogGenerationId: 'GEN-DAC-LOG-CUR', catalogEngineId: 'ENG-DAC-LOG-DCI95' });
    // Renaming the model while the kept link points to Logan is refused rather than left inconsistent.
    const renamed = await manager.put(`/api/vehicles/${id}`).set(CSRF).send({ ...edit, model: 'Sandero' }).expect(400);
    expect(refusedField(renamed)).toEqual(['catalogModelId']);
    await manager.put(`/api/vehicles/${id}`).set(CSRF).send({ ...edit, model: 'Sandero', catalogModelId: 'MODEL-DACIA-SANDERO', catalogGenerationId: null, catalogEngineId: null }).expect(200);
    expect((await manager.get(`/api/vehicles/${id}`)).body.vehicle).toMatchObject({ model: 'Sandero', catalogModelId: 'MODEL-DACIA-SANDERO', catalogGenerationId: null, catalogEngineId: null });
    await manager.put(`/api/vehicles/${id}`).set(CSRF).send({ ...edit, model: 'Sandero', catalogModelId: null }).expect(200);
    expect((await manager.get(`/api/vehicles/${id}`)).body.vehicle.catalogModelId).toBeNull();
  });

  it('permissions are unchanged: the catalogue is readable with vehicles.read; an employee cannot create vehicles even with a valid link', async () => {
    const e = await createUser(ctx.pool, { email: 'catalog-employee@example.test', role: 'employee' });
    const employee = await loginAgent(ctx.app, e.email, e.password);
    await employee.get('/api/vehicle-catalog').expect(200);
    await employee.post('/api/vehicles').set(CSRF).send({ ...base, branchId, plate: '99996-أ-1', make: 'Dacia', model: 'Logan', catalogModelId: LOGAN }).expect(403);
  });
});
