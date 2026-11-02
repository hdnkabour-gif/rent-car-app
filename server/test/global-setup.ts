/**
 * Fails fast with a clear message if the test database is not configured.
 * Tests use TEST_DATABASE_URL only; they wipe its public schema, so it must never point at real data.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Create an empty, disposable PostgreSQL database for tests (see README).');
  }
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error('Refusing to run: TEST_DATABASE_URL database name must contain "test" (it is wiped by the tests).');
  }
}
