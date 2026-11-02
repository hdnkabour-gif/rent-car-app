import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDemoSeedable, checkDemoSeedEnv, DEMO_SEED_FLAG } from '../src/db/target-guard.js';
import { insertFictitiousCompany } from '../src/db/demo-fixtures.js';
import { withTransaction } from '../src/db/pool.js';
import { createUser, resetDatabase, RUN_DB, setupTestApp, type TestContext } from './helpers.js';

describe('seed:demo environment checks', () => {
  const ok = { DATABASE_URL: 'postgres://x@host/railway', FLEETORA_DEMO_SEED: DEMO_SEED_FLAG, FLEETORA_DEMO_DATABASE: 'railway' };

  it('accepts only the explicit flag and an explicit database name', () => {
    expect(checkDemoSeedEnv(ok)).toEqual([]);
    expect(checkDemoSeedEnv({ ...ok, FLEETORA_DEMO_SEED: 'yes' }).join()).toMatch(/FLEETORA_DEMO_SEED/);
    expect(checkDemoSeedEnv({ ...ok, FLEETORA_DEMO_SEED: undefined }).join()).toMatch(/FLEETORA_DEMO_SEED/);
    expect(checkDemoSeedEnv({ ...ok, FLEETORA_DEMO_DATABASE: undefined }).join()).toMatch(/FLEETORA_DEMO_DATABASE/);
    expect(checkDemoSeedEnv({ ...ok, DATABASE_URL: undefined }).join()).toMatch(/DATABASE_URL/);
  });
});

describe('seed:demo database checks (real PostgreSQL)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.pool);
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  it('fills a blank migrated database with the fictitious company, then refuses a second run', async () => {
    await expect(assertDemoSeedable(ctx.pool, RUN_DB)).resolves.toBeUndefined();
    const printed = await withTransaction(ctx.pool, (tx) => insertFictitiousCompany(tx, 15));
    expect(printed).toHaveLength(3);
    const pw = printed[0]!.split('password: ')[1]!;
    expect(pw.length).toBe(20);
    const counts = await ctx.pool.query(
      `SELECT (SELECT count(*)::int FROM branches) b, (SELECT count(*)::int FROM vehicles) v,
              (SELECT count(*)::int FROM users WHERE email NOT LIKE '%@example.test') real_accounts`,
    );
    expect(counts.rows[0]).toEqual({ b: 2, v: 8, real_accounts: 0 });
    await expect(assertDemoSeedable(ctx.pool, RUN_DB)).rejects.toThrow(/already has 3 account/);
  });

  it('refuses when the connected database is not the one named explicitly', async () => {
    await expect(assertDemoSeedable(ctx.pool, 'railway')).rejects.toThrow(/connected to/);
  });

  it('refuses a database with any account, even a single real manager', async () => {
    await createUser(ctx.pool, { email: 'owner@agence.ma', role: 'manager' });
    await expect(assertDemoSeedable(ctx.pool, RUN_DB)).rejects.toThrow(/already has 1 account/);
  });

  it('refuses when company settings were already filled in', async () => {
    await ctx.pool.query(`UPDATE company_settings SET legal_name = 'Vraie Société SARL' WHERE id = 1`);
    await expect(assertDemoSeedable(ctx.pool, RUN_DB)).rejects.toThrow(/company settings/);
  });

  it('refuses when any business table holds data', async () => {
    await ctx.pool.query(`INSERT INTO branches (code, name, city) VALUES ('CAS', 'Agence', 'Casablanca')`);
    await expect(assertDemoSeedable(ctx.pool, RUN_DB)).rejects.toThrow(/branches/);
  });

  it('refuses a database that was never migrated', async () => {
    await ctx.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await expect(assertDemoSeedable(ctx.pool, RUN_DB)).rejects.toThrow(/migrations first/);
  });
});
