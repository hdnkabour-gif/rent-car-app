import pg from 'pg';
import request from 'supertest';
import type { Express } from 'express';
import { pino } from 'pino';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/auth/password.js';

export const CSRF = { 'X-Requested-With': 'fleetora' };

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    APP_ORIGINS: 'http://localhost:5173',
    LOGIN_RATE_LIMIT_MAX: '1000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export interface TestContext {
  pool: pg.Pool;
  app: Express;
  config: AppConfig;
}

/** Drops and recreates the public schema, then applies all migrations. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(pool);
}

export async function setupTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const config = testConfig(overrides);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  await resetDatabase(pool);
  const app = createApp({ config, db: pool, logger: pino({ level: 'silent' }) });
  return { pool, app, config };
}

// Low scrypt cost keeps fixture creation fast; production parameters are exercised in password tests.
const FAST = { log2N: 12 };

export async function createUser(
  pool: pg.Pool,
  opts: { email: string; role: 'manager' | 'employee'; password?: string; fullName?: string; isActive?: boolean },
): Promise<{ id: string; email: string; password: string }> {
  const password = opts.password ?? 'Correct-Horse-9';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, full_name, role_code, password_hash, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [opts.email, opts.fullName ?? `Test ${opts.role}`, opts.role, await hashPassword(password, FAST), opts.isActive ?? true],
  );
  return { id: rows[0]!.id, email: opts.email, password };
}

/** Logs in and returns a supertest agent that carries the session cookie. */
export async function loginAgent(app: Express, email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set(CSRF).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

export async function auditRows(pool: pg.Pool, action?: string) {
  const { rows } = await pool.query(
    `SELECT * FROM audit_logs ${action ? 'WHERE action = $1' : ''} ORDER BY id`,
    action ? [action] : [],
  );
  return rows;
}
