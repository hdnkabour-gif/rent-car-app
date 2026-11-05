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
      branchId, plate: '12345-أ-6', make: 'Dacia', model: 'Logan',
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

  it('refuses a catalogue model whose brand/model names do not match the selected names', async () => {
    const model = await ctx.pool.query<{ id: string }>(
      `SELECT m.id FROM vehicle_catalog_models m
        JOIN vehicle_catalog_brands b ON b.id = m.brand_id
        WHERE b.name = 'Dacia' AND m.name = 'Logan'`,
    );
    await manager.post('/api/vehicles').set(CSRF).send({
      branchId, plate: '54321-أ-6', make: 'Renault', model: 'Logan',
      fuelType: 'diesel', transmission: 'manual', mileageKm: 1000,
      catalogModelId: model.rows[0]!.id,
    }).expect(400);
  });

  it('rejects a generation or engine that does not belong to the selected model chain', async () => {
    const model = await ctx.pool.query<{ id: string }>(
      `SELECT m.id FROM vehicle_catalog_models m
        JOIN vehicle_catalog_brands b ON b.id = m.brand_id
        WHERE b.name = 'Dacia' AND m.name = 'Logan'`,
    );
    await manager.post('/api/vehicles').set(CSRF).send({
      branchId, plate: '11111-أ-1', make: 'Dacia', model: 'Logan',
      fuelType: 'diesel', transmission: 'manual', mileageKm: 1000,
      catalogModelId: model.rows[0]!.id,
      catalogGenerationId: 'GEN-KIA-PIC-MA24',
    }).expect(400);
  });
});
