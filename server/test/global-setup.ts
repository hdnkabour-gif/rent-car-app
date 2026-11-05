import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { checkTestDatabaseTarget, createRunDatabase, dropRunDatabase, runDatabaseUrl } from '../src/db/target-guard.js';

declare module 'vitest' {
  export interface ProvidedContext {
    runDatabase: string;
    runDatabaseUrl: string;
  }
}

/**
 * Each test run gets a brand-new database (fleetora_run_<random>_test) created here and dropped at
 * the end. TEST_DATABASE_URL is only the maintenance connection used to create and drop it; it is
 * never wiped. Tests may wipe only the run database (see wipeTestDatabase).
 */
export default async function setup(project: TestProject) {
  const errors = checkTestDatabaseTarget(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  if (errors.length) throw new Error(`Refusing to run tests:\n- ${errors.join('\n- ')}`);

  const maintenance = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  let runDb: string;
  try {
    runDb = await createRunDatabase(maintenance);
  } catch (err) {
    await maintenance.end();
    throw new Error(
      `Could not create the per-run test database (the test role needs CREATEDB; see docs/LOCAL_DEVELOPMENT.md): ${(err as Error).message}`,
      { cause: err },
    );
  }
  project.provide('runDatabase', runDb);
  project.provide('runDatabaseUrl', runDatabaseUrl(process.env.TEST_DATABASE_URL!, runDb));

  return async () => {
    try {
      await dropRunDatabase(maintenance, runDb);
    } finally {
      await maintenance.end();
    }
  };
}
