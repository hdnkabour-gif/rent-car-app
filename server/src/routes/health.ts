import { Router } from 'express';
import { checkDatabase, type Db } from '../db/pool.js';

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
  return r;
}
