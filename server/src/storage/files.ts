import type { Response } from 'express';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { detectType, keyFor, sanitizeName, sha256Hex, type AllowedType, type FileStorage } from './storage.js';

export interface StoredFile {
  id: string;
  sha256: string;
  size_bytes: number;
  mime_type: AllowedType;
  original_name: string | null;
  uploaded_at: Date;
  reused: boolean;
}

/**
 * Validates and stores one uploaded file. Identical bytes (same SHA-256) reuse the existing stored
 * file: retries and re-uploads never duplicate storage (exact duplicate detection, F-022 basis).
 */
export async function storeUpload(
  db: Queryable,
  storage: FileStorage,
  bytes: Buffer,
  opts: { declaredType: string | undefined; originalName: string | undefined; userId: string; allowed: readonly AllowedType[] },
): Promise<StoredFile> {
  if (!bytes.length) throw new AppError(400, 'empty_file', 'The file is empty');
  const detected = detectType(bytes);
  if (!detected || !opts.allowed.includes(detected)) {
    throw new AppError(415, 'unsupported_file', 'Unsupported file type', { allowed: opts.allowed });
  }
  const declared = (opts.declaredType ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared && declared !== detected && !(declared === 'image/jpg' && detected === 'image/jpeg')) {
    throw new AppError(415, 'type_mismatch', 'The file content does not match its declared type');
  }
  const sha = sha256Hex(bytes);
  const existing = await db.query<Omit<StoredFile, 'reused'>>(
    'SELECT id, sha256, size_bytes, mime_type, original_name, uploaded_at FROM stored_files WHERE sha256 = $1 LIMIT 1',
    [sha],
  );
  if (existing.rows[0]) {
    if (!(await storage.exists(keyFor(sha)))) await storage.put(keyFor(sha), bytes); // repair a lost blob
    return { ...existing.rows[0], reused: true };
  }
  const key = keyFor(sha);
  if (!(await storage.exists(key))) await storage.put(key, bytes);
  const { rows } = await db.query<Omit<StoredFile, 'reused'>>(
    `INSERT INTO stored_files (storage_key, sha256, size_bytes, mime_type, original_name, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, sha256, size_bytes, mime_type, original_name, uploaded_at`,
    [key, sha, bytes.length, detected, sanitizeName(opts.originalName), opts.userId],
  );
  return { ...rows[0]!, reused: false };
}

/** Streams a private stored file with headers that stop caching, sniffing and script execution. */
export async function sendStoredFile(
  res: Response,
  storage: FileStorage,
  f: { storage_key: string; mime_type: string; size_bytes: number; original_name: string | null },
): Promise<void> {
  if (!(await storage.exists(f.storage_key))) throw new AppError(410, 'file_missing', 'The stored file is missing');
  res.setHeader('Content-Type', f.mime_type);
  res.setHeader('Content-Length', String(f.size_bytes));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  const safeName = (f.original_name ?? 'document').replace(/[^\w.\- ]/g, '_');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  storage.read(f.storage_key).on('error', () => res.destroy()).pipe(res);
}
