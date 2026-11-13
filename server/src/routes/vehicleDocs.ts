import express, { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/pool.js';
import { AppError, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { AppConfig } from '../config.js';
import { ALLOWED_TYPES, type FileStorage } from '../storage/storage.js';
import { sendStoredFile, storeUpload } from '../storage/files.js';
import { loadScoped } from './vehicles.js';
import { analyzeVehiclePhoto, VehicleImageKind } from '../ocr/vehicleOcr.js';
import { analyzePrivateDocument } from '../ocr/localOcr.js';
import { DocumentReviewPayload } from '../ocr/documentReview.js';
import { plateKey } from '../domain/plates.js';

export const DOC_TYPES = ['registration', 'insurance', 'technical_inspection', 'vignette', 'transport_authorization', 'other'] as const;
/** Documents expiring within this many days are flagged "expiring soon". */
export const EXPIRY_WARNING_DAYS = 30;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(d)), 'Invalid date');
const optDate = isoDate.nullish().or(z.literal('').transform(() => null));
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const DocBody = z
  .object({
    docType: z.enum(DOC_TYPES),
    label: optText(120),
    number: optText(80),
    issuer: optText(120),
    issueDate: optDate,
    expiryDate: optDate,
    notes: optText(2000),
  })
  .strict()
  .refine((d) => d.docType !== 'other' || d.label, { message: 'A name is required for "other" documents', path: ['label'] })
  .refine((d) => !d.issueDate || !d.expiryDate || d.expiryDate >= d.issueDate, {
    message: 'Expiry date is before issue date',
    path: ['expiryDate'],
  });

const Params = z.object({ id: z.uuid() });
const DocParams = z.object({ id: z.uuid(), docId: z.uuid() });
const PhotoParams = z.object({ id: z.uuid(), photoId: z.uuid() });
const FileParams = z.object({ id: z.uuid(), fileId: z.uuid() });

/** Status computed in the company time zone (Africa/Casablanca), never stored. */
const STATUS_SQL = `CASE
    WHEN d.archived_at IS NOT NULL THEN 'archived'
    WHEN d.expiry_date IS NULL THEN 'no_expiry'
    WHEN d.expiry_date < (now() AT TIME ZONE 'Africa/Casablanca')::date THEN 'expired'
    WHEN d.expiry_date <= (now() AT TIME ZONE 'Africa/Casablanca')::date + ${EXPIRY_WARNING_DAYS} THEN 'expiring'
    ELSE 'valid' END`;

const DOC_SELECT = `
  SELECT d.id, d.doc_type, d.label, d.number, d.issuer, d.issue_date::text, d.expiry_date::text, d.notes,
         d.archived_at, d.created_at, d.updated_at, ${STATUS_SQL} AS status,
         (d.expiry_date - (now() AT TIME ZONE 'Africa/Casablanca')::date) AS days_left,
         f.id AS file_id, f.mime_type, f.size_bytes, f.original_name,
         vr.fields AS review_fields, vr.status AS review_status, vr.revision AS review_revision,
         vr.reviewed_at AS reviewed_at
    FROM vehicle_documents d LEFT JOIN stored_files f ON f.id = d.file_id
    LEFT JOIN vehicle_document_reviews vr ON vr.document_id = d.id AND vr.file_id = d.file_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docDto = (d: any) => ({
  id: d.id,
  docType: d.doc_type,
  label: d.label,
  number: d.number,
  issuer: d.issuer,
  issueDate: d.issue_date,
  expiryDate: d.expiry_date,
  notes: d.notes,
  status: d.status as 'valid' | 'expiring' | 'expired' | 'no_expiry' | 'archived',
  daysLeft: d.days_left === null ? null : Number(d.days_left),
  archivedAt: d.archived_at,
  file: d.file_id ? { id: d.file_id, mimeType: d.mime_type, sizeBytes: d.size_bytes, name: d.original_name } : null,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  review: d.review_status ? {status:d.review_status,fields:d.review_fields,
    revision:d.review_revision,reviewedAt:d.reviewed_at} : null,
});

export function vehicleDocsRouter(db: Db, config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: config.maxUploadBytes });

  /* ---------------- documents ---------------- */

  r.get('/:id/documents', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const { includeArchived } = parseQuery(z.object({ includeArchived: z.enum(['true', 'false']).optional() }), req);
    await loadScoped(db, res.locals.auth!, id);
    const { rows } = await db.query(
      `${DOC_SELECT} WHERE d.vehicle_id = $1 ${includeArchived === 'true' ? '' : 'AND d.archived_at IS NULL'}
        ORDER BY d.archived_at NULLS FIRST, d.expiry_date NULLS LAST, d.created_at DESC`,
      [id],
    );
    res.json({ items: rows.map(docDto) });
  });

  r.post('/:id/documents', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const b = parseBody(DocBody, req);
    const doc = await withTransaction(db, async (tx) => {
      const v = await loadScoped(tx, res.locals.auth!, id, true);
      if (v.status === 'retired') throw new AppError(409, 'vehicle_retired', 'The vehicle is retired');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO vehicle_documents (vehicle_id, doc_type, label, number, issuer, issue_date, expiry_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [id, b.docType, b.label, b.number, b.issuer, b.issueDate ?? null, b.expiryDate ?? null, b.notes, res.locals.auth!.user.id],
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'vehicle.document_create',
        targetType: 'vehicle',
        targetId: id,
        metadata: { documentId: rows[0]!.id, docType: b.docType, expiryDate: b.expiryDate ?? null },
      });
      return (await tx.query(`${DOC_SELECT} WHERE d.id = $1`, [rows[0]!.id])).rows[0];
    });
    res.status(201).json(docDto(doc));
  });

  r.put('/:id/documents/:docId', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const { id, docId } = parseParams(DocParams, req);
    const b = parseBody(DocBody, req);
    const doc = await withTransaction(db, async (tx) => {
      await loadScoped(tx, res.locals.auth!, id, true);
      const before = (await tx.query(`${DOC_SELECT} WHERE d.id = $1 AND d.vehicle_id = $2 FOR UPDATE OF d`, [docId, id])).rows[0];
      if (!before) throw notFound('Document not found');
      if (before.archived_at) throw new AppError(409, 'document_archived', 'An archived document cannot be edited');
      await tx.query(
        `UPDATE vehicle_documents SET doc_type = $2, label = $3, number = $4, issuer = $5, issue_date = $6, expiry_date = $7,
                notes = $8, updated_at = now() WHERE id = $1`,
        [docId, b.docType, b.label, b.number, b.issuer, b.issueDate ?? null, b.expiryDate ?? null, b.notes],
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'vehicle.document_update',
        targetType: 'vehicle',
        targetId: id,
        metadata: {
          documentId: docId,
          from: { docType: before.doc_type, number: before.number, expiryDate: before.expiry_date },
          to: { docType: b.docType, number: b.number, expiryDate: b.expiryDate ?? null },
        },
      });
      return (await tx.query(`${DOC_SELECT} WHERE d.id = $1`, [docId])).rows[0];
    });
    res.json(docDto(doc));
  });

  r.post('/:id/documents/:docId/archive', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const { id, docId } = parseParams(DocParams, req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }).strict(), req);
    await withTransaction(db, async (tx) => {
      await loadScoped(tx, res.locals.auth!, id, true);
      const upd = await tx.query(
        'UPDATE vehicle_documents SET archived_at = now(), updated_at = now() WHERE id = $1 AND vehicle_id = $2 AND archived_at IS NULL',
        [docId, id],
      );
      if (!upd.rowCount) throw notFound('Document not found');
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'vehicle.document_archive',
        targetType: 'vehicle',
        targetId: id,
        metadata: { documentId: docId, reason },
      });
    });
    res.status(204).end();
  });

  /** Attach (or replace) the scanned file of a document. The previous file stays stored for history. */
  r.put('/:id/documents/:docId/file', requirePermission(db, 'vehicles.documents'), raw, async (req, res) => {
    const { id, docId } = parseParams(DocParams, req);
    const auth = res.locals.auth!;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const doc = await withTransaction(db, async (tx) => {
      await loadScoped(tx, auth, id, true);
      const cur = await tx.query<{ file_id: string | null; archived_at: Date | null }>(
        'SELECT file_id, archived_at FROM vehicle_documents WHERE id = $1 AND vehicle_id = $2 FOR UPDATE',
        [docId, id],
      );
      if (!cur.rows[0]) throw notFound('Document not found');
      if (cur.rows[0].archived_at) throw new AppError(409, 'document_archived', 'An archived document cannot be edited');
      const file = await storeUpload(tx, storage, bytes, {
        declaredType: req.get('content-type'),
        originalName: req.get('x-file-name'),
        userId: auth.user.id,
        allowed: ALLOWED_TYPES,
      });
      await tx.query('UPDATE vehicle_documents SET file_id = $2, updated_at = now() WHERE id = $1', [docId, file.id]);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'vehicle.document_file',
        targetType: 'vehicle',
        targetId: id,
        metadata: { documentId: docId, fileId: file.id, previousFileId: cur.rows[0].file_id, sizeBytes: file.size_bytes, type: file.mime_type },
      });
      return (await tx.query(`${DOC_SELECT} WHERE d.id = $1`, [docId])).rows[0];
    });
    res.json(docDto(doc));
  });

  /**
   * Vehicle paperwork OCR is separate from client identity documents and contracts.
   * Recognition never updates the fleet. Only the manager receives scan suggestions.
   */
  r.post('/:id/documents/:docId/analyze', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const { id, docId } = parseParams(DocParams,req);
    const auth = res.locals.auth!;
    if (auth.user.role !== 'manager') throw new AppError(403,'forbidden','Only manager may scan paperwork');
    const vehicle = await loadScoped(db,auth,id);
    const found = await db.query<{
      doc_type: typeof DOC_TYPES[number]; storage_key:string;size_bytes:number;mime_type:string;
    }>(`SELECT d.doc_type,f.storage_key,f.size_bytes,f.mime_type
      FROM vehicle_documents d JOIN stored_files f ON f.id=d.file_id
      WHERE d.id=$1 AND d.vehicle_id=$2 AND d.archived_at IS NULL`,[docId,id]);
    const doc = found.rows[0];
    if (!doc) throw notFound('Document with attached scan not found');
    const kind = doc.doc_type === 'other' ? 'other_vehicle' : doc.doc_type;
    const output = await analyzePrivateDocument(storage,doc,kind);
    const suggestedPlate = output.fields.plateNumber?.value;
    const storedPlate = typeof vehicle.plate === 'string' ? vehicle.plate : '';
    const plateMatch = suggestedPlate && storedPlate
      ? plateKey(suggestedPlate) === plateKey(storedPlate) : null;
    await recordAudit(db,{
      ...auditContext(req,res),action:'vehicle.document_ocr_analyzed',
      targetType:'vehicle_document',targetId:docId,
      metadata:{vehicleId:id,fieldCount:Object.keys(output.fields).length,plateMatch},
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json({suggestions:output.fields,quality:output.quality,warnings:output.warnings,
      enhanced:output.enhanced ?? false,requiresHumanReview:true,comparisons:{plateMatch}});
  });

  r.put('/:id/documents/:docId/review', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const { id, docId } = parseParams(DocParams,req);
    const auth = res.locals.auth!;
    if (auth.user.role !== 'manager') throw new AppError(403,'forbidden','Only manager can approve paperwork');
    const review = parseBody(DocumentReviewPayload,req);
    const result = await withTransaction(db,async tx=>{
      await loadScoped(tx,auth,id,true);
      const found = await tx.query<{file_id:string}>(
        `SELECT file_id FROM vehicle_documents WHERE id=$1 AND vehicle_id=$2
         AND archived_at IS NULL AND file_id IS NOT NULL FOR UPDATE`,[docId,id],
      );
      const fileId = found.rows[0]?.file_id;
      if (!fileId) throw notFound('Scanned document not found');
      const before = await tx.query<{revision:number;status:string;fields:Record<string,string>}>(
        `SELECT revision,status,fields FROM vehicle_document_reviews
         WHERE document_id=$1 AND file_id=$2 FOR UPDATE`,[docId,fileId],
      );
      const prior = before.rows[0];
      if ((prior?.revision ?? 0) !== review.expectedRevision)
        throw new AppError(409,'stale_document_review','Document changed; reload before saving');
      const out = await tx.query<{revision:number}>(
        `INSERT INTO vehicle_document_reviews
           (document_id,file_id,fields,status,reviewed_by,reason)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6)
         ON CONFLICT (document_id,file_id) DO UPDATE SET
           fields=EXCLUDED.fields,status=EXCLUDED.status,reviewed_by=EXCLUDED.reviewed_by,
           reason=EXCLUDED.reason,reviewed_at=now(),
           revision=vehicle_document_reviews.revision+1 RETURNING revision`,
        [docId,fileId,JSON.stringify(review.fields),review.status,auth.user.id,review.reason ?? null],
      );
      await recordAudit(tx,{
        ...auditContext(req,res),action:'vehicle.document_reviewed',
        targetType:'vehicle_document',targetId:docId,
        metadata:{vehicleId:id,fileId,status:review.status,
          previousStatus:prior?.status ?? null,revision:out.rows[0]!.revision,
          modifiedFields:Object.keys(review.fields).filter(k=>review.fields[k]!==prior?.fields[k])},
      });
      return out.rows[0]!;
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json({status:review.status,revision:result.revision});
  });

  /* ---------------- photos ---------------- */

  const PHOTO_SELECT = `SELECT p.id, p.caption, p.created_at, u.full_name AS created_by_name, f.id AS file_id, f.size_bytes
                          FROM vehicle_photos p JOIN stored_files f ON f.id = p.file_id
                          LEFT JOIN users u ON u.id = p.created_by`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const photoDto = (p: any) => ({ id: p.id, caption: p.caption, createdAt: p.created_at, createdBy: p.created_by_name, fileId: p.file_id, sizeBytes: p.size_bytes });

  r.get('/:id/photos', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    await loadScoped(db, res.locals.auth!, id);
    const { rows } = await db.query(`${PHOTO_SELECT} WHERE p.vehicle_id = $1 AND p.archived_at IS NULL ORDER BY p.created_at DESC`, [id]);
    res.json({ items: rows.map(photoDto) });
  });

  /** One photo per request (the phone sends several in a row). Re-sending the same photo is idempotent. */
  r.post('/:id/photos', requirePermission(db, 'vehicles.documents'), raw, async (req, res) => {
    const { id } = parseParams(Params, req);
    const auth = res.locals.auth!;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const caption = (req.get('x-caption') ? decodeURIComponent(req.get('x-caption')!) : '').trim().slice(0, 200) || null;
    const result = await withTransaction(db, async (tx) => {
      const v = await loadScoped(tx, auth, id, true);
      if (v.status === 'retired') throw new AppError(409, 'vehicle_retired', 'The vehicle is retired');
      const file = await storeUpload(tx, storage, bytes, {
        declaredType: req.get('content-type'),
        originalName: req.get('x-file-name'),
        userId: auth.user.id,
        allowed: ['image/jpeg', 'image/png', 'image/webp'],
      });
      const existing = await tx.query(`${PHOTO_SELECT} WHERE p.vehicle_id = $1 AND p.file_id = $2 AND p.archived_at IS NULL`, [id, file.id]);
      if (existing.rows[0]) return { photo: existing.rows[0], duplicate: true };
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO vehicle_photos (vehicle_id, file_id, caption, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [id, file.id, caption, auth.user.id],
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'vehicle.photo_add',
        targetType: 'vehicle',
        targetId: id,
        metadata: { photoId: rows[0]!.id, fileId: file.id, sizeBytes: file.size_bytes },
      });
      return { photo: (await tx.query(`${PHOTO_SELECT} WHERE p.id = $1`, [rows[0]!.id])).rows[0], duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json({ ...photoDto(result.photo), duplicate: result.duplicate });
  });

  /** Manager-only OCR suggestions, never changes the registered plate or recorded mileage. */
  r.post('/:id/photos/:photoId/analyze', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const {id, photoId} = parseParams(PhotoParams,req);
    const {kind} = parseBody(z.object({kind:VehicleImageKind}).strict(),req);
    const auth=res.locals.auth!;
    if (auth.user.role !== 'manager') {
      throw new AppError(403,'forbidden','Only a manager may analyze vehicle photos');
    }
    await loadScoped(db,auth,id);
    const {rows}=await db.query<{storage_key:string;mime_type:string;size_bytes:number}>(
      `SELECT f.storage_key,f.mime_type,f.size_bytes
         FROM vehicle_photos p JOIN stored_files f ON f.id=p.file_id
         WHERE p.id=$1 AND p.vehicle_id=$2 AND p.archived_at IS NULL`,
      [photoId,id],
    );
    if(!rows[0]) throw notFound('Active vehicle photo not found');
    const analysis=await analyzeVehiclePhoto(storage,rows[0],kind);
    await recordAudit(db,{
      ...auditContext(req,res),action:'vehicle.photo_ocr_review',
      targetType:'vehicle',targetId:id,
      metadata:{photoId,kind,candidateCount:analysis.kind==='vehicle_odometer'
        ?analysis.candidates.length:Object.keys(analysis.fields).length},
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json(analysis);
  });

  r.post('/:id/photos/:photoId/archive', requirePermission(db, 'vehicles.documents'), async (req, res) => {
    const { id, photoId } = parseParams(PhotoParams, req);
    await withTransaction(db, async (tx) => {
      await loadScoped(tx, res.locals.auth!, id, true);
      const upd = await tx.query('UPDATE vehicle_photos SET archived_at = now() WHERE id = $1 AND vehicle_id = $2 AND archived_at IS NULL', [photoId, id]);
      if (!upd.rowCount) throw notFound('Photo not found');
      await recordAudit(tx, { ...auditContext(req, res), action: 'vehicle.photo_archive', targetType: 'vehicle', targetId: id, metadata: { photoId } });
    });
    res.status(204).end();
  });

  /* ---------------- private file download ---------------- */

  /** Served only if the file is linked to this vehicle and the vehicle is in the user's branch scope. */
  r.get('/:id/files/:fileId', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const { id, fileId } = parseParams(FileParams, req);
    await loadScoped(db, res.locals.auth!, id);
    const { rows } = await db.query<{ storage_key: string; mime_type: string; size_bytes: number; original_name: string | null }>(
      `SELECT f.storage_key, f.mime_type, f.size_bytes, f.original_name FROM stored_files f
        WHERE f.id = $1 AND (EXISTS (SELECT 1 FROM vehicle_photos p WHERE p.file_id = f.id AND p.vehicle_id = $2)
                          OR EXISTS (SELECT 1 FROM vehicle_documents d WHERE d.file_id = f.id AND d.vehicle_id = $2))`,
      [fileId, id],
    );
    const f = rows[0];
    if (!f) throw notFound('File not found');
    await sendStoredFile(res, storage, f);
  });

  return r;
}
