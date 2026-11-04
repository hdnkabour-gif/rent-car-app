import { Router } from 'express';
import type { Db } from '../db/pool.js';
import { notFound } from '../http/errors.js';
import type { FileStorage } from '../storage/storage.js';
import { sendStoredFile } from '../storage/files.js';

/**
 * Public company identity so the app looks like the company's own app, even on the login page:
 * display name, city, colour and logo ONLY. No identifier (ICE, IF, RC), address, phone or any
 * business data is exposed here.
 */
export function brandingRouter(db: Db, storage: FileStorage): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    const { rows } = await db.query<{ trade_name: string; legal_name: string; city: string | null; brand_primary_color: string; show_company_branding: boolean; logo_file_id: string | null }>(
      'SELECT trade_name, legal_name, city, brand_primary_color, show_company_branding, logo_file_id FROM company_settings WHERE id = 1',
    );
    const s = rows[0];
    const show = s?.show_company_branding ?? true;
    res.json({
      name: show ? s?.trade_name || s?.legal_name || null : null,
      city: show ? (s?.city ?? null) : null,
      color: s?.brand_primary_color ?? '#1F4E79',
      logo: show && s?.logo_file_id ? `/api/branding/logo?v=${s.logo_file_id.slice(0, 8)}` : null,
    });
  });
  r.get('/logo', async (_req, res) => {
    const { rows } = await db.query<{ storage_key: string; mime_type: string; size_bytes: number; original_name: string | null }>(
      `SELECT f.storage_key, f.mime_type, f.size_bytes, f.original_name
         FROM company_settings s JOIN stored_files f ON f.id = s.logo_file_id WHERE s.id = 1 AND s.show_company_branding`,
    );
    if (!rows[0]) throw notFound('No logo');
    await sendStoredFile(res, storage, rows[0]);
  });
  return r;
}
