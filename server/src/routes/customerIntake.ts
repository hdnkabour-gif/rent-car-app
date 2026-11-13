import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { requirePermission } from '../auth/middleware.js';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { parseBody, parseParams } from '../http/validate.js';
import { branchFilter } from '../domain/scope.js';
import { loadScoped } from './vehicles.js';
import { recordAudit, auditContext } from '../audit/audit.js';
import { ALLOWED_TYPES, type FileStorage } from '../storage/storage.js';
import { sendStoredFile, storeUpload } from '../storage/files.js';

const TZ = 'Africa/Casablanca';
const ID = z.object({ id: z.uuid() });
const FILE = z.object({ id: z.uuid(), fileId: z.uuid() });
const KINDS = ['id_front', 'id_back', 'passport', 'licence_front', 'licence_back', 'residence_permit', 'other'] as const;
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const Create = z.object({
  vehicleId: z.uuid(),
  start: localTime,
  end: localTime,
  dailyCents: z.number().int().min(0).max(100_000_000).optional(),
  depositCents: z.number().int().min(0).max(100_000_000).optional(),
  expiryMinutes: z.number().int().min(15).max(10080).default(1440),
}).strict().refine(v => v.end > v.start, { path: ['end'], message: 'The return must follow pickup' });
const Verify = z.object({ code: z.string().regex(/^\d{10}$/) }).strict();
const Attach = z.object({ customerId: z.uuid() }).strict();
const codeHash = (code: string, salt: string) => scryptSync(code, salt, 32);
const randomCode = () => String(randomInt(0, 10_000_000_000)).padStart(10, '0');

/** A guest never gets vehicle identifiers, customer data, filenames or document bytes. */
function publicOffer(link: Record<string, unknown>) {
  return {
    vehicle: { make: link.make, model: link.model },
    startAt: link.start_at, endAt: link.end_at, days: link.days,
    dailyCents: link.daily_cents, totalCents: Number(link.daily_cents) * Number(link.days),
    depositCents: link.deposit_cents, expiresAt: link.expires_at,
  };
}

type LinkRow = {
  id: string; status: string; expires_at: Date; failed_attempts: number; code_salt: string;
  code_hash: string; created_by: string; consent_at: Date | null; vehicle_id: string;
  branch_id: string; daily_cents: number; deposit_cents: number; days: number;
  start_at: Date; end_at: Date; make?: string; model?: string;
};

/**
 * Link and secret code are two separate factors. Every public POST requires the secret again;
 * the code never goes in a URL, cookie or browser storage. Failed guesses are locked in PostgreSQL.
 */
async function verifyLink(tx: Queryable, id: string, code: string, acceptSubmitted = false): Promise<LinkRow> {
  const { rows } = await tx.query<LinkRow>(
    'SELECT * FROM customer_intake_links WHERE id = $1 FOR UPDATE', [id],
  );
  const row = rows[0];
  if (!row || row.status === 'revoked' || row.status === 'accepted' || row.expires_at <= new Date()) {
    throw new AppError(410, 'intake_unavailable', 'This invitation is not available');
  }
  if (row.failed_attempts >= 5) throw new AppError(429, 'intake_locked', 'Too many attempts; request a new invitation');
  const expected = Buffer.from(row.code_hash, 'hex');
  const computed = codeHash(code, row.code_salt);
  if (expected.length !== computed.length || !timingSafeEqual(expected, computed)) {
    // This update must COMMIT, so invalid credentials return a result and are rejected afterwards.
    await tx.query('UPDATE customer_intake_links SET failed_attempts = failed_attempts + 1 WHERE id = $1', [id]);
    throw new AppError(401, 'intake_code_invalid', 'Invalid invitation code');
  }
  if (row.status === 'submitted' && !acceptSubmitted) throw new AppError(409, 'intake_submitted', 'Documents have already been submitted');
  return row;
}

async function checkGuest(db: Db, id: string, code: string, submitted = false): Promise<LinkRow> {
  // Invalid codes must be recorded outside a rolled-back transaction.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let result: LinkRow | undefined;
    let rejection: AppError | undefined;
    try {
      result = await verifyLink(client, id, code, submitted);
    } catch (err) {
      if (err instanceof AppError && err.code === 'intake_code_invalid') rejection = err;
      else throw err;
    }
    await client.query('COMMIT');
    if (rejection) throw rejection;
    return result!;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function customerIntakeGuestRouter(db: Db, config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  const limit = rateLimit({
    windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'rate_limited', 'Too many requests')),
  });
  r.use(limit);
  r.post('/:id/verify', async (req, res) => {
    const { id } = parseParams(ID, req);
    const { code } = parseBody(Verify, req);
    await checkGuest(db, id, code, true);
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT g.*, v.make, v.model FROM customer_intake_links g
       JOIN vehicles v ON v.id = g.vehicle_id WHERE g.id = $1`, [id],
    );
    res.json({ offer: publicOffer(rows[0]!), submitted: rows[0]?.status === 'submitted' });
  });
  const raw = express.raw({ type: () => true, limit: config.maxUploadBytes });
  r.post('/:id/documents/:kind', raw, async (req, res) => {
    const { id } = parseParams(ID, req);
    const kind = z.enum(KINDS).parse(req.params.kind);
    const code = z.string().regex(/^\d{10}$/).parse(req.get('x-intake-code'));
    if (req.get('x-privacy-consent') !== 'yes') {
      throw new AppError(400, 'consent_required', 'Please confirm the privacy notice');
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Validate credentials before writing a file. Each upload is then separately locked and audited.
    await checkGuest(db, id, code);
    const output = await withTransaction(db, async (tx) => {
      const row = await verifyLink(tx, id, code);
      const count = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM customer_intake_documents WHERE intake_id = $1', [id],
      );
      if (count.rows[0]!.n >= 10) throw new AppError(409, 'intake_limit', 'Maximum 10 documents per invitation');
      const file = await storeUpload(tx, storage, bytes, {
        declaredType: req.get('content-type'), originalName: req.get('x-file-name'),
        userId: row.created_by, allowed: ALLOWED_TYPES,
      });
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO customer_intake_documents (intake_id, file_id, kind)
         VALUES ($1,$2,$3) ON CONFLICT (intake_id,file_id) DO NOTHING RETURNING id`,
        [id, file.id, kind],
      );
      await tx.query(
        `UPDATE customer_intake_links SET status='submitted', submitted_at=coalesce(submitted_at,now()),
          consent_at=coalesce(consent_at,now()) WHERE id=$1`, [id],
      );
      await recordAudit(tx, {
        ...auditContext(req, res), actorUserId: null,
        action: 'intake.document_received', targetType: 'customer_intake', targetId: id,
        metadata: { kind, fileId: file.id, duplicate: !inserted.rowCount },
      });
      return { accepted: true, duplicate: !inserted.rowCount };
    });
    res.status(output.duplicate ? 200 : 201).json(output);
  });
  return r;
}

export function customerIntakeStaffRouter(db: Db, _config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  r.post('/', requirePermission(db, 'reservations.manage'), async (req, res) => {
    const b = parseBody(Create, req);
    const auth = res.locals.auth!;
    const vehicle = await loadScoped(db, auth, b.vehicleId);
    if (vehicle.status === 'retired' || vehicle.status === 'out_of_service') {
      throw new AppError(409, 'vehicle_unavailable', 'Vehicle cannot be offered');
    }
    const dailyCents = b.dailyCents ?? vehicle.daily_rate_cents;
    if (dailyCents === null || dailyCents === undefined) throw new AppError(400, 'price_required', 'Set a price first');
    if (vehicle.daily_rate_cents !== null && dailyCents !== vehicle.daily_rate_cents && !auth.permissions.includes('pricing.change')) {
      throw forbidden('Only an authorized person may change the daily price');
    }
    const pricing = (await db.query<{ start: Date; end: Date; days: number; past: boolean }>(
      `SELECT s AS start, e AS end, GREATEST(1,ceil(extract(epoch from (e-s))/86400))::int AS days,
         s < now()-interval '1 hour' AS past
       FROM (SELECT ($1::timestamp AT TIME ZONE '${TZ}') s, ($2::timestamp AT TIME ZONE '${TZ}') e) t`,
      [b.start, b.end],
    )).rows[0]!;
    if (pricing.past || pricing.end <= pricing.start || pricing.days > 366) {
      throw new AppError(400, 'invalid_period', 'Invalid rental period');
    }
    const conflicts = await db.query(
      `SELECT 1 FROM reservations WHERE vehicle_id = $1
        AND status IN ('confirmed','in_progress') AND period && tstzrange($2,$3,'[)') LIMIT 1`,
      [vehicle.id, pricing.start, pricing.end],
    );
    if (conflicts.rowCount) throw new AppError(409, 'vehicle_unavailable', 'Vehicle is already reserved in this period');
    const code = randomCode();
    const salt = randomBytes(16).toString('hex');
    const { rows } = await db.query<{ id: string; expires_at: Date }>(
      `INSERT INTO customer_intake_links
       (branch_id,vehicle_id,created_by,start_at,end_at,days,daily_cents,deposit_cents,code_salt,code_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+($11::int*interval '1 minute'))
       RETURNING id,expires_at`,
      [vehicle.branch_id, vehicle.id, auth.user.id, pricing.start, pricing.end, pricing.days,
        dailyCents, b.depositCents ?? vehicle.deposit_cents ?? 0, salt, codeHash(code, salt).toString('hex'), b.expiryMinutes],
    );
    await recordAudit(db, {
      ...auditContext(req, res), action: 'intake.created', targetType: 'customer_intake',
      targetId: rows[0]!.id, metadata: { vehicleId: vehicle.id, expiryMinutes: b.expiryMinutes },
    });
    res.status(201).setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      id: rows[0]!.id, path: `/collect/${rows[0]!.id}`,
      code, expiresAt: rows[0]!.expires_at,
    });
  });
  r.get('/', requirePermission(db, 'reservations.read'), async (_req, res) => {
    const params: unknown[] = [];
    const scope = branchFilter(res.locals.auth!, 'g.branch_id', params);
    const { rows } = await db.query(
      `SELECT g.id,g.status,g.created_at,g.expires_at,g.submitted_at,g.days,g.daily_cents,g.deposit_cents,
         v.make,v.model, (SELECT count(*)::int FROM customer_intake_documents d WHERE d.intake_id=g.id) AS document_count
       FROM customer_intake_links g JOIN vehicles v ON v.id=g.vehicle_id
       WHERE ${scope} ORDER BY g.created_at DESC LIMIT 100`, params,
    );
    res.json({ items: rows });
  });
  r.get('/:id', requirePermission(db, 'reservations.read'), async (req, res) => {
    const { id } = parseParams(ID, req);
    const params: unknown[] = [id];
    const scope = branchFilter(res.locals.auth!, 'g.branch_id', params);
    const { rows } = await db.query(
      `SELECT g.id,g.status,g.created_at,g.expires_at,g.submitted_at,g.consent_at,g.days,
        g.daily_cents,g.deposit_cents,g.vehicle_id,v.make,v.model
        FROM customer_intake_links g JOIN vehicles v ON v.id=g.vehicle_id
        WHERE g.id=$1 AND ${scope}`, params,
    );
    if (!rows[0]) throw notFound('Invitation not found');
    const docs = await db.query(
      `SELECT d.id,d.kind,d.received_at,f.id AS file_id,f.mime_type,f.size_bytes
       FROM customer_intake_documents d JOIN stored_files f ON f.id=d.file_id
       WHERE d.intake_id=$1 ORDER BY d.received_at`, [id],
    );
    res.json({ intake: rows[0], documents: docs.rows });
  });
  r.get('/:id/files/:fileId', requirePermission(db, 'customers.read'), async (req, res) => {
    const { id, fileId } = parseParams(FILE, req);
    const params: unknown[] = [id, fileId];
    const scope = branchFilter(res.locals.auth!, 'g.branch_id', params);
    const { rows } = await db.query<{ storage_key: string; mime_type: string; size_bytes: number; original_name: string | null }>(
      `SELECT f.storage_key,f.mime_type,f.size_bytes,f.original_name
       FROM customer_intake_links g JOIN customer_intake_documents d ON d.intake_id=g.id
       JOIN stored_files f ON f.id=d.file_id WHERE g.id=$1 AND f.id=$2 AND ${scope}`, params,
    );
    if (!rows[0]) throw notFound('Document not found');
    await sendStoredFile(res, storage, rows[0]);
  });
  r.post('/:id/revoke', requirePermission(db, 'reservations.manage'), async (req, res) => {
    const { id } = parseParams(ID, req);
    const params: unknown[] = [id];
    const scope = branchFilter(res.locals.auth!, 'branch_id', params);
    const result = await db.query(
      `UPDATE customer_intake_links SET status='revoked' WHERE id=$1 AND status IN ('open','submitted')
       AND ${scope} RETURNING id`, params,
    );
    if (!result.rowCount) throw notFound('Active invitation not found');
    await recordAudit(db, { ...auditContext(req,res), action:'intake.revoked', targetType:'customer_intake', targetId:id });
    res.status(204).end();
  });
  r.post('/:id/attach', requirePermission(db, 'customers.verify'), async (req, res) => {
    const { id } = parseParams(ID, req);
    const { customerId } = parseBody(Attach, req);
    const auth = res.locals.auth!;
    if (!auth.permissions.includes('customers.manage')) throw forbidden();
    const out = await withTransaction(db, async tx => {
      const params: unknown[] = [id];
      const scope = branchFilter(auth, 'g.branch_id', params);
      const { rows } = await tx.query<{ status: string; consent_at: Date | null }>(
        `SELECT g.status,g.consent_at FROM customer_intake_links g WHERE g.id=$1 AND ${scope} FOR UPDATE OF g`, params,
      );
      if (!rows[0] || rows[0].status !== 'submitted' || !rows[0].consent_at) {
        throw new AppError(409, 'intake_not_ready', 'Only a reviewed, consented submission may be attached');
      }
      if (!(await tx.query('SELECT 1 FROM customers WHERE id=$1', [customerId])).rowCount) throw notFound('Customer not found');
      const inserted = await tx.query(
        `INSERT INTO customer_documents (customer_id,doc_kind,file_id,created_by)
         SELECT $2,d.kind,d.file_id,$3 FROM customer_intake_documents d WHERE d.intake_id=$1
         ON CONFLICT DO NOTHING RETURNING id`, [id, customerId, auth.user.id],
      );
      await tx.query(
        `UPDATE customer_intake_links SET status='accepted',accepted_customer_id=$2 WHERE id=$1`, [id, customerId],
      );
      await recordAudit(tx, {
        ...auditContext(req,res), action:'intake.attached', targetType:'customer_intake', targetId:id,
        metadata: { customerId, documentCount: inserted.rowCount },
      });
      return { accepted: true, pendingHumanReview: true, attached: inserted.rowCount ?? 0 };
    });
    res.json(out);
  });
  return r;
}
