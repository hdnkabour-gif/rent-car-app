/**
 * Safety checks for tools that DESTROY or OVERWRITE data (the test suite wipes its database;
 * seed:dev overwrites demo accounts). Several independent layers, so one misconfigured
 * environment variable is never enough to hit a real database:
 *   1. strict database-name pattern (not just "contains test"),
 *   2. loopback host only (unless explicitly allowed for tests),
 *   3. the target must not be the application database (DATABASE_URL),
 *   4. content checks: a non-empty database must carry the test-suite marker (tests), or contain
 *      only synthetic @example.test accounts (seed).
 * Error messages name the database and host only — never credentials.
 */
import type pg from 'pg';

export interface DbTarget {
  host: string;
  port: string;
  database: string;
}

export function parseDbUrl(url: string): DbTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Database URL is not a valid postgres:// URL');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('Database URL must use postgres://');
  return {
    host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
export const isLoopback = (host: string) => LOOPBACK.has(host);

const describe = (t: DbTarget) => `"${t.database}" on ${t.host}:${t.port}`;

function sameDatabase(a: DbTarget, b: DbTarget): boolean {
  const norm = (h: string) => (isLoopback(h) ? 'loopback' : h);
  return norm(a.host) === norm(b.host) && a.port === b.port && a.database === b.database;
}

/** Name must END with "_test", e.g. fleetora_test. "latest", "contest" or "fleetora_test_copy" are refused. */
export const TEST_DB_NAME = /^[a-z][a-z0-9_]*_test$/;
/** seed:dev accepts only *_dev or *_test databases. */
export const SEED_DB_NAME = /^[a-z][a-z0-9_]*_(dev|test)$/;

export function checkTestDatabaseTarget(
  testUrl: string | undefined,
  appUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!testUrl) return ['TEST_DATABASE_URL is not set. Create an empty, disposable database such as fleetora_test.'];
  const errors: string[] = [];
  const t = parseDbUrl(testUrl);
  if (!TEST_DB_NAME.test(t.database)) {
    errors.push(`Test database name ${describe(t)} must end with "_test" (e.g. fleetora_test); it is wiped by every test run.`);
  }
  if (!isLoopback(t.host) && env.FLEETORA_ALLOW_NON_LOCAL_TEST_DB !== 'true') {
    errors.push(`Test database ${describe(t)} is not on this machine. Tests only wipe local databases (set FLEETORA_ALLOW_NON_LOCAL_TEST_DB=true only for a disposable CI database).`);
  }
  if (appUrl && sameDatabase(t, parseDbUrl(appUrl))) {
    errors.push(`TEST_DATABASE_URL points to the same database as DATABASE_URL (${describe(t)}). Use a separate database.`);
  }
  return errors;
}

export function checkDevSeedTarget(url: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!url) return ['DATABASE_URL is not set (see server/.env.example).'];
  const errors: string[] = [];
  if (env.NODE_ENV !== 'development') {
    errors.push(`seed:dev requires NODE_ENV=development (current: ${env.NODE_ENV ?? 'unset'}).`);
  }
  const t = parseDbUrl(url);
  if (!SEED_DB_NAME.test(t.database)) errors.push(`seed:dev only runs on a database named *_dev or *_test, not ${describe(t)}.`);
  if (!isLoopback(t.host)) errors.push(`seed:dev only runs on a database on this machine, not ${describe(t)}.`);
  return errors;
}

/** Marker table created by the test suite in the databases it owns. */
export const TEST_MARKER_TABLE = 'fleetora_disposable_test_db';
/** Marker table created by seed:dev in the development databases it owns. */
export const DEV_SEED_MARKER_TABLE = 'fleetora_dev_seed_db';

type Queryable = pg.Pool | pg.PoolClient;

/** Where a pool is configured to connect (client-side view, before any query runs). */
export function poolTarget(pool: pg.Pool): DbTarget {
  const o = pool.options;
  if (o.connectionString) return parseDbUrl(o.connectionString);
  return {
    host: String(o.host ?? process.env.PGHOST ?? 'localhost').toLowerCase(),
    port: String(o.port ?? process.env.PGPORT ?? '5432'),
    database: String(o.database ?? process.env.PGDATABASE ?? ''),
  };
}

async function tableExists(db: Queryable, name: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(`SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS present`, [name]);
  return rows[0]?.present ?? false;
}

export interface SchemaInventory {
  /** Tables, views, sequences, indexes… in public (excluding the marker tables). */
  relations: number;
  functions: number;
  /** User-defined types (excluding the implicit row and array types of tables). */
  types: number;
  /** Extensions installed into public. */
  extensions: number;
  /** Non-system schemas other than public (DROP SCHEMA public would not remove them, but a test DB has none). */
  otherSchemas: string[];
}

/** Everything a `DROP SCHEMA public CASCADE` could destroy, plus any other user schema. */
export async function inspectSchema(db: Queryable): Promise<SchemaInventory> {
  const { rows } = await db.query<{
    relations: number;
    functions: number;
    types: number;
    extensions: number;
    other_schemas: string[];
  }>(
    `SELECT
       (SELECT count(*)::int FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace
            AND c.relname NOT IN ($1, $2)
            AND NOT EXISTS (SELECT 1 FROM pg_depend d                       -- indexes/sequences/toast of the marker tables
                             JOIN pg_class m ON m.oid = d.refobjid
                            WHERE d.objid = c.oid AND m.relname IN ($1, $2)
                              AND m.relnamespace = 'public'::regnamespace)
            AND c.relkind <> 't') AS relations,
       (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace) AS functions,
       (SELECT count(*)::int FROM pg_type t
          WHERE t.typnamespace = 'public'::regnamespace
            AND t.typrelid = 0                                               -- not a table row type
            AND NOT (t.typcategory = 'A' AND t.typelem <> 0)) AS types,      -- not an implicit array type
       (SELECT count(*)::int FROM pg_extension WHERE extnamespace = 'public'::regnamespace) AS extensions,
       (SELECT coalesce(array_agg(nspname::text ORDER BY nspname), '{}'::text[]) FROM pg_namespace
          WHERE nspname NOT IN ('public', 'information_schema')
            AND nspname NOT LIKE 'pg\\_%') AS other_schemas`,
    [TEST_MARKER_TABLE, DEV_SEED_MARKER_TABLE],
  );
  const r = rows[0]!;
  return { relations: r.relations, functions: r.functions, types: r.types, extensions: r.extensions, otherSchemas: r.other_schemas };
}

export const isEmptyInventory = (i: SchemaInventory) =>
  i.relations === 0 && i.functions === 0 && i.types === 0 && i.extensions === 0;

/**
 * Content check before a wipe: the database must be completely empty (first run), or carry the
 * test-suite marker. Any other schema besides public is always refused.
 */
export async function assertDisposableTestDatabase(db: Queryable): Promise<void> {
  const inv = await inspectSchema(db);
  if (inv.otherSchemas.length > 0) {
    throw new Error(
      `Refusing to wipe the test database: it contains other schemas (${inv.otherSchemas.join(', ')}), so it is not a disposable test database.`,
    );
  }
  if (!isEmptyInventory(inv) && !(await tableExists(db, TEST_MARKER_TABLE))) {
    throw new Error(
      `Refusing to wipe the test database: it contains objects (${inv.relations} relations, ${inv.functions} functions, ` +
        `${inv.types} types, ${inv.extensions} extensions) but no test-suite marker, so it may hold real data. ` +
        'If it really is disposable, drop and recreate it empty (see docs/LOCAL_DEVELOPMENT.md).',
    );
  }
}

export async function markDisposableTestDatabase(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS ${TEST_MARKER_TABLE} (created_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`COMMENT ON TABLE ${TEST_MARKER_TABLE} IS 'Created by the Fleetora test suite. This database is wiped by tests.'`);
}

/**
 * The ONLY way the test suite wipes a database. Self-contained: it re-checks, on the same connection
 * that will run the DROP, that the pool targets the configured TEST_DATABASE_URL (local, *_test,
 * not DATABASE_URL), that the server-side database name matches, and that the content is disposable.
 * It never relies on a caller having run other checks first.
 */
export async function wipeTestDatabase(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = poolTarget(pool);
  const errors = checkTestDatabaseTarget(env.TEST_DATABASE_URL, env.DATABASE_URL, env);
  if (errors.length) throw new Error(`Refusing to wipe:\n- ${errors.join('\n- ')}`);
  const configured = parseDbUrl(env.TEST_DATABASE_URL!);
  if (!sameDatabase(target, configured)) {
    throw new Error(`Refusing to wipe ${describe(target)}: it is not the configured TEST_DATABASE_URL (${describe(configured)}).`);
  }
  // target equals the configured database, which passed all name/host/separation checks above.

  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    if (rows[0]?.db !== target.database) {
      throw new Error(`Refusing to wipe: connected to "${rows[0]?.db}" but expected "${target.database}".`);
    }
    await client.query('BEGIN');
    await assertDisposableTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/*
 * seed:dev content rules (default deny, so future modules are protected automatically):
 *  - every account must be a synthetic @example.test account, always;
 *  - a database that seed:dev already owns (marker present) may be re-seeded;
 *  - otherwise every table that is NOT a known foundation table must be empty. A new module's
 *    tables (vehicles, customers, reservations, payments, documents, maintenance…) are therefore
 *    covered without anyone remembering to update a list.
 */
export const SEED_FOUNDATION_TABLES = new Set([
  'schema_migrations',
  'roles',
  'permissions',
  'role_permissions',
  'users',
  'sessions',
  'company_settings',
  'audit_logs',
  TEST_MARKER_TABLE,
  DEV_SEED_MARKER_TABLE,
]);

export async function assertSyntheticAccountsOnly(db: Queryable): Promise<void> {
  if (!(await tableExists(db, 'users'))) return;
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE email NOT LIKE '%@example.test'`);
  const n = rows[0]?.n ?? 0;
  if (n > 0) {
    throw new Error(`Refusing to seed: the database contains ${n} account(s) that are not synthetic @example.test accounts.`);
  }
}

export async function assertSeedableDevDatabase(db: Queryable): Promise<void> {
  await assertSyntheticAccountsOnly(db);
  if (await tableExists(db, DEV_SEED_MARKER_TABLE)) return;
  const { rows: tables } = await db.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  const nonEmpty: string[] = [];
  for (const { name } of tables) {
    if (SEED_FOUNDATION_TABLES.has(name)) continue;
    const { rows } = await db.query<{ has_rows: boolean }>(`SELECT EXISTS (SELECT 1 FROM public.${pgIdent(name)}) AS has_rows`);
    if (rows[0]?.has_rows) nonEmpty.push(name);
  }
  if (nonEmpty.length) {
    throw new Error(
      `Refusing to seed: this database was not created by seed:dev and already holds operational data in: ${nonEmpty.join(', ')}.`,
    );
  }
}

export async function markDevSeedDatabase(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS ${DEV_SEED_MARKER_TABLE} (seeded_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`INSERT INTO ${DEV_SEED_MARKER_TABLE} DEFAULT VALUES`);
  await db.query(`COMMENT ON TABLE ${DEV_SEED_MARKER_TABLE} IS 'Created by fleetora seed:dev: synthetic development database.'`);
}

function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
