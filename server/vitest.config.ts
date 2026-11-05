import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Load server/.env (if present) so TEST_DATABASE_URL is available without extra tooling on Windows.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one PostgreSQL test database; run files serially.
    fileParallelism: false,
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
