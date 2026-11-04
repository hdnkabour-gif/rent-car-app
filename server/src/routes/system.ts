import { Router } from 'express';
import type { Db } from '../db/pool.js';
import type { AppConfig } from '../config.js';
import { requirePermission } from '../auth/middleware.js';

/** A backup older than this is reported as overdue (nightly schedule + margin). */
export const BACKUP_OVERDUE_HOURS = 36;

/**
 * Health of what protects company data, for the manager: is file storage configured on a
 * persistent location, and when did the last verified backup run? No paths or secrets returned.
 */
export function systemRouter(db: Db, config: AppConfig): Router {
  const r = Router();
  r.get('/status', requirePermission(db, 'company_settings.update'), async (_req, res) => {
    const last = (
      await db.query<{ finished_at: Date; ok: boolean; encrypted: boolean; files: number | null; problems: number; overdue: boolean }>(
        `SELECT finished_at, ok, encrypted, files, problems, finished_at < now() - make_interval(hours => $1) AS overdue
           FROM backup_runs ORDER BY id DESC LIMIT 1`,
        [BACKUP_OVERDUE_HOURS],
      )
    ).rows[0];
    const lastOk = (await db.query<{ finished_at: Date }>('SELECT finished_at FROM backup_runs WHERE ok ORDER BY id DESC LIMIT 1')).rows[0];
    res.json({
      storage: {
        // In production the files must live on a mounted volume / company disk set by STORAGE_DIR.
        persistentConfigured: !config.storageDirIsDefault,
        warning: config.env === 'production' && config.storageDirIsDefault,
      },
      backup: {
        last: last ? { at: last.finished_at, ok: last.ok, encrypted: last.encrypted, files: last.files, problems: last.problems } : null,
        lastOkAt: lastOk?.finished_at ?? null,
        overdueHours: BACKUP_OVERDUE_HOURS,
        warning: !last || !last.ok || last.overdue,
      },
    });
  });
  return r;
}
