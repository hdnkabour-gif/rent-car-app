/**
 * Development/demo seed with SYNTHETIC data only (example.test accounts, fictitious company,
 * plates starting with 9999x so they cannot be real Moroccan plates in use).
 *
 * Guards (all must pass): NODE_ENV must be exactly "development"; the database must be local and
 * named *_dev or *_test; it must contain only @example.test accounts and NO business data
 * (branches, vehicles or any other non-foundation table). It therefore only ever fills an empty
 * development database, and never resets a password or reactivates an account in a database that
 * holds data. Passwords are random and shown once.
 */
import { createPool, withTransaction } from '../db/pool.js';
import { assertSeedableDevDatabase, checkDevSeedTarget } from '../db/target-guard.js';
import { insertFictitiousCompany } from '../db/demo-fixtures.js';

const url = process.env.DATABASE_URL;
const targetErrors = checkDevSeedTarget(url, process.env);
if (targetErrors.length) {
  console.error(`seed:dev refused:\n- ${targetErrors.join('\n- ')}`);
  process.exit(1);
}

const pool = createPool(url!);
try {
  // Content check (default deny): only synthetic accounts and no business data at all.
  await assertSeedableDevDatabase(pool);
  const printed = await withTransaction(pool, (tx) => insertFictitiousCompany(tx));
  process.stdout.write(`${printed.join('\n')}\n`);
  process.stdout.write('Synthetic demo data ready: 2 branches, 8 vehicles. Never use these accounts outside development or demos.\n');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
