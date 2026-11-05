import express, { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { AppConfig } from '../config.js';
import { ALLOWED_TYPES, type FileStorage } from '../storage/storage.js';
import { sendStoredFile, storeUpload } from '../storage/files.js';
import { docNumberKey, phoneKey, phoneSearchKeys } from '../domain/customers.js';
import { EXPIRY_WARNING_DAYS } from './vehicleDocs.js';

export const CUSTOMER_DOC_KINDS = ['id_front', 'id_back', 'passport', 'licence_front', 'licence_back', 'residence_permit', 'other'] as const;

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

const CustomerBody = z
  .object({
    customerType: z.enum(['individual', 'company']).default('individual'),
    fullName: z.string().trim().min(2).max(160),
    companyIce: optText(15),
    contactPerson: optText(160),
    birthDate: optDate,
    nationality: optText(80),
    residence: z.enum(['morocco', 'abroad_mre', 'abroad_foreign']).default('morocco'),
    phone: z.string().trim().min(6).max(40),
    phone2: optText(40),
    whatsappSamePhone: z.boolean().default(true),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(200)
      .nullish()
      .transform((v) => (v ? v : null))
      .refine((v) => v === null || z.email().safeParse(v).success, 'Invalid email address'),
    address: optText(300),
    city: optText(100),
    country: optText(80),
    preferredLanguage: z.enum(['fr', 'ar', 'en', 'es']).default('fr'),
    idDocType: z.enum(['cin', 'passport', 'residence_permit', 'other']).nullish().transform((v) => v ?? null),
    idDocNumber: optText(40),
    idDocCountry: optText(80),
    idDocExpiry: optDate,
    licenceNumber: optText(40),
    licenceCategory: optText(20),
    licenceCountry: optText(80),
    licenceIssueDate: optDate,
    licenceExpiry: optDate,
    profession: optText(120),
    otherAddress: optText(300),
    idDocIssueDate: optDate,
    notes: optText(2000),
    /** Set after staff saw the "possible duplicate" warning and confirmed it is another person. */
    acknowledgeDuplicates: z.boolean().optional(),
  })
  .strict()
  .refine((b) => phoneKey(b.phone) !== null, { message: 'Invalid phone number', path: ['phone'] })
  .refine((b) => !b.phone2 || phoneKey(b.phone2) !== null, { message: 'Invalid phone number', path: ['phone2'] })
  .refine((b) => !b.idDocNumber || b.idDocType, { message: 'Choose the document type', path: ['idDocType'] })
  .refine((b) => !b.idDocNumber || docNumberKey(b.idDocNumber), { message: 'Invalid document number', path: ['idDocNumber'] })
  .refine((b) => b.customerType === 'company' || !b.companyIce, { message: 'ICE is for companies', path: ['companyIce'] })
  .refine((b) => !b.companyIce || /^\d{15}$/.test(b.companyIce), { message: 'ICE has 15 digits', path: ['companyIce'] })
  .refine((b) => !b.licenceIssueDate || !b.licenceExpiry || b.licenceExpiry >= b.licenceIssueDate, {
    message: 'Expiry date is before issue date',
    path: ['licenceExpiry'],
  });
type CustomerInput = z.infer<typeof CustomerBody>;

const Params = z.object({ id: z.uuid() });
const DocParams = z.object({ id: z.uuid(), docId: z.uuid() });
const FileParams = z.object({ id: z.uuid(), fileId: z.uuid() });

const TODAY = `(now() AT TIME ZONE 'Africa/Casablanca')::date`;
const expiryStatus = (col: string) =>
  `CASE WHEN ${col} IS NULL THEN NULL WHEN ${col} < ${TODAY} THEN 'expired'
        WHEN ${col} <= ${TODAY} + ${EXPIRY_WARNING_DAYS} THEN 'expiring' ELSE 'valid' END`;

const SELECT = `
  SELECT c.*, c.birth_date::text AS birth_date_s, c.id_doc_expiry::text AS id_doc_expiry_s,
         c.licence_issue_date::text AS licence_issue_date_s, c.id_doc_issue_date::text AS id_doc_issue_date_s, c.licence_expiry::text AS licence_expiry_s,
         ${expiryStatus('c.id_doc_expiry')} AS id_doc_status, ${expiryStatus('c.licence_expiry')} AS licence_status,
         cb.full_name AS created_by_name, bb.full_name AS blocked_by_name,
         (SELECT count(*)::int FROM customer_documents d WHERE d.customer_id = c.id AND d.archived_at IS NULL) AS document_count,
         (SELECT count(*)::int FROM customer_documents d
           WHERE d.customer_id = c.id AND d.archived_at IS NULL AND d.review_status = 'pending') AS pending_documents
    FROM customers c
    LEFT JOIN users cb ON cb.id = c.created_by
    LEFT JOIN users bb ON bb.id = c.blocked_by`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toDto = (c: any) => ({
  id: c.id,
  customerType: c.customer_type,
  fullName: c.full_name,
  companyIce: c.company_ice,
  contactPerson: c.contact_person,
  birthDate: c.birth_date_s,
  nationality: c.nationality,
  residence: c.residence,
  phone: c.phone,
  phoneKey: c.phone_key,
  phone2: c.phone2,
  whatsappSamePhone: c.whatsapp_same_phone,
  email: c.email,
  address: c.address,
  city: c.city,
  country: c.country,
  preferredLanguage: c.preferred_language,
  idDocType: c.id_doc_type,
  idDocNumber: c.id_doc_number,
  idDocCountry: c.id_doc_country,
  idDocExpiry: c.id_doc_expiry_s,
  idDocStatus: c.id_doc_status as 'valid' | 'expiring' | 'expired' | null,
  licenceNumber: c.licence_number,
  licenceCategory: c.licence_category,
  licenceCountry: c.licence_country,
  licenceIssueDate: c.licence_issue_date_s,
  licenceExpiry: c.licence_expiry_s,
  licenceStatus: c.licence_status as 'valid' | 'expiring' | 'expired' | null,
  notes: c.notes,
  profession: c.profession,
  otherAddress: c.other_address,
  idDocIssueDate: c.id_doc_issue_date_s,
  blocked: c.blocked_at ? { at: c.blocked_at, reason: c.blocked_reason, by: c.blocked_by_name } : null,
  documentCount: c.document_count,
  pendingDocuments: c.pending_documents,
  createdBy: c.created_by_name,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const DOC_SELECT = `
  SELECT d.id, d.doc_kind, d.source, d.review_status, d.review_note, d.reviewed_at, d.archived_at, d.created_at,
         u.full_name AS created_by_name, r.full_name AS reviewed_by_name,
         f.id AS file_id, f.mime_type, f.size_bytes, f.original_name
    FROM customer_documents d JOIN stored_files f ON f.id = d.file_id
    LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN users r ON r.id = d.reviewed_by`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docDto = (d: any) => ({
  id: d.id,
  kind: d.doc_kind,
  source: d.source,
  reviewStatus: d.review_status as 'pending' | 'verified' | 'rejected',
  reviewNote: d.review_note,
  reviewedAt: d.reviewed_at,
  reviewedBy: d.reviewed_by_name,
  archivedAt: d.archived_at,
  createdAt: d.created_at,
  createdBy: d.created_by_name,
  file: { id: d.file_id, mimeType: d.mime_type, sizeBytes: d.size_bytes, name: d.original_name },
});

interface DuplicateMatch {
  id: string;
  fullName: string;
  phone: string;
  reasons: Array<'phone' | 'id_document' | 'licence'>;
}

/**
 * Possible duplicates: same phone (either number), same identity document number or same licence
 * number. A signal for staff, never an automatic merge (spec §5).
 */
async function findDuplicates(db: Queryable, b: CustomerInput, excludeId: string | null): Promise<DuplicateMatch[]> {
  const phones = [phoneKey(b.phone), phoneKey(b.phone2)].filter((x): x is string => Boolean(x));
  const idKey = docNumberKey(b.idDocNumber);
  const licenceKey = docNumberKey(b.licenceNumber);
  const { rows } = await db.query<{ id: string; full_name: string; phone: string; by_phone: boolean; by_id: boolean; by_licence: boolean }>(
    `SELECT id, full_name, phone,
            (phone_key = ANY($1::text[]) OR phone2_key = ANY($1::text[])) AS by_phone,
            ($2::text IS NOT NULL AND id_doc_number_key = $2) AS by_id,
            ($3::text IS NOT NULL AND regexp_replace(upper(coalesce(licence_number, '')), '[^0-9A-Z]', '', 'g') = $3) AS by_licence
       FROM customers
      WHERE ($4::uuid IS NULL OR id <> $4)
        AND (phone_key = ANY($1::text[]) OR phone2_key = ANY($1::text[])
             OR ($2::text IS NOT NULL AND id_doc_number_key = $2)
             OR ($3::text IS NOT NULL AND regexp_replace(upper(coalesce(licence_number, '')), '[^0-9A-Z]', '', 'g') = $3))
      ORDER BY updated_at DESC LIMIT 10`,
    [phones, idKey, licenceKey, excludeId],
  );
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    reasons: [...(r.by_phone ? ['phone' as const] : []), ...(r.by_id ? ['id_document' as const] : []), ...(r.by_licence ? ['licence' as const] : [])],
  }));
}

const values = (b: CustomerInput) => [
  b.customerType,
  b.fullName,
  b.customerType === 'company' ? b.companyIce : null,
  b.contactPerson,
  b.birthDate ?? null,
  b.nationality,
  b.residence,
  b.phone,
  phoneKey(b.phone),
  b.phone2,
  phoneKey(b.phone2),
  b.whatsappSamePhone,
  b.email,
  b.address,
  b.city,
  b.country,
  b.preferredLanguage,
  b.idDocType,
  b.idDocNumber,
  docNumberKey(b.idDocNumber),
  b.idDocCountry,
  b.idDocExpiry ?? null,
  b.licenceNumber,
  b.licenceCategory,
  b.licenceCountry,
  b.licenceIssueDate ?? null,
  b.licenceExpiry ?? null,
  b.notes,
  b.profession,
  b.otherAddress,
  b.idDocIssueDate ?? null,
];
const COLUMNS = `customer_type, full_name, company_ice, contact_person, birth_date, nationality, residence, phone, phone_key,
  phone2, phone2_key, whatsapp_same_phone, email, address, city, country, preferred_language, id_doc_type, id_doc_number,
  id_doc_number_key, id_doc_country, id_doc_expiry, licence_number, licence_category, licence_country, licence_issue_date,
  licence_expiry, notes, profession, other_address, id_doc_issue_date`;
const COLUMN_LIST = COLUMNS.split(',').map((c) => c.trim());

/** Field names only: identity numbers and other personal values never go into the audit log. */
const FIELD_NAMES: Record<string, string> = Object.fromEntries(
  COLUMN_LIST.filter((c) => !c.endsWith('_key')).map((c) => [c, c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase())]),
);

async function loadCustomer(db: Queryable, id: string, lock = false) {
  const { rows } = await db.query(`${SELECT} WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`, [id]);
  if (!rows[0]) throw notFound('Customer not found');
  return rows[0];
}

export function customersRouter(db: Db, config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: config.maxUploadBytes });

  r.get('/', requirePermission(db, 'customers.read'), async (req, res) => {
    const q = parseQuery(
      z.object({
        q: z.string().trim().max(80).optional(),
        filter: z.enum(['blocked', 'pending_documents', 'expired_documents']).optional(),
      }),
      req,
    );
    const params: unknown[] = [];
    const where: string[] = ['true'];
    if (q.q) {
      const clauses: string[] = [];
      params.push(`%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      clauses.push(`lower(c.full_name) LIKE $${params.length}`, `lower(coalesce(c.email, '')) LIKE $${params.length}`);
      for (const key of phoneSearchKeys(q.q)) {
        params.push(`%${key}%`);
        clauses.push(`c.phone_key LIKE $${params.length}`, `coalesce(c.phone2_key, '') LIKE $${params.length}`);
      }
      const idKey = docNumberKey(q.q);
      if (idKey && idKey.length >= 3) {
        params.push(`%${idKey}%`);
        clauses.push(`coalesce(c.id_doc_number_key, '') LIKE $${params.length}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    if (q.filter === 'blocked') where.push('c.blocked_at IS NOT NULL');
    if (q.filter === 'pending_documents') {
      where.push(`EXISTS (SELECT 1 FROM customer_documents d WHERE d.customer_id = c.id AND d.archived_at IS NULL AND d.review_status = 'pending')`);
    }
    if (q.filter === 'expired_documents') where.push(`(c.id_doc_expiry < ${TODAY} OR c.licence_expiry < ${TODAY})`);
    const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 100`, params);
    res.json({ items: rows.map(toDto) });
  });

  r.get('/summary', requirePermission(db, 'customers.read'), async (_req, res) => {
    const { rows } = await db.query<{ total: number; blocked: number; pending_documents: number }>(
      `SELECT (SELECT count(*)::int FROM customers) AS total,
              (SELECT count(*)::int FROM customers WHERE blocked_at IS NOT NULL) AS blocked,
              (SELECT count(*)::int FROM customer_documents WHERE archived_at IS NULL AND review_status = 'pending') AS pending_documents`,
    );
    res.json({ total: rows[0]!.total, blocked: rows[0]!.blocked, pendingDocuments: rows[0]!.pending_documents });
  });

  r.get('/:id', requirePermission(db, 'customers.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    res.json({ customer: toDto(await loadCustomer(db, id)) });
  });

  r.post('/', requirePermission(db, 'customers.manage'), async (req, res) => {
    const b = parseBody(CustomerBody, req);
    const auth = res.locals.auth!;
    const created = await withTransaction(db, async (tx) => {
      const matches = await findDuplicates(tx, b, null);
      if (matches.length && !b.acknowledgeDuplicates) {
        throw new AppError(409, 'possible_duplicate', 'A customer with the same phone or document number exists', { matches });
      }
      const placeholders = COLUMN_LIST.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO customers (${COLUMNS}, created_by) VALUES (${placeholders}, $${COLUMN_LIST.length + 1}) RETURNING id`,
        [...values(b), auth.user.id],
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'customer.create',
        targetType: 'customer',
        targetId: rows[0]!.id,
        metadata: { residence: b.residence, customerType: b.customerType, duplicateWarningAcknowledged: matches.length > 0 ? matches.map((m) => m.id) : null },
      });
      return loadCustomer(tx, rows[0]!.id);
    });
    res.status(201).json({ customer: toDto(created) });
  });

  r.put('/:id', requirePermission(db, 'customers.manage'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const b = parseBody(CustomerBody, req);
    const updated = await withTransaction(db, async (tx) => {
      const before = await loadCustomer(tx, id, true);
      const matches = await findDuplicates(tx, b, id);
      if (matches.length && !b.acknowledgeDuplicates) {
        throw new AppError(409, 'possible_duplicate', 'A customer with the same phone or document number exists', { matches });
      }
      const vals = values(b);
      const set = COLUMN_LIST.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await tx.query(`UPDATE customers SET ${set}, updated_at = now() WHERE id = $1`, [id, ...vals]);
      const after = await loadCustomer(tx, id);
      const changedFields = Object.keys(FIELD_NAMES).filter((c) => {
        const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null));
        return JSON.stringify(norm(before[c])) !== JSON.stringify(norm(after[c]));
      });
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'customer.update',
        targetType: 'customer',
        targetId: id,
        metadata: { changedFields: changedFields.map((c) => FIELD_NAMES[c]) },
      });
      return after;
    });
    res.json({ customer: toDto(updated) });
  });

  r.post('/:id/block', requirePermission(db, 'customers.block'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), req);
    const c = await withTransaction(db, async (tx) => {
      const before = await loadCustomer(tx, id, true);
      if (before.blocked_at) throw new AppError(409, 'already_blocked', 'The customer is already marked "do not rent"');
      await tx.query('UPDATE customers SET blocked_at = now(), blocked_reason = $2, blocked_by = $3, updated_at = now() WHERE id = $1', [
        id,
        reason,
        res.locals.auth!.user.id,
      ]);
      await recordAudit(tx, { ...auditContext(req, res), action: 'customer.block', targetType: 'customer', targetId: id, metadata: { reason } });
      return loadCustomer(tx, id);
    });
    res.json({ customer: toDto(c) });
  });

  r.post('/:id/unblock', requirePermission(db, 'customers.block'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), req);
    const c = await withTransaction(db, async (tx) => {
      const before = await loadCustomer(tx, id, true);
      if (!before.blocked_at) throw new AppError(409, 'not_blocked', 'The customer is not blocked');
      await tx.query('UPDATE customers SET blocked_at = NULL, blocked_reason = NULL, blocked_by = NULL, updated_at = now() WHERE id = $1', [id]);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'customer.unblock',
        targetType: 'customer',
        targetId: id,
        metadata: { reason, previousReason: before.blocked_reason },
      });
      return loadCustomer(tx, id);
    });
    res.json({ customer: toDto(c) });
  });

  /* ---------------- document scans ---------------- */

  r.get('/:id/documents', requirePermission(db, 'customers.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const { includeArchived } = parseQuery(z.object({ includeArchived: z.enum(['true', 'false']).optional() }), req);
    await loadCustomer(db, id);
    const { rows } = await db.query(
      `${DOC_SELECT} WHERE d.customer_id = $1 ${includeArchived === 'true' ? '' : 'AND d.archived_at IS NULL'}
        ORDER BY d.archived_at NULLS FIRST, d.created_at DESC`,
      [id],
    );
    res.json({ items: rows.map(docDto) });
  });

  /**
   * One scan per request (raw body). The same scan again is idempotent. If the same file is
   * already attached to ANOTHER customer, the response lists them (exact duplicate warning, F-022).
   */
  r.post('/:id/documents', requirePermission(db, 'customers.manage'), raw, async (req, res) => {
    const { id } = parseParams(Params, req);
    const { kind } = parseQuery(z.object({ kind: z.enum(CUSTOMER_DOC_KINDS) }), req);
    const auth = res.locals.auth!;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await withTransaction(db, async (tx) => {
      await loadCustomer(tx, id, true);
      const file = await storeUpload(tx, storage, bytes, {
        declaredType: req.get('content-type'),
        originalName: req.get('x-file-name'),
        userId: auth.user.id,
        allowed: ALLOWED_TYPES,
      });
      const others = await tx.query<{ id: string; full_name: string }>(
        `SELECT DISTINCT c.id, c.full_name FROM customer_documents d JOIN customers c ON c.id = d.customer_id
          WHERE d.file_id = $1 AND d.customer_id <> $2`,
        [file.id, id],
      );
      const existing = await tx.query(`${DOC_SELECT} WHERE d.customer_id = $1 AND d.file_id = $2 AND d.archived_at IS NULL`, [id, file.id]);
      if (existing.rows[0]) return { doc: existing.rows[0], duplicate: true, others: others.rows };
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO customer_documents (customer_id, doc_kind, file_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [id, kind, file.id, auth.user.id],
      );
      await tx.query('UPDATE customers SET updated_at = now() WHERE id = $1', [id]);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'customer.document_add',
        targetType: 'customer',
        targetId: id,
        metadata: { documentId: rows[0]!.id, kind, fileId: file.id, sizeBytes: file.size_bytes, alsoLinkedToOtherCustomers: others.rows.length },
      });
      return { doc: (await tx.query(`${DOC_SELECT} WHERE d.id = $1`, [rows[0]!.id])).rows[0], duplicate: false, others: others.rows };
    });
    res.status(result.duplicate ? 200 : 201).json({
      ...docDto(result.doc),
      duplicate: result.duplicate,
      alsoLinkedTo: result.others.map((o) => ({ id: o.id, fullName: o.full_name })),
    });
  });

  r.post('/:id/documents/:docId/review', requirePermission(db, 'customers.verify'), async (req, res) => {
    const { id, docId } = parseParams(DocParams, req);
    const b = parseBody(
      z
        .object({ status: z.enum(['verified', 'rejected']), note: optText(500) })
        .strict()
        .refine((x) => x.status !== 'rejected' || x.note, { message: 'Say why the scan is rejected', path: ['note'] }),
      req,
    );
    const doc = await withTransaction(db, async (tx) => {
      const cur = await tx.query<{ review_status: string; archived_at: Date | null }>(
        'SELECT review_status, archived_at FROM customer_documents WHERE id = $1 AND customer_id = $2 FOR UPDATE',
        [docId, id],
      );
      if (!cur.rows[0]) throw notFound('Document not found');
      if (cur.rows[0].archived_at) throw new AppError(409, 'document_archived', 'An archived document cannot be reviewed');
      await tx.query(
        `UPDATE customer_documents SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
        [docId, b.status, b.note, res.locals.auth!.user.id],
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'customer.document_review',
        targetType: 'customer',
        targetId: id,
        metadata: { documentId: docId, from: cur.rows[0].review_status, to: b.status, note: b.note },
      });
      return (await tx.query(`${DOC_SELECT} WHERE d.id = $1`, [docId])).rows[0];
    });
    res.json(docDto(doc));
  });

  r.post('/:id/documents/:docId/archive', requirePermission(db, 'customers.manage'), async (req, res) => {
    const { id, docId } = parseParams(DocParams, req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }).strict(), req);
    await withTransaction(db, async (tx) => {
      const upd = await tx.query('UPDATE customer_documents SET archived_at = now() WHERE id = $1 AND customer_id = $2 AND archived_at IS NULL', [
        docId,
        id,
      ]);
      if (!upd.rowCount) throw notFound('Document not found');
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'customer.document_archive',
        targetType: 'customer',
        targetId: id,
        metadata: { documentId: docId, reason },
      });
    });
    res.status(204).end();
  });

  /** Served only if the file is a scan of this customer (archived scans included, for history). */
  r.get('/:id/files/:fileId', requirePermission(db, 'customers.read'), async (req, res) => {
    const { id, fileId } = parseParams(FileParams, req);
    const { rows } = await db.query<{ storage_key: string; mime_type: string; size_bytes: number; original_name: string | null }>(
      `SELECT f.storage_key, f.mime_type, f.size_bytes, f.original_name FROM stored_files f
        WHERE f.id = $1 AND EXISTS (SELECT 1 FROM customer_documents d WHERE d.file_id = f.id AND d.customer_id = $2)`,
      [fileId, id],
    );
    if (!rows[0]) throw notFound('File not found');
    await sendStoredFile(res, storage, rows[0]);
  });

  return r;
}
