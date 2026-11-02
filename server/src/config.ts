import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1'));

const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFrom(3000, 1, 65535),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  COOKIE_SECURE: bool,
  SESSION_IDLE_MINUTES: intFrom(60, 1, 24 * 60),
  SESSION_ABSOLUTE_HOURS: intFrom(12, 1, 24 * 14),
  LOGIN_RATE_LIMIT_MAX: intFrom(20, 1, 10000),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: intFrom(15, 1, 24 * 60),
  ACCOUNT_LOCKOUT_THRESHOLD: intFrom(5, 1, 100),
  ACCOUNT_LOCKOUT_MINUTES: intFrom(15, 1, 24 * 60),
  TRUST_PROXY: bool,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_DIST_DIR: z.string().optional(),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  appOrigins: string[];
  cookie: { name: string; secure: boolean };
  session: { idleMinutes: number; absoluteHours: number };
  login: {
    rateLimitMax: number;
    rateLimitWindowMinutes: number;
    lockoutThreshold: number;
    lockoutMinutes: number;
  };
  trustProxy: boolean;
  logLevel: string;
  webDistDir: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only report variable names and problems, never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const secure = e.COOKIE_SECURE ?? e.NODE_ENV === 'production';
  if (e.NODE_ENV === 'production' && !secure) {
    throw new Error('Invalid configuration: COOKIE_SECURE must be true in production (serve over HTTPS).');
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    appOrigins: e.APP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    // "__Host-" prefix requires Secure + Path=/ + no Domain; browsers then reject cookie injection
    // from sibling subdomains. Plain name is used for local HTTP development.
    cookie: { name: secure ? '__Host-fleetora_sid' : 'fleetora_sid', secure },
    session: { idleMinutes: e.SESSION_IDLE_MINUTES, absoluteHours: e.SESSION_ABSOLUTE_HOURS },
    login: {
      rateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
      rateLimitWindowMinutes: e.LOGIN_RATE_LIMIT_WINDOW_MINUTES,
      lockoutThreshold: e.ACCOUNT_LOCKOUT_THRESHOLD,
      lockoutMinutes: e.ACCOUNT_LOCKOUT_MINUTES,
    },
    trustProxy: e.TRUST_PROXY ?? false,
    logLevel: e.LOG_LEVEL,
    webDistDir: e.WEB_DIST_DIR || undefined,
  };
}
