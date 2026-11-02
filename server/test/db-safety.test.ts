import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  assertDisposableTestDatabase,
  assertSeedableDevDatabase,
  checkDevSeedTarget,
  checkTestDatabaseTarget,
  inspectSchema,
  isEmptyInventory,
  markDevSeedDatabase,
  TEST_MARKER_TABLE,
  wipeTestDatabase,
} from '../src/db/target-guard.js';
import { createUser, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

const url = (db: string, host = '127.0.0.1', port = 5432) => `postgres://u:secret-pw@${host}:${port}/${db}`;

describe('test database target checks (no database needed)', () => {
  it('accepts a local database whose name ends with _test', () => {
    expect(checkTestDatabaseTarget(url('fleetora_test'), url('fleetora_dev'), {})).toEqual([]);
    expect(checkTestDatabaseTarget(url('fleetora_test', 'localhost'), undefined, {})).toEqual([]);
  });

  it.each(['latest', 'contest', 'fleetora', 'fleetora_dev', 'fleetora_prod', 'fleetora_test_backup', 'test', 'Fleetora_TEST'])(
    'refuses database name %s',
    (name) => {
      expect(checkTestDatabaseTarget(url(name), undefined, {}).join()).toMatch(/must end with "_test"/);
    },
  );

  it('refuses a non-local server unless explicitly allowed for disposable CI databases', () => {
    expect(checkTestDatabaseTarget(url('fleetora_test', '192.168.1.20'), undefined, {}).join()).toMatch(/not on this machine/);
    expect(
      checkTestDatabaseTarget(url('fleetora_test', '192.168.1.20'), undefined, { FLEETORA_ALLOW_NON_LOCAL_TEST_DB: 'true' }),
    ).toEqual([]);
  });

  it('refuses when TEST_DATABASE_URL is the application database, even with other credentials or localhost alias', () => {
    const errs = checkTestDatabaseTarget('postgres://a:b@localhost/fleetora_test', 'postgres://c:d@127.0.0.1:5432/fleetora_test', {});
    expect(errs.join()).toMatch(/same database as DATABASE_URL/);
  });

  it('refuses when unset and never echoes credentials', () => {
    expect(checkTestDatabaseTarget(undefined, undefined, {}).join()).toMatch(/not set/);
    const errs = checkTestDatabaseTarget(url('prod_db', '10.0.0.5'), url('prod_db', '10.0.0.5'), {}).join();
    expect(errs).not.toContain('secret-pw');
  });
});

describe('seed:dev target checks', () => {
  it('requires NODE_ENV=development exactly', () => {
    expect(checkDevSeedTarget(url('fleetora_dev'), { NODE_ENV: 'development' })).toEqual([]);
    for (const NODE_ENV of ['production', 'test', 'staging', undefined]) {
      expect(checkDevSeedTarget(url('fleetora_dev'), { NODE_ENV }).join()).toMatch(/NODE_ENV=development/);
    }
  });

  it('refuses databases not named *_dev / *_test and non-local hosts', () => {
    const env = { NODE_ENV: 'development' };
    expect(checkDevSeedTarget(url('fleetora'), env).join()).toMatch(/_dev or \*_test/);
    expect(checkDevSeedTarget(url('fleetora_prod'), env).join()).toMatch(/_dev or \*_test/);
    expect(checkDevSeedTarget(url('fleetora_dev', 'db.company.lan'), env).join()).toMatch(/on this machine/);
  });
});

describe('database content checks (real PostgreSQL)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => {
    await resetDatabase(ctx.pool);
    await ctx.pool.end();
  });

  /** Test-only: empty the test database directly (bypasses the guard on purpose to build fixtures). */
  async function makeEmpty() {
    await ctx.pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
    for (const r of (await ctx.pool.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'zz\\_%'`)).rows) {
      await ctx.pool.query(`DROP SCHEMA ${r.nspname} CASCADE`);
    }
  }

  it('the test suite marks the databases it owns', async () => {
    await resetDatabase(ctx.pool);
    const { rows } = await ctx.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [TEST_MARKER_TABLE]);
    expect(rows[0].present).toBe(true);
    await expect(assertDisposableTestDatabase(ctx.pool)).resolves.toBeUndefined();
  });

  it('refuses to wipe a database that has tables but no marker, and leaves its data untouched', async () => {
    await resetDatabase(ctx.pool);
    await createUser(ctx.pool, { email: 'keep@example.test', role: 'manager' });
    await ctx.pool.query(`DROP TABLE ${TEST_MARKER_TABLE}`);
    await expect(resetDatabase(ctx.pool)).rejects.toThrow(/Refusing to wipe the test database/);
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'keep@example.test'`);
    expect(rows[0].n).toBe(1);
    await ctx.pool.query(`CREATE TABLE ${TEST_MARKER_TABLE} (created_at timestamptz NOT NULL DEFAULT now())`);
  });

  it.each([
    ['a sequence', 'CREATE SEQUENCE invoice_no'],
    ['a function', 'CREATE FUNCTION add_one(i int) RETURNS int LANGUAGE sql AS $$ SELECT i + 1 $$'],
    ['an enum type', `CREATE TYPE fuel_level AS ENUM ('empty', 'full')`],
    ['a domain', 'CREATE DOMAIN positive_mad AS numeric(12,2) CHECK (VALUE >= 0)'],
    ['a view', 'CREATE VIEW v AS SELECT 1 AS x'],
  ])('refuses to wipe an unmarked database containing only %s', async (_label, ddl) => {
    await makeEmpty();
    await ctx.pool.query(ddl);
    await expect(resetDatabase(ctx.pool)).rejects.toThrow(/Refusing to wipe the test database/);
    // Nothing was dropped.
    const inv = await inspectSchema(ctx.pool);
    expect(inv.relations + inv.functions + inv.types).toBeGreaterThan(0);
  });

  it('refuses a user schema whose name merely starts with "pg" (LIKE wildcard regression)', async () => {
    await makeEmpty();
    await resetDatabase(ctx.pool);
    await ctx.pool.query('CREATE SCHEMA pgx_data');
    try {
      await expect(resetDatabase(ctx.pool)).rejects.toThrow(/other schemas \(pgx_data\)/);
    } finally {
      await ctx.pool.query('DROP SCHEMA pgx_data CASCADE');
    }
  });

  it('refuses to wipe a database that contains another schema, even with the marker', async () => {
    await makeEmpty();
    await resetDatabase(ctx.pool);
    await ctx.pool.query('CREATE SCHEMA zz_real_data');
    await ctx.pool.query('CREATE TABLE zz_real_data.customers (id int)');
    await expect(resetDatabase(ctx.pool)).rejects.toThrow(/other schemas \(zz_real_data\)/);
    await ctx.pool.query('DROP SCHEMA zz_real_data CASCADE');
  });

  it('an empty database (first run) is accepted and then marked', async () => {
    await makeEmpty();
    expect(isEmptyInventory(await inspectSchema(ctx.pool))).toBe(true);
    await expect(resetDatabase(ctx.pool)).resolves.toBeUndefined();
    const { rows } = await ctx.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [TEST_MARKER_TABLE]);
    expect(rows[0].present).toBe(true);
  });
});

describe('wipeTestDatabase is self-contained (independent of callers)', () => {
  const env = () => ({ ...process.env });

  it('refuses a pool that targets the application database (DATABASE_URL)', async () => {
    const appUrl = process.env.DATABASE_URL;
    expect(appUrl, 'DATABASE_URL must be set for this test').toBeTruthy();
    const pool = new pg.Pool({ connectionString: appUrl });
    try {
      await expect(wipeTestDatabase(pool, env())).rejects.toThrow(/not the configured TEST_DATABASE_URL/);
    } finally {
      await pool.end();
    }
  });

  it('refuses a pool that targets any other database', async () => {
    const other = new URL(process.env.TEST_DATABASE_URL!);
    other.pathname = '/postgres';
    const pool = new pg.Pool({ connectionString: other.toString() });
    try {
      await expect(wipeTestDatabase(pool, env())).rejects.toThrow(/not the configured TEST_DATABASE_URL/);
    } finally {
      await pool.end();
    }
  });

  it('refuses when the environment itself is unsafe, before connecting', async () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await expect(wipeTestDatabase(pool, { ...env(), DATABASE_URL: process.env.TEST_DATABASE_URL })).rejects.toThrow(
        /same database as DATABASE_URL/,
      );
      await expect(wipeTestDatabase(pool, { ...env(), TEST_DATABASE_URL: undefined })).rejects.toThrow(/not set/);
    } finally {
      await pool.end();
    }
  });
});

describe('seed:dev content rules (default deny for future modules)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  afterAll(async () => {
    await resetDatabase(ctx.pool);
    await ctx.pool.end();
  });

  it('accepts a freshly migrated database with only synthetic accounts', async () => {
    await resetDatabase(ctx.pool);
    await createUser(ctx.pool, { email: 'demo@example.test', role: 'manager' });
    await expect(assertSeedableDevDatabase(ctx.pool)).resolves.toBeUndefined();
  });

  it('refuses non-synthetic accounts, without printing them', async () => {
    await resetDatabase(ctx.pool);
    await createUser(ctx.pool, { email: 'real.person@agence.ma', role: 'employee' });
    const err = (await assertSeedableDevDatabase(ctx.pool).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/1 account\(s\) that are not synthetic/);
    expect(err.message).not.toContain('agence.ma');
  });

  it('refuses when a (future) module table holds data, even if every account is synthetic', async () => {
    await resetDatabase(ctx.pool);
    // Simulates slice 2+: nobody had to register this table for the guard to protect it.
    await ctx.pool.query('CREATE TABLE vehicles (id int, plate text)');
    await expect(assertSeedableDevDatabase(ctx.pool)).resolves.toBeUndefined(); // empty table is fine
    await ctx.pool.query(`INSERT INTO vehicles VALUES (1, '12345-A-6')`);
    await expect(assertSeedableDevDatabase(ctx.pool)).rejects.toThrow(/operational data in: vehicles/);
  });

  it('allows re-seeding a database that seed:dev created, but never with non-synthetic accounts', async () => {
    await resetDatabase(ctx.pool);
    await ctx.pool.query('CREATE TABLE vehicles (id int)');
    await ctx.pool.query('INSERT INTO vehicles VALUES (1)');
    await markDevSeedDatabase(ctx.pool);
    await expect(assertSeedableDevDatabase(ctx.pool)).resolves.toBeUndefined();
    await createUser(ctx.pool, { email: 'real@agence.ma', role: 'employee' });
    await expect(assertSeedableDevDatabase(ctx.pool)).rejects.toThrow(/not synthetic/);
  });

  it('the seed marker does not count as data and does not hide other schema objects from the test guard', async () => {
    const inv = await inspectSchema(ctx.pool);
    expect(inv.relations).toBeGreaterThan(0);
  });
});
