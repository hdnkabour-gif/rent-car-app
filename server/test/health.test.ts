import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { checkDatabase } from '../src/db/pool.js';
import { setupTestApp, testConfig, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('health checks', () => {
  it('GET /api/health returns ok', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/health/db reports a working database', async () => {
    const res = await request(ctx.app).get('/api/health/db');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('checkDatabase runs a real query', async () => {
    const result = await checkDatabase(ctx.pool);
    expect(result.ok).toBe(true);
  });

  it('GET /api/health/db returns 503 when the database is unreachable', async () => {
    const config = testConfig();
    // Port 1 on localhost: nothing listens there, so connections fail fast.
    const badPool = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMillis: 1000 });
    const app = createApp({ config, db: badPool, logger: pino({ level: 'silent' }) });
    const res = await request(app).get('/api/health/db');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/nobody|127\.0\.0\.1/);
    await badPool.end();
  });

  it('unknown API routes return a JSON 404', async () => {
    const res = await request(ctx.app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('migrations', () => {
  it('records applied migrations with checksums and creates foundation tables', async () => {
    const { rows } = await ctx.pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    expect(rows).toEqual([
      expect.objectContaining({ version: '0001', name: 'foundation' }),
      expect.objectContaining({ version: '0002', name: 'branches_fleet' }),
      expect.objectContaining({ version: '0003', name: 'vehicle_documents_files' }),
      expect.objectContaining({ version: '0004', name: 'customers' }),
      expect.objectContaining({ version: '0005', name: 'no_delete_business_data' }),
      expect.objectContaining({ version: '0006', name: 'reservations' }),
      expect.objectContaining({ version: '0007', name: 'contracts' }),
      expect.objectContaining({ version: '0008', name: 'late_fees_licence' }),
      expect.objectContaining({ version: '0009', name: 'audit_fixes' }),
      expect.objectContaining({ version: '0010', name: 'cash_maintenance_reminders' }),
      expect.objectContaining({ version: '0011', name: 'vehicle_reference_catalog' }),
    ]);
    const tables = await ctx.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['users', 'roles', 'permissions', 'role_permissions', 'sessions', 'company_settings', 'audit_logs']),
    );
  });

  it('re-running migrate is a no-op', async () => {
    const { migrate } = await import('../src/db/migrate.js');
    expect(await migrate(ctx.pool)).toEqual([]);
  });

  it('refuses to run if an applied migration was modified', async () => {
    const { migrate } = await import('../src/db/migrate.js');
    await ctx.pool.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'`);
    await expect(migrate(ctx.pool)).rejects.toThrow(/modified after being applied/);
    const { loadMigrations } = await import('../src/db/migrate.js');
    const [file] = await loadMigrations();
    await ctx.pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'`, [file!.checksum]);
  });
});

describe('configuration', () => {
  it('refuses production without secure cookies', () => {
    expect(() => testConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  it('uses __Host- cookie prefix when secure', () => {
    expect(testConfig({ NODE_ENV: 'production' }).cookie).toEqual({ name: '__Host-fleetora_sid', secure: true });
  });

  it('does not echo secret values in configuration errors', () => {
    expect(() => testConfig({ DATABASE_URL: '', PORT: 'not-a-port-secret123' })).toThrow(/PORT/);
    try {
      testConfig({ PORT: 'not-a-port-secret123' });
    } catch (err) {
      expect((err as Error).message).not.toContain('secret123');
    }
  });
});

describe('schema health (Railway: migrations must have run)', () => {
  it('reports that every migration is applied', async () => {
    const { setupTestApp: setup } = await import('./helpers.js');
    const c = await setup();
    try {
      const res = await request(c.app).get('/api/health/schema').expect(200);
      expect(res.body).toMatchObject({ upToDate: true, missing: [] });
      expect(res.body.applied).toBe(res.body.expected);
      // Simulate a deployment whose database was not migrated: one migration missing.
      await c.pool.query(`ALTER TABLE schema_migrations DISABLE TRIGGER ALL`);
      await c.pool.query(`DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)`);
      const bad = await request(c.app).get('/api/health/schema').expect(503);
      expect(bad.body.upToDate).toBe(false);
      expect(bad.body.missing).toHaveLength(1);
    } finally {
      await c.pool.end();
    }
  });
});
