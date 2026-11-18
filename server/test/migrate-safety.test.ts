import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { assertNoOwnTransaction, loadMigrations, migrate, MIGRATIONS_DIR } from '../src/db/migrate.js';
import { createRunDatabase, dropRunDatabase, runDatabaseUrl } from '../src/db/target-guard.js';

// Synthetic data only. Each case runs in its own throwaway run database (fleetora_run_*_test).

let maintenance: pg.Pool;
let upTo0010: string; // a migrations folder holding 0001…0010 only (the version currently in production)

beforeAll(async () => {
  maintenance = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  upTo0010 = await mkdtemp(path.join(tmpdir(), 'fleetora-mig-'));
  for (const f of await readdir(MIGRATIONS_DIR)) if (/^00(0\d|10)_.*\.sql$/.test(f)) await cp(path.join(MIGRATIONS_DIR, f), path.join(upTo0010, f));
});
afterAll(async () => {
  await rm(upTo0010, { recursive: true, force: true });
  await maintenance.end();
});

async function withRunDb(fn: (pool: pg.Pool) => Promise<void>) {
  const name = await createRunDatabase(maintenance);
  const pool = new pg.Pool({ connectionString: runDatabaseUrl(process.env.TEST_DATABASE_URL!, name), max: 2 });
  // DROP … WITH (FORCE) below may terminate a connection that pool.end() is still closing; the server then
  // reports 57P01 on that idle client. Expected here only — any other pool error still fails the run.
  pool.on('error', (err) => {
    if ((err as { code?: string }).code !== '57P01') throw err;
  });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await dropRunDatabase(maintenance, name);
  }
}

/** Row count + content hash of every table, ignoring columns added by 0011. */
async function fingerprint(pool: pg.Pool, tables: string[]) {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const { rows } = await pool.query(
      `SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name NOT LIKE 'catalog\\_%'`,
      [t],
    );
    const h = await pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM (SELECT ${rows[0].c} FROM public."${t}") x`);
    out[t] = `${h.rows[0].n}:${h.rows[0].h}`;
  }
  return out;
}

describe('migration safety', () => {
  it('a migration may not open or close its own transaction (the runner records it atomically)', () => {
    expect(() => assertNoOwnTransaction('x.sql', 'BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;')).toThrow(/own BEGIN\/COMMIT/);
    expect(() => assertNoOwnTransaction('x.sql', 'CREATE TABLE t (id int);\n  commit ;')).toThrow(/own BEGIN\/COMMIT/);
    expect(() => assertNoOwnTransaction('x.sql', 'START TRANSACTION;')).toThrow();
    // PL/pgSQL bodies and comments are fine.
    expect(() =>
      assertNoOwnTransaction('x.sql', "-- BEGIN;\nCREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n/* COMMIT; */"),
    ).not.toThrow();
  });

  it('every migration in the repository loads (no own transaction, unique versions)', async () => {
    const files = await loadMigrations();
    expect(files.map((f) => f.version)).toEqual(['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018']);
  });

  it('RC-04: upgrading from 0017 preserves existing receipt expenses without authorizing unrelated scans', async () => {
    const oldDir = await mkdtemp(path.join(tmpdir(), 'fleetora-rc04-'));
    try {
      for (const f of await readdir(MIGRATIONS_DIR)) {
        if (/^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 17) {
          await cp(path.join(MIGRATIONS_DIR, f), path.join(oldDir, f));
        }
      }
      await withRunDb(async (pool) => {
        expect(await migrate(pool, oldDir)).toHaveLength(17);
        const user = (await pool.query("INSERT INTO users (email, full_name, role_code, password_hash) VALUES ('historical@example.test', 'Demo employee', 'employee', 'test') RETURNING id")).rows[0].id;
        const branch = (await pool.query("INSERT INTO branches (code, name, city) VALUES ('CAS', 'Casablanca', 'Casablanca') RETURNING id")).rows[0].id;
        const receiptSha = 'a'.repeat(64);
        const scanSha = 'b'.repeat(64);
        const receipt = (await pool.query(
          'INSERT INTO stored_files (storage_key, sha256, size_bytes, mime_type, uploaded_by) VALUES ($1, $2, 30, $3, $4) RETURNING id',
          ['aa/' + receiptSha, receiptSha, 'application/pdf', user],
        )).rows[0].id;
        const unrelatedScan = (await pool.query(
          'INSERT INTO stored_files (storage_key, sha256, size_bytes, mime_type, uploaded_by) VALUES ($1, $2, 30, $3, $4) RETURNING id',
          ['bb/' + scanSha, scanSha, 'application/pdf', user],
        )).rows[0].id;
        const expenseId = (await pool.query(
          "INSERT INTO expenses (branch_id, category, amount_cents, method, spent_on, receipt_file_id, created_by) VALUES ($1, 'office', 1234, 'cash', CURRENT_DATE, $2, $3) RETURNING id",
          [branch, receipt, user],
        )).rows[0].id;
        expect(await migrate(pool)).toEqual(['0018_expense_receipt_upload_claims']);
        const claims = await pool.query('SELECT file_id, uploaded_by FROM expense_receipt_upload_claims');
        expect(claims.rows).toEqual([{ file_id: receipt, uploaded_by: user }]);
        expect(claims.rows.some((x) => x.file_id === unrelatedScan)).toBe(false);
        const stillThere = await pool.query('SELECT amount_cents, receipt_file_id FROM expenses WHERE id = $1', [expenseId]);
        expect(stillThere.rows[0]).toMatchObject({ amount_cents: '1234', receipt_file_id: receipt });
        expect(await migrate(pool)).toEqual([]);
      });
    } finally {
      await rm(oldDir, { recursive: true, force: true });
    }
  });
  it('upgrading a 0010 database that holds business data to 0011 changes no existing row; running again applies nothing', async () => {
    await withRunDb(async (pool) => {
      expect(await migrate(pool, upTo0010)).toHaveLength(10);
      const u = (await pool.query(`INSERT INTO users (email, full_name, role_code, password_hash) VALUES ('m@example.test', 'Gérant Démo', 'manager', 'x') RETURNING id`)).rows[0].id;
      const b = (await pool.query(`INSERT INTO branches (code, name, city) VALUES ('CAS', 'Casablanca', 'Casablanca') RETURNING id`)).rows[0].id;
      await pool.query(
        `INSERT INTO vehicles (branch_id, plate, plate_key, make, model, fuel_type, transmission, mileage_km, created_by)
         VALUES ($1, '99991-أ-1', '99991A1', 'Dacia', 'Logan', 'diesel', 'manual', 1000, $2)`,
        [b, u],
      );
      await pool.query(`INSERT INTO customers (full_name, phone, phone_key, created_by) VALUES ('Client Démo', '0600000001', '212600000001', $1)`, [u]);
      const tables = (await pool.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations' ORDER BY 1`)).rows.map((r) => r.relname as string);
      const before = await fingerprint(pool, tables);

      expect(await migrate(pool)).toEqual(['0011_vehicle_reference_catalog', '0012_customer_intake', '0013_customer_merge_links', '0014_intake_visual_fingerprint', '0015_intake_document_reviews', '0016_document_review_separation', '0017_offsite_backups_drills', '0018_expense_receipt_upload_claims']);
      expect(await fingerprint(pool, tables)).toEqual(before);
      expect((await pool.query(`SELECT catalog_model_id, catalog_generation_id, catalog_engine_id FROM vehicles`)).rows).toEqual([
        { catalog_model_id: null, catalog_generation_id: null, catalog_engine_id: null },
      ]);
      expect(await migrate(pool)).toEqual([]);
    });
  });

  it('if recording 0011 fails, nothing of the catalogue is left behind and a retry succeeds', async () => {
    await withRunDb(async (pool) => {
      await migrate(pool, upTo0010);
      await pool.query(`CREATE FUNCTION fail_0011() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN IF NEW.version = '0011' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
                        CREATE TRIGGER fail_0011 BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION fail_0011();`);
      await expect(migrate(pool)).rejects.toThrow(/0011_vehicle_reference_catalog failed: simulated failure/);
      const left = await pool.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'vehicle\\_catalog\\_%' AND relkind = 'r'`);
      expect(left.rows[0].n).toBe(0);
      expect((await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name LIKE 'catalog\\_%'`)).rows[0].n).toBe(0);
      await pool.query(`DROP TRIGGER fail_0011 ON schema_migrations`);
      expect(await migrate(pool)).toEqual(['0011_vehicle_reference_catalog', '0012_customer_intake', '0013_customer_merge_links', '0014_intake_visual_fingerprint', '0015_intake_document_reviews', '0016_document_review_separation', '0017_offsite_backups_drills', '0018_expense_receipt_upload_claims']);
    });
  });

  it('the catalogue holds the expected reference rows and only references, with consistent links', async () => {
    await withRunDb(async (pool) => {
      await migrate(pool);
      const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
      expect({
        brands: await count('vehicle_catalog_brands'),
        models: await count('vehicle_catalog_models'),
        generations: await count('vehicle_catalog_generations'),
        engines: await count('vehicle_catalog_engines'),
        tireSizes: await count('vehicle_catalog_tire_sizes'),
        tireFitments: await count('vehicle_catalog_tire_fitments'),
        oilFitments: await count('vehicle_catalog_oil_fitments'),
        market: await count('vehicle_catalog_market_priority'),
        statuses: await count('vehicle_catalog_status_reference'),
      }).toEqual({ brands: 39, models: 262, generations: 3, engines: 5, tireSizes: 44, tireFitments: 2, oilFitments: 5, market: 20, statuses: 6 });
      // One catalogue status per application status, nothing else.
      const statuses = (await pool.query(`SELECT app_status FROM vehicle_catalog_status_reference ORDER BY 1`)).rows.map((r) => r.app_status);
      const app = (await pool.query(`SELECT DISTINCT unnest(ARRAY[from_status, to_status]) AS s FROM vehicle_status_transitions ORDER BY 1`)).rows.map((r) => r.s);
      expect(statuses).toEqual(app);
      // Every tyre size is parsed (width / ratio / rim), including commercial "C" sizes.
      expect(await count(`vehicle_catalog_tire_sizes WHERE width_mm IS NULL OR aspect_ratio IS NULL OR rim_inches IS NULL`)).toBe(0);
      expect(await count(`vehicle_catalog_tire_sizes WHERE size LIKE '%C' AND reinforced = 'C'`)).toBe(5);
      // kW is only filled where the source gives ch DIN, and matches it.
      expect(await count(`vehicle_catalog_engines WHERE power_kw IS NOT NULL AND abs(power_kw - round(power_hp * 0.73549875, 1)) > 0.05`)).toBe(0);
      expect(await count(`vehicle_catalog_engines WHERE power_hp IS NULL AND power_kw IS NOT NULL`)).toBe(0);
      // No food-oil brand among motor oils; no business data anywhere.
      expect(await count(`vehicle_catalog_oil_brands WHERE name ILIKE '%lesieur%'`)).toBe(0);
      for (const t of ['vehicles', 'customers', 'contracts', 'reservations', 'payments', 'stored_files', 'users']) expect(await count(t)).toBe(0);
      // Advisory only: no oil grade was invented.
      expect(await count(`vehicle_catalog_oil_fitments WHERE sae_viscosity IS NOT NULL`)).toBe(0);
    });
  });
});
