/**
 * Fills a hosted DEMO database (e.g. Railway) with the fictitious company: 2 branches, 8 vehicles,
 * 1 manager and 2 employees (example.test). FICTITIOUS DATA ONLY; never for a company's real system.
 *
 * Usage (inside the demo service, never against a database that holds anything):
 *   FLEETORA_DEMO_SEED=fictitious-data-only FLEETORA_DEMO_DATABASE=<exact db name> node server/dist/src/scripts/seed-demo.js
 * Passwords are long, random and printed once: store them in a password manager.
 */
import { createPool, withTransaction } from '../db/pool.js';
import { assertDemoSeedable, checkDemoSeedEnv } from '../db/target-guard.js';
import { insertFictitiousCompany } from '../db/demo-fixtures.js';

const errors = checkDemoSeedEnv(process.env);
if (errors.length) {
  console.error(`seed:demo refused:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

const pool = createPool(process.env.DATABASE_URL!);
try {
  const printed = await withTransaction(pool, async (tx) => {
    // Checked inside the same transaction that writes, so nothing can slip in between.
    await assertDemoSeedable(tx, process.env.FLEETORA_DEMO_DATABASE!);
    return insertFictitiousCompany(tx, 15); // 20-character passwords for a public demo
  });
  process.stdout.write(`${printed.join('\n')}\n`);
  process.stdout.write('Demo data ready: 2 branches, 8 vehicles, FICTITIOUS ONLY. Store the passwords now; they are not shown again.\n');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
