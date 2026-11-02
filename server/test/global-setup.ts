import { checkTestDatabaseTarget } from '../src/db/target-guard.js';

/**
 * First safety layer, before any test file runs: the test database must be local, named *_test
 * and different from the application database. The content check runs before every wipe
 * (see resetDatabase in helpers.ts).
 */
export default function setup() {
  const errors = checkTestDatabaseTarget(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  if (errors.length) throw new Error(`Refusing to run tests:\n- ${errors.join('\n- ')}`);
}
