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
  /** Schema health compares migration versions AND checksums; no SQL or file paths are exposed. */
  r.get('/schema', async (_req, res) => {
    const files = await loadMigrations();
    const expectedVersions = files.map((f) => f.version);
    const known = new Map(files.map((f) => [f.version, f.checksum]));
    let applied: { version: string; checksum: string }[] = [];
    try {
      applied = (await db.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      )).rows;
    } catch {
      // The migration table may not exist yet, or the database may be unavailable.
      res.status(503).json({
        upToDate: false, applied: 0, expected: files.length, latest: null,
        missing: expectedVersions, unexpected: [], checksumMismatches: [],
      });
      return;
    }
    const installed = new Set(applied.map((row) => row.version));
    const missing = expectedVersions.filter((version) => !installed.has(version));
    const unexpected = applied.filter((row) => !known.has(row.version)).map((row) => row.version);
    const checksumMismatches = applied
      .filter((row) => known.has(row.version) && known.get(row.version) !== row.checksum)
      .map((row) => row.version);
    const upToDate = missing.length === 0 && unexpected.length === 0 && checksumMismatches.length === 0;
    res.status(upToDate ? 200 : 503).json({
      upToDate, applied: applied.length, expected: files.length,
      latest: applied.at(-1)?.version ?? null, missing, unexpected, checksumMismatches,
    });
  });

  return r;
}
