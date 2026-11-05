import { Router } from 'express';
import { checkDatabase, type Db } from '../db/pool.js';
import { loadMigrations } from '../db/migrate.js';

/**
 * Liveness/readiness probes. Unauthenticated, so they reveal nothing beyond up/down status.
 */
export function healthRouter(db: Db): Router {
  const r = Router();
  r.get('/', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });
  r.get('/db', async (_req, res) => {
    const result = await checkDatabase(db);
    res.status(result.ok ? 200 : 503).json({ status: result.ok ? 'ok' : 'unavailable', latencyMs: result.latencyMs });
  });
  /** Is the database schema at the version the code expects? (count and versions only) */
  r.get('/schema', async (_req, res) => {
    const files = await loadMigrations();
    let applied: string[] = [];
    try {
      applied = (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((x) => x.version);
    } catch {
      applied = [];
    }
    const expected = files.map((f) => f.version);
    const missing = expected.filter((v) => !applied.includes(v));
    res.status(missing.length ? 503 : 200).json({ upToDate: missing.length === 0, applied: applied.length, expected: expected.length, latest: applied.at(-1) ?? null, missing });
  });
  return r;
}
