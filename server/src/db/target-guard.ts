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

async function tableExists(db: pg.Pool | pg.PoolClient, name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists ?? false;
}

/**
 * Refuses to let the test suite wipe a database that holds application tables but was not
 * created by the test suite. An empty database (first run) is accepted.
 */
export async function assertDisposableTestDatabase(db: pg.Pool): Promise<void> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> $1`,
    [TEST_MARKER_TABLE],
  );
  const hasTables = (rows[0]?.n ?? 0) > 0;
  if (hasTables && !(await tableExists(db, TEST_MARKER_TABLE))) {
    throw new Error(
      'Refusing to wipe the test database: it contains tables but no test-suite marker, so it may hold real data. ' +
        'If it really is disposable, drop and recreate it empty (see docs/LOCAL_DEVELOPMENT.md).',
    );
  }
}

export async function markDisposableTestDatabase(db: pg.Pool): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS ${TEST_MARKER_TABLE} (created_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`COMMENT ON TABLE ${TEST_MARKER_TABLE} IS 'Created by the Fleetora test suite. This database is wiped by tests.'`);
}

/** seed:dev content check: refuse if any account is not a synthetic @example.test account. */
export async function assertSyntheticAccountsOnly(db: pg.Pool): Promise<void> {
  if (!(await tableExists(db, 'users'))) return;
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE email NOT LIKE '%@example.test'`);
  const n = rows[0]?.n ?? 0;
  if (n > 0) {
    throw new Error(`Refusing to seed: the database contains ${n} account(s) that are not synthetic @example.test accounts.`);
  }
}
