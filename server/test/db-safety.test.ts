import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  assertDisposableTestDatabase,
  assertSyntheticAccountsOnly,
  checkDevSeedTarget,
  checkTestDatabaseTarget,
  TEST_MARKER_TABLE,
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
    await ctx.pool.end();
  });

  it('the test suite marks the databases it owns', async () => {
    const { rows } = await ctx.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [TEST_MARKER_TABLE]);
    expect(rows[0].present).toBe(true);
    await expect(assertDisposableTestDatabase(ctx.pool)).resolves.toBeUndefined();
  });

  it('refuses to wipe a database that has tables but no marker, and leaves its data untouched', async () => {
    await createUser(ctx.pool, { email: 'keep@example.test', role: 'manager' });
    await ctx.pool.query(`DROP TABLE ${TEST_MARKER_TABLE}`);
    try {
      await expect(resetDatabase(ctx.pool)).rejects.toThrow(/Refusing to wipe the test database/);
      const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'keep@example.test'`);
      expect(rows[0].n).toBe(1);
    } finally {
      await ctx.pool.query(`CREATE TABLE ${TEST_MARKER_TABLE} (created_at timestamptz NOT NULL DEFAULT now())`);
    }
  });

  it('seed:dev refuses a database containing non-synthetic accounts', async () => {
    await resetDatabase(ctx.pool);
    await createUser(ctx.pool, { email: 'demo@example.test', role: 'manager' });
    await expect(assertSyntheticAccountsOnly(ctx.pool)).resolves.toBeUndefined();
    await createUser(ctx.pool, { email: 'real.person@agence.ma', role: 'employee' });
    const err = await assertSyntheticAccountsOnly(ctx.pool).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/1 account\(s\) that are not synthetic/);
    expect((err as Error).message).not.toContain('agence.ma');
  });

  it('an empty database (first run) is accepted', async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      await admin.query('DROP SCHEMA public CASCADE');
      await admin.query('CREATE SCHEMA public');
      await expect(assertDisposableTestDatabase(admin)).resolves.toBeUndefined();
      await resetDatabase(admin);
    } finally {
      await admin.end();
    }
  });
});
