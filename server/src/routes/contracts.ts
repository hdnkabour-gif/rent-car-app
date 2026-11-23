import express, { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { assertCustomerIdentityNotAliasedOrBlocked } from '../domain/customerAliases.js';
import { requirePermission } from '../auth/middleware.js';
import type { ResolvedSession } from '../auth/sessions.js';
import type { AppConfig } from '../config.js';
import { branchFilter } from '../domain/scope.js';
import { ALLOWED_TYPES, type FileStorage } from '../storage/storage.js';
import { sendStoredFile, storeUpload } from '../storage/files.js';
import { reservationRef } from './reservations.js';
import { analyzePrivateDocument } from '../ocr/localOcr.js';
import { DocumentReviewPayload } from '../ocr/documentReview.js';
import { plateKey } from '../domain/plates.js';

const TZ = 'Africa/Casablanca';
export const contractRef = (n: number | string) => `C-${String(n).padStart(5, '0')}`;
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const optDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .or(z.literal('').transform(() => null));
const money = z.number().int().min(1).max(100_000_000_00);

const Driver = z
  .object({
    fullName: z.string().trim().min(2).max(160),
    // Audit 2026-11-05: an other driver is checked like the renter (age, licence).
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    licenceNumber: z.string().trim().min(2).max(40),
    licenceIssueDate: optDate,
    licenceIssuePlace: optText(100),
    idNumber: optText(40),
    idIssueDate: optDate,
    phone: optText(40),
  })
  .strict();

const PaymentIn = z
  .object({
    kind: z.enum(['rental', 'deposit_in', 'deposit_out', 'deposit_kept']),
    method: z.enum(['cash', 'transfer', 'cheque', 'card']),
    amountCents: money,
    reference: optText(80),
    reason: optText(500),
  })
  .strict()
  .refine((p) => p.kind !== 'rental' || p.method === 'cash' || p.method === 'transfer', {
    message: 'The rental is paid in cash or by bank transfer',
    path: ['method'],
  })
  .refine((p) => p.kind !== 'deposit_kept' || p.reason, { message: 'Say why the deposit is kept', path: ['reason'] });

const CheckoutBody = z
  .object({
    reservationId: z.uuid(),
    paperNumber: optText(30),
    kmOut: z.number().int().min(0).max(5_000_000),
    fuelOut: z.number().int().min(0).max(8),
    washedOut: z.boolean().nullish(),
    documentsOut: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    notesOut: optText(2000),
    drivers: z.array(Driver).max(3).default([]),
    payments: z.array(PaymentIn).max(4).default([]),
  })
  .strict();

const CheckinBody = z
  .object({
    kmIn: z.number().int().min(0).max(5_000_000),
    fuelIn: z.number().int().min(0).max(8),
    notesIn: optText(2000),
    cleaned: z.boolean().nullish(),
    /** Late-return charge decided now (only by an authorized person); otherwise it stays pending. */
    late: z.lazy(() => LateDecision).optional(),
  })
  .strict();

/** Owner rule (2026-11-04): the manager decides a late return in whole days, half days or hours — or waives it. */
const LateDecision = z
  .object({
    decision: z.enum(['charge', 'waive']),
    unit: z.enum(['day', 'half_day', 'hour']).optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
    unitCents: z.number().int().min(0).max(100_000_000).optional(),
    reason: optText(500),
  })
  .strict()
  .refine((d) => d.decision === 'waive' || (d.unit && d.quantity && d.unitCents !== undefined), { message: 'Choose unit, quantity and price', path: ['quantity'] })
  .refine((d) => d.decision === 'charge' || d.reason, { message: 'Say why nothing is charged', path: ['reason'] });

const Params = z.object({ id: z.uuid() });
const PayParams = z.object({ id: z.uuid(), paymentId: z.uuid() });
const FileParams = z.object({ id: z.uuid(), fileId: z.uuid() });

const SELECT = `
  SELECT k.*, c.full_name AS customer_name, c.phone AS customer_phone, v.plate, v.make, v.model,
         b.name AS branch_name, rb.name AS return_branch_name, r.number AS reservation_number,
         uo.full_name AS out_by_name, ui.full_name AS in_by_name, t.version AS template_version
    FROM contracts k
    JOIN customers c ON c.id = k.customer_id
    JOIN vehicles v ON v.id = k.vehicle_id
    JOIN branches b ON b.id = k.branch_id
    JOIN branches rb ON rb.id = k.return_branch_id
    JOIN reservations r ON r.id = k.reservation_id
    JOIN contract_templates t ON t.id = k.template_id
    LEFT JOIN users uo ON uo.id = k.out_by
    LEFT JOIN users ui ON ui.id = k.in_by`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toDto = (k: any) => ({
  id: k.id,
  number: Number(k.number),
  reference: contractRef(k.number),
  paperNumber: k.paper_number,
  status: k.status as 'open' | 'closed',
  reservation: { id: k.reservation_id, reference: reservationRef(k.reservation_number) },
  customer: { id: k.customer_id, fullName: k.customer_name, phone: k.customer_phone },
  vehicle: { id: k.vehicle_id, plate: k.plate, make: k.make, model: k.model },
  branch: { id: k.branch_id, name: k.branch_name },
  returnBranch: { id: k.return_branch_id, name: k.return_branch_name },
  templateVersion: k.template_version,
  outAt: k.out_at,
  plannedEndAt: k.planned_end_at,
  kmOut: k.km_out,
  fuelOut: k.fuel_out,
  washedOut: k.washed_out,
  documentsOut: k.documents_out,
  notesOut: k.notes_out,
  outBy: k.out_by_name,
  dailyCents: k.daily_cents,
  days: k.days,
  late: {
    minutes: k.late_minutes,
    status: k.late_status as 'none' | 'pending' | 'charged' | 'waived',
    unit: k.late_unit,
    quantity: k.late_quantity,
    unitCents: k.late_unit_cents,
    feeCents: Number(k.late_fee_cents),
    reason: k.late_reason,
    decidedAt: k.late_decided_at,
  },
  totalCents: Number(k.total_cents),
  depositCents: k.deposit_cents,
  inAt: k.in_at,
  kmIn: k.km_in,
  fuelIn: k.fuel_in,
  notesIn: k.notes_in,
  inBy: k.in_by_name,
  kmDriven: k.km_in === null ? null : k.km_in - k.km_out,
  signedScanFileId: k.signed_scan_file_id,
  snapshot: k.snapshot,
  createdAt: k.created_at,
  updatedAt: k.updated_at,
});

async function loadContract(db: Queryable, auth: ResolvedSession, id: string, lock = false) {
  const params: unknown[] = [id];
  const scope = branchFilter(auth, 'k.branch_id', params);
  const { rows } = await db.query(`${SELECT} WHERE k.id = $1 AND ${scope}${lock ? ' FOR UPDATE OF k' : ''}`, params);
  if (!rows[0]) throw notFound('Contract not found');
  return rows[0];
}

/** Money position of a contract, from the ledger only. Deposits are never counted as rental paid. */
async function balances(db: Queryable, contractId: string, totalCents: number) {
  const { rows } = await db.query<{ paid: string; deposit_in: string; deposit_out: string; deposit_kept: string }>(
    `SELECT
       coalesce(sum(CASE WHEN p.kind = 'rental' THEN p.amount_cents WHEN p.kind = 'reversal' AND o.kind = 'rental' THEN -p.amount_cents
                         WHEN p.kind = 'rental_refund' THEN -p.amount_cents WHEN p.kind = 'reversal' AND o.kind = 'rental_refund' THEN p.amount_cents END), 0) AS paid,
       coalesce(sum(CASE WHEN p.kind = 'deposit_in' THEN p.amount_cents WHEN p.kind = 'reversal' AND o.kind = 'deposit_in' THEN -p.amount_cents END), 0) AS deposit_in,
       coalesce(sum(CASE WHEN p.kind = 'deposit_out' THEN p.amount_cents WHEN p.kind = 'reversal' AND o.kind = 'deposit_out' THEN -p.amount_cents END), 0) AS deposit_out,
       coalesce(sum(CASE WHEN p.kind = 'deposit_kept' THEN p.amount_cents WHEN p.kind = 'reversal' AND o.kind = 'deposit_kept' THEN -p.amount_cents END), 0) AS deposit_kept
       FROM payments p LEFT JOIN payments o ON o.id = p.reverses_id
      WHERE p.contract_id = $1`,
    [contractId],
  );
  const b = rows[0]!;
  const paid = Number(b.paid);
  const depositReceived = Number(b.deposit_in);
  const depositReturned = Number(b.deposit_out);
  const depositKept = Number(b.deposit_kept);
  return {
    totalCents,
    paidCents: paid,
    restCents: totalCents - paid,
    /** RC-03: rental money the customer paid beyond the total (e.g. after a paid late fee is waived). */
    overpaidCents: Math.max(paid - totalCents, 0),
    depositReceivedCents: depositReceived,
    depositReturnedCents: depositReturned,
    depositKeptCents: depositKept,
    depositHeldCents: depositReceived - depositReturned - depositKept,
  };
}

const PERMISSION_FOR: Record<z.infer<typeof PaymentIn>['kind'], string> = {
  rental: 'payments.record',
  deposit_in: 'payments.record',
  deposit_out: 'deposits.refund',
  deposit_kept: 'deposits.retain',
};

async function addPayment(
  tx: Queryable,
  auth: ResolvedSession,
  contract: { id: string; branch_id: string; total_cents: string | number },
  p: z.infer<typeof PaymentIn>,
): Promise<string> {
  if (!auth.permissions.includes(PERMISSION_FOR[p.kind])) throw forbidden('You are not allowed to record this movement');
  const bal = await balances(tx, contract.id, Number(contract.total_cents));
  if (p.kind === 'rental' && p.amountCents > bal.restCents) {
    throw new AppError(409, 'overpayment', 'This is more than the rest to pay', { restCents: bal.restCents });
  }
  if ((p.kind === 'deposit_out' || p.kind === 'deposit_kept') && p.amountCents > bal.depositHeldCents) {
    throw new AppError(409, 'deposit_exceeded', 'This is more than the deposit held', { depositHeldCents: bal.depositHeldCents });
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payments (contract_id, branch_id, kind, method, amount_cents, reference, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [contract.id, contract.branch_id, p.kind, p.method, p.amountCents, p.reference, p.reason, auth.user.id],
  );
  await tx.query(`INSERT INTO contract_events (contract_id, event, details, reason, actor_user_id) VALUES ($1, 'payment', $2, $3, $4)`, [
    contract.id,
    JSON.stringify({ paymentId: rows[0]!.id, kind: p.kind, method: p.method, amountCents: p.amountCents }),
    p.reason,
    auth.user.id,
  ]);
  return rows[0]!.id;
}

async function changeVehicleStatus(
  tx: Queryable,
  vehicleId: string,
  from: string,
  to: string,
  userId: string,
  km: number,
  fuel: number,
  contractId: string,
  cleaned: boolean | null = null,
  notes: string | null = null,
) {
  const upd = await tx.query(
    `UPDATE vehicles SET status = $3, status_changed_at = now(), mileage_km = $4, fuel_eighths = $5, updated_at = now()
      WHERE id = $1 AND status = $2`,
    [vehicleId, from, to, km, fuel],
  );
  if (upd.rowCount !== 1) throw new AppError(409, 'stale_status', 'The vehicle changed meanwhile. Reload and try again.');
  await tx.query(
    `INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, changed_by, mileage_km, fuel_eighths, cleaned, notes, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'contract', $9)`,
    [vehicleId, from, to, userId, km, fuel, cleaned, notes, contractId],
  );
}

/** Other drivers: same minimum age as the renter; refused below it (owner rule, audit 2026-11-05). */
async function insertDriver(tx: Queryable, contractId: string, d: z.infer<typeof Driver>, userId: string) {
  const s = (await tx.query<{ min_driver_age: number }>('SELECT min_driver_age FROM company_settings WHERE id = 1')).rows[0];
  const min = Math.max(18, s?.min_driver_age ?? 18);
  const age = (await tx.query<{ age: number }>(`SELECT extract(year FROM age((now() AT TIME ZONE 'Africa/Casablanca')::date, $1::date))::int AS age`, [d.birthDate])).rows[0]!.age;
  if (age < min) throw new AppError(409, 'driver_too_young', `Every driver must be at least ${min}`, { minAge: min, driver: d.fullName });
  await tx.query(
    `INSERT INTO contract_drivers (contract_id, full_name, birth_date, licence_number, licence_issue_date, licence_issue_place, id_number, id_issue_date, phone, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [contractId, d.fullName, d.birthDate, d.licenceNumber, d.licenceIssueDate ?? null, d.licenceIssuePlace, d.idNumber, d.idIssueDate ?? null, d.phone, userId],
  );
}

function overlapError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23P01' && e.constraint === 'reservations_no_overlap';
}

export function contractsRouter(db: Db, config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: config.maxUploadBytes });

  r.get('/', requirePermission(db, 'contracts.read'), async (req, res) => {
    const q = parseQuery(
      z.object({
        status: z.enum(['open', 'closed', 'late', 'late_fee', 'all']).default('open'),
        customerId: z.uuid().optional(),
        vehicleId: z.uuid().optional(),
        q: z.string().trim().max(60).optional(),
      }),
      req,
    );
    const params: unknown[] = [];
    const where = [branchFilter(res.locals.auth!, 'k.branch_id', params)];
    if (q.status === 'open' || q.status === 'closed') where.push(`k.status = '${q.status}'`);
    if (q.status === 'late') where.push(`k.status = 'open' AND k.planned_end_at < now()`);
    if (q.status === 'late_fee') where.push(`k.late_status = 'pending'`);
    if (q.customerId) {
      params.push(q.customerId);
      where.push(`k.customer_id = $${params.length}`);
    }
    if (q.vehicleId) {
      params.push(q.vehicleId);
      where.push(`k.vehicle_id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const t = params.length;
      const clauses = [`lower(c.full_name) LIKE $${t}`, `lower(v.plate) LIKE $${t}`, `lower(coalesce(k.paper_number, '')) LIKE $${t}`];
      const num = q.q.replace(/^[CR]-?/i, '');
      if (/^\d{1,12}$/.test(num)) {
        params.push(Number(num));
        clauses.push(`k.number = $${params.length}`, `r.number = $${params.length}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY k.status, k.planned_end_at LIMIT 200`, params);
    res.json({ items: rows.map(toDto) });
  });

  r.get('/summary', requirePermission(db, 'contracts.read'), async (_req, res) => {
    const params: unknown[] = [];
    const scope = branchFilter(res.locals.auth!, 'branch_id', params);
    const { rows } = await db.query<{ open: number; late: number; returns_today: number; late_fee_pending: number }>(
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'open' AND planned_end_at < now())::int AS late,
              count(*) FILTER (WHERE status = 'open' AND (planned_end_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date)::int AS returns_today,
              count(*) FILTER (WHERE late_status = 'pending')::int AS late_fee_pending
         FROM contracts WHERE ${scope}`,
      params,
    );
    res.json({ open: rows[0]!.open, late: rows[0]!.late, returnsToday: rows[0]!.returns_today, lateFeePending: rows[0]!.late_fee_pending });
  });

  r.get('/:id', requirePermission(db, 'contracts.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const k = await loadContract(db, res.locals.auth!, id);
    const [drivers, photos, events, payments, template] = await Promise.all([
      db.query(
        `SELECT id, full_name, birth_date::text, licence_number, licence_issue_date::text, licence_issue_place, id_number, id_issue_date::text, phone
           FROM contract_drivers WHERE contract_id = $1 ORDER BY created_at`,
        [id],
      ),
      db.query('SELECT id, phase, file_id, created_at FROM contract_photos WHERE contract_id = $1 ORDER BY created_at', [id]),
      db.query(
        `SELECT e.id, e.event, e.details, e.reason, e.occurred_at, u.full_name AS actor
           FROM contract_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.contract_id = $1 ORDER BY e.id`,
        [id],
      ),
      db.query(
        `SELECT p.id, p.kind, p.method, p.amount_cents, p.reference, p.reason, p.reverses_id, p.refunds_id, p.created_at, u.full_name AS by,
                (SELECT x.id FROM payments x WHERE x.reverses_id = p.id) AS reversed_by
           FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.contract_id = $1 ORDER BY p.created_at`,
        [id],
      ),
      db.query('SELECT * FROM contract_templates WHERE id = $1', [k.template_id]),
    ]);
    res.json({
      contract: toDto(k),
      balances: await balances(db, id, Number(k.total_cents)),
      drivers: drivers.rows.map((d) => ({
        id: d.id,
        fullName: d.full_name,
        birthDate: d.birth_date,
        licenceNumber: d.licence_number,
        licenceIssueDate: d.licence_issue_date,
        licenceIssuePlace: d.licence_issue_place,
        idNumber: d.id_number,
        idIssueDate: d.id_issue_date,
        phone: d.phone,
      })),
      photos: photos.rows.map((p) => ({ id: p.id, phase: p.phase, fileId: p.file_id, createdAt: p.created_at })),
      events: events.rows.map((e) => ({ id: Number(e.id), event: e.event, details: e.details, reason: e.reason, at: e.occurred_at, by: e.actor })),
      payments: payments.rows.map((p) => ({
        id: p.id,
        kind: p.kind,
        method: p.method,
        amountCents: Number(p.amount_cents),
        reference: p.reference,
        reason: p.reason,
        reversesId: p.reverses_id,
        refundsId: p.refunds_id,
        reversedBy: p.reversed_by,
        createdAt: p.created_at,
        by: p.by,
      })),
      template: templateDto(template.rows[0]),
    });
  });

  /** Check-out: the customer takes the vehicle. Creates the contract from a confirmed reservation. */
  r.post('/checkout', requirePermission(db, 'contracts.manage'), async (req, res) => {
    const b = parseBody(CheckoutBody, req);
    const auth = res.locals.auth!;
    try {
      const out = await withTransaction(db, async (tx) => {
        const params: unknown[] = [b.reservationId];
        const scope = branchFilter(auth, 'r.branch_id', params);
        const resv = (
          await tx.query(
            `SELECT r.*, r.end_at <= now() AS ended, r.start_at > now() AS early FROM reservations r WHERE r.id = $1 AND ${scope} FOR UPDATE OF r`,
            params,
          )
        ).rows[0];
        if (!resv) throw notFound('Reservation not found');
        if (resv.status !== 'confirmed') throw new AppError(409, 'reservation_not_confirmed', 'Only a confirmed reservation can be handed over');
        if (resv.ended) throw new AppError(409, 'reservation_past', 'The return date of this reservation is already past: change it first');

        await assertCustomerIdentityNotAliasedOrBlocked(tx,resv.customer_id);
        const customer = (
          await tx.query(`SELECT c.*, c.birth_date::text AS birth, c.id_doc_expiry::text AS id_exp, c.licence_expiry::text AS lic_exp,
                                 c.licence_issue_date::text AS lic_issue, c.id_doc_issue_date::text AS id_issue
                            FROM customers c WHERE c.id = $1 FOR UPDATE`, [resv.customer_id])
        ).rows[0];
        if (customer.blocked_at) throw new AppError(409, 'customer_blocked', 'This customer is marked "do not rent"');
        const settings = (await tx.query('SELECT * FROM company_settings WHERE id = 1')).rows[0] ?? {};
        if (customer.customer_type === 'individual' && customer.birth) {
          const age = (await tx.query<{ age: number }>(`SELECT extract(year FROM age((now() AT TIME ZONE '${TZ}')::date, $1::date))::int AS age`, [customer.birth])).rows[0]!.age;
          if (age < (settings.min_driver_age ?? 18)) throw new AppError(409, 'driver_too_young', 'The driver is under the minimum age');
        }

        const vehicle = (await tx.query('SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [resv.vehicle_id])).rows[0];
        if (vehicle.status !== 'available') {
          throw new AppError(409, 'vehicle_not_ready', 'The vehicle is not available: it must be inspected and available first', { status: vehicle.status });
        }
        if (b.kmOut < vehicle.mileage_km) {
          throw new AppError(422, 'mileage_decrease', 'Mileage cannot be lower than the last reading', { lastMileageKm: vehicle.mileage_km });
        }

        const template = (await tx.query('SELECT * FROM contract_templates ORDER BY version DESC LIMIT 1')).rows[0];
        const unknownDocs = b.documentsOut.filter((d) => !template.handed_documents.includes(d));
        if (unknownDocs.length) throw new AppError(400, 'validation_failed', 'Unknown document', [{ path: 'documentsOut', message: 'Unknown document' }]);

        // Early pickup: the booking starts now, so the vehicle stays protected against overlaps.
        if (resv.early) await tx.query('UPDATE reservations SET start_at = now(), updated_at = now() WHERE id = $1', [resv.id]);
        await tx.query(`UPDATE reservations SET status = 'in_progress', updated_at = now() WHERE id = $1`, [resv.id]);
        await tx.query(`INSERT INTO reservation_events (reservation_id, event, changes, actor_user_id) VALUES ($1, 'changed', $2, $3)`, [
          resv.id,
          JSON.stringify({ status: { from: 'confirmed', to: 'in_progress' } }),
          auth.user.id,
        ]);

        const branches = (await tx.query('SELECT id, name FROM branches WHERE id = ANY($1::uuid[])', [[resv.branch_id, resv.return_branch_id]])).rows;
        const bname = (bid: string) => branches.find((x) => x.id === bid)?.name ?? null;
        const snapshot = {
          company: {
            name: settings.trade_name || settings.legal_name || null,
            legalName: settings.legal_name || null,
            ice: settings.ice ?? null,
            ifNumber: settings.if_number ?? null,
            rcNumber: settings.rc_number ?? null,
            address: [settings.address_line, settings.city].filter(Boolean).join(', ') || null,
            phone: settings.phone ?? null,
            phone2: settings.phone2 ?? null,
            logoFileId: settings.logo_file_id ?? null,
            footer: settings.document_footer_text ?? null,
          },
          customer: {
            fullName: customer.full_name,
            customerType: customer.customer_type,
            companyIce: customer.company_ice,
            nationality: customer.nationality,
            birthDate: customer.birth,
            profession: customer.profession,
            idDocType: customer.id_doc_type,
            idDocNumber: customer.id_doc_number,
            idDocCountry: customer.id_doc_country,
            idDocIssueDate: customer.id_issue,
            idDocExpiry: customer.id_exp,
            licenceNumber: customer.licence_number,
            licenceIssueDate: customer.lic_issue,
            licenceCountry: customer.licence_country,
            licenceExpiry: customer.lic_exp,
            address: [customer.address, customer.city].filter(Boolean).join(', ') || null,
            otherAddress: customer.other_address ?? (customer.country ? customer.country : null),
            phone: customer.phone,
          },
          vehicle: { make: vehicle.make, model: vehicle.model, plate: vehicle.plate, fuelType: vehicle.fuel_type },
          reservation: {
            reference: reservationRef(resv.number),
            pickupPlace: resv.pickup_place,
            pickupDetails: resv.pickup_details,
            returnPlace: resv.return_place,
            returnDetails: resv.return_details,
          },
          branch: bname(resv.branch_id),
          returnBranch: bname(resv.return_branch_id),
        };

        const total = resv.days * resv.daily_cents;
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO contracts (paper_number, reservation_id, customer_id, vehicle_id, branch_id, return_branch_id, template_id,
                                  out_at, planned_end_at, km_out, fuel_out, washed_out, documents_out, notes_out, out_by,
                                  daily_cents, days, total_cents, deposit_cents, snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
          [
            b.paperNumber, resv.id, resv.customer_id, resv.vehicle_id, resv.branch_id, resv.return_branch_id, template.id, resv.end_at,
            b.kmOut, b.fuelOut, b.washedOut ?? null, b.documentsOut, b.notesOut, auth.user.id, resv.daily_cents, resv.days, total,
            resv.deposit_cents, JSON.stringify(snapshot),
          ],
        );
        const id = ins.rows[0]!.id;
        await changeVehicleStatus(tx, vehicle.id, 'available', 'rented', auth.user.id, b.kmOut, b.fuelOut, id, null, b.notesOut);
        for (const d of b.drivers) await insertDriver(tx, id, d, auth.user.id);
        await tx.query(`INSERT INTO contract_events (contract_id, event, details, actor_user_id) VALUES ($1, 'checked_out', $2, $3)`, [
          id,
          JSON.stringify({ kmOut: b.kmOut, fuelOut: b.fuelOut, documentsOut: b.documentsOut, drivers: b.drivers.length }),
          auth.user.id,
        ]);
        const contract = { id, branch_id: resv.branch_id, total_cents: total };
        for (const p of b.payments) await addPayment(tx, auth, contract, p);
        const row = await loadContract(tx, auth, id);
        await recordAudit(tx, {
          ...auditContext(req, res),
          action: 'contract.checkout',
          targetType: 'contract',
          targetId: id,
          metadata: { reference: contractRef(row.number), reservation: reservationRef(resv.number), kmOut: b.kmOut, fuelOut: b.fuelOut, paperNumber: b.paperNumber },
        });
        return row;
      });
      res.status(201).json({ contract: toDto(out) });
    } catch (err) {
      if (overlapError(err)) throw new AppError(409, 'vehicle_unavailable', 'The vehicle is still booked before this reservation');
      if ((err as { code?: string; constraint?: string }).constraint === 'contracts_paper_number_key') {
        throw new AppError(409, 'paper_number_used', 'This paper contract number is already used');
      }
      throw err;
    }
  });

  /** Prolongation before the return; the vehicle stays protected for the new dates. */
  r.post('/:id/extend', requirePermission(db, 'contracts.extend'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const b = parseBody(z.object({ newEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), reason: optText(500) }).strict(), req);
    const auth = res.locals.auth!;
    try {
      const row = await withTransaction(db, async (tx) => {
        const k = await loadContract(tx, auth, id, true);
        if (k.status !== 'open') throw new AppError(409, 'contract_closed', 'The contract is closed');
        const t = (
          await tx.query<{ e: Date; add: number; ok: boolean }>(
            `SELECT e, ceil(extract(epoch FROM (e - $2::timestamptz)) / 86400)::int AS add, e > $2::timestamptz AS ok
               FROM (SELECT $1::timestamp AT TIME ZONE '${TZ}' AS e) x`,
            [b.newEnd, k.planned_end_at],
          )
        ).rows[0]!;
        if (!t.ok) throw new AppError(400, 'validation_failed', 'The new return must be after the planned return', [{ path: 'newEnd', message: 'Too early' }]);
        await tx.query('UPDATE reservations SET end_at = $2, updated_at = now() WHERE id = $1', [k.reservation_id, t.e]);
        const days = k.days + t.add;
        await tx.query('UPDATE contracts SET planned_end_at = $2, days = $3, total_cents = $3::integer * daily_cents::bigint + late_fee_cents, updated_at = now() WHERE id = $1', [id, t.e, days]);
        await tx.query(`INSERT INTO contract_events (contract_id, event, details, reason, actor_user_id) VALUES ($1, 'extended', $2, $3, $4)`, [
          id,
          JSON.stringify({ from: k.planned_end_at, to: t.e, addedDays: t.add }),
          b.reason,
          auth.user.id,
        ]);
        await recordAudit(tx, { ...auditContext(req, res), action: 'contract.extend', targetType: 'contract', targetId: id, metadata: { addedDays: t.add, reason: b.reason } });
        return loadContract(tx, auth, id);
      });
      res.json({ contract: toDto(row) });
    } catch (err) {
      if (overlapError(err)) throw new AppError(409, 'vehicle_unavailable', 'The vehicle is booked by another customer for part of the new dates');
      throw err;
    }
  });

  /** What a return now would mean: how late, and suggested charges per unit (the manager decides). */
  r.get('/:id/return-preview', requirePermission(db, 'contracts.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const k = await loadContract(db, res.locals.auth!, id);
    res.json(await lateInfo(db, k.planned_end_at, k.daily_cents));
  });

  async function lateInfo(q: Queryable, plannedEnd: Date, dailyCents: number, at: Date | null = null) {
    const s = (await q.query<{ late_grace_minutes: number }>('SELECT late_grace_minutes FROM company_settings WHERE id = 1')).rows[0];
    const grace = s?.late_grace_minutes ?? 60;
    const late = (
      await q.query<{ m: number }>('SELECT greatest(0, floor(extract(epoch FROM (coalesce($2::timestamptz, now()) - $1::timestamptz)) / 60))::int AS m', [plannedEnd, at])
    ).rows[0]!.m;
    return {
      lateMinutes: late,
      graceMinutes: grace,
      isLate: late > grace,
      // Suggestions only: nothing is charged until an authorized person decides.
      suggestions: { day: Math.max(1, Math.ceil(late / 1440)), half_day: Math.max(1, Math.ceil(late / 720)), hour: Math.max(1, Math.ceil(late / 60)) },
      unitPrices: { day: dailyCents, half_day: Math.round(dailyCents / 2), hour: Math.round(dailyCents / 24 / 100) * 100 },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function applyLateDecision(tx: Queryable, req: any, res: any, k: any, d: z.infer<typeof LateDecision>) {
    const auth = res.locals.auth as ResolvedSession;
    if (!auth.permissions.includes('pricing.change')) throw forbidden('Only an authorized person decides the late-return charge');
    const fee = d.decision === 'charge' ? d.quantity! * d.unitCents! : 0;
    await tx.query(
      `UPDATE contracts SET late_status = $2, late_unit = $3, late_quantity = $4, late_unit_cents = $5, late_fee_cents = $6,
              late_reason = $7, late_decided_by = $8, late_decided_at = now(),
              total_cents = days::bigint * daily_cents + $6, updated_at = now()
        WHERE id = $1`,
      [k.id, d.decision === 'charge' ? 'charged' : 'waived', d.decision === 'charge' ? d.unit : null, d.decision === 'charge' ? d.quantity : null,
        d.decision === 'charge' ? d.unitCents : null, fee, d.reason, auth.user.id],
    );
    const details = { decision: d.decision, unit: d.unit ?? null, quantity: d.quantity ?? null, unitCents: d.unitCents ?? null, feeCents: fee, previous: { status: k.late_status, feeCents: Number(k.late_fee_cents) } };
    await tx.query(`INSERT INTO contract_events (contract_id, event, details, reason, actor_user_id) VALUES ($1, 'late_fee', $2, $3, $4)`, [k.id, JSON.stringify(details), d.reason, auth.user.id]);
    await recordAudit(tx, { ...auditContext(req, res), action: 'contract.late_fee', targetType: 'contract', targetId: k.id, metadata: { ...details, reason: d.reason } });
  }

  /** Check-in: the vehicle comes back. It goes to "inspection pending" (BR-09). */
  r.post('/:id/checkin', requirePermission(db, 'contracts.manage'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const b = parseBody(CheckinBody, req);
    const auth = res.locals.auth!;
    const out = await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      if (k.status !== 'open') throw new AppError(409, 'contract_closed', 'The vehicle was already returned');
      if (b.kmIn < k.km_out) throw new AppError(422, 'mileage_decrease', 'Return mileage is lower than at departure', { kmOut: k.km_out });
      const late = await lateInfo(tx, k.planned_end_at, k.daily_cents);
      if (b.late && !late.isLate) throw new AppError(409, 'not_late', 'The vehicle is not late');
      await tx.query(
        `UPDATE contracts SET status = 'closed', in_at = now(), km_in = $2, fuel_in = $3, notes_in = $4, in_by = $5,
                late_minutes = $6, late_status = $7, updated_at = now() WHERE id = $1`,
        [id, b.kmIn, b.fuelIn, b.notesIn, auth.user.id, late.lateMinutes, late.isLate ? 'pending' : 'none'],
      );
      await changeVehicleStatus(tx, k.vehicle_id, 'rented', 'inspection_pending', auth.user.id, b.kmIn, b.fuelIn, id, b.cleaned ?? null, b.notesIn);
      await tx.query(`UPDATE reservations SET status = 'completed', updated_at = now() WHERE id = $1`, [k.reservation_id]);
      await tx.query(`INSERT INTO contract_events (contract_id, event, details, actor_user_id) VALUES ($1, 'checked_in', $2, $3)`, [
        id,
        JSON.stringify({ kmIn: b.kmIn, fuelIn: b.fuelIn, kmDriven: b.kmIn - k.km_out, lateMinutes: late.lateMinutes, late: late.isLate }),
        auth.user.id,
      ]);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'contract.checkin',
        targetType: 'contract',
        targetId: id,
        metadata: { kmIn: b.kmIn, lateMinutes: late.lateMinutes, lateDecisionPending: late.isLate && !b.late },
      });
      if (b.late) await applyLateDecision(tx, req, res, await loadContract(tx, auth, id, true), b.late);
      const row = await loadContract(tx, auth, id);
      return { row, balances: await balances(tx, id, Number(row.total_cents)), late };
    });
    res.json({ contract: toDto(out.row), balances: out.balances, late: out.late });
  });

  /** The manager decides (or changes) the late-return charge after the return. */
  r.post('/:id/late-fee', requirePermission(db, 'pricing.change'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const d = parseBody(LateDecision, req);
    const auth = res.locals.auth!;
    const out = await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      if (k.status !== 'closed' || k.late_status === 'none') throw new AppError(409, 'not_late', 'There is no late return to decide');
      if (k.late_status !== 'pending' && !d.reason) throw new AppError(400, 'validation_failed', 'Say why the decision changes', [{ path: 'reason', message: 'Required' }]);
      await applyLateDecision(tx, req, res, k, d);
      const row = await loadContract(tx, auth, id);
      return { row, balances: await balances(tx, id, Number(row.total_cents)) };
    });
    res.json({ contract: toDto(out.row), balances: out.balances });
  });

  r.post('/:id/payments', requirePermission(db, 'contracts.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const p = parseBody(PaymentIn, req);
    const auth = res.locals.auth!;
    const out = await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      const paymentId = await addPayment(tx, auth, k, p);
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: `payment.${p.kind}`,
        targetType: 'contract',
        targetId: id,
        metadata: { paymentId, method: p.method, amountCents: p.amountCents, reason: p.reason },
      });
      return balances(tx, id, Number(k.total_cents));
    });
    res.status(201).json({ balances: out });
  });

  /** A mistake is corrected by a reversal entry; the original stays visible. */
  // RC-03 (#26): give back part of a rental receipt the customer overpaid. One append-only
  // entry, linked to the receipt, bounded by what is overpaid on the contract AND what is
  // still refundable on that receipt. The contract row is locked, so two clicks or two
  // managers cannot both give the same money back.
  r.post('/:id/payments/:paymentId/refund', requirePermission(db, 'payments.refund'), async (req, res) => {
    const { id, paymentId } = parseParams(PayParams, req);
    const body = parseBody(
      z.object({ amountCents: money, method: z.enum(['cash', 'transfer']), reason: z.string().trim().min(3).max(500), reference: optText(80) }).strict(),
      req,
    );
    const auth = res.locals.auth!;
    const out = await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      const orig = (await tx.query('SELECT * FROM payments WHERE id = $1 AND contract_id = $2', [paymentId, id])).rows[0];
      if (!orig) throw notFound('Payment not found');
      if (orig.kind !== 'rental') throw new AppError(409, 'not_a_rental_receipt', 'Money can only be given back from a rental receipt');
      if ((await tx.query('SELECT 1 FROM payments WHERE reverses_id = $1', [paymentId])).rowCount) {
        throw new AppError(409, 'already_reversed', 'This receipt was cancelled');
      }
      const bal = await balances(tx, id, Number(k.total_cents));
      const { rows: [left] } = await tx.query<{ refunded: string }>(
        `SELECT coalesce(sum(r.amount_cents), 0) AS refunded FROM payments r
          WHERE r.refunds_id = $1 AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.reverses_id = r.id)`,
        [paymentId],
      );
      const receiptLeft = Number(orig.amount_cents) - Number(left!.refunded);
      const maxCents = Math.min(bal.overpaidCents, receiptLeft);
      if (maxCents <= 0) throw new AppError(409, 'nothing_to_refund', 'Nothing was overpaid on this contract', { overpaidCents: bal.overpaidCents });
      if (body.amountCents > maxCents) {
        throw new AppError(409, 'refund_exceeded', 'This is more than what can be given back', { maxCents, overpaidCents: bal.overpaidCents, receiptLeftCents: receiptLeft });
      }
      const { rows: [created] } = await tx.query<{ id: string }>(
        `INSERT INTO payments (contract_id, branch_id, kind, method, amount_cents, reference, reason, refunds_id, created_by)
         VALUES ($1, $2, 'rental_refund', $3, $4, $5, $6, $7, $8) RETURNING id`,
        [id, k.branch_id, body.method, body.amountCents, body.reference, body.reason, paymentId, auth.user.id],
      );
      await tx.query(`INSERT INTO contract_events (contract_id, event, details, reason, actor_user_id) VALUES ($1, 'payment', $2, $3, $4)`, [
        id,
        JSON.stringify({ paymentId: created!.id, kind: 'rental_refund', refunds: paymentId, method: body.method, amountCents: body.amountCents }),
        body.reason,
        auth.user.id,
      ]);
      await recordAudit(tx, {
        ...auditContext(req, res), action: 'payment.refund', targetType: 'contract', targetId: id,
        metadata: { paymentId: created!.id, refunds: paymentId, amountCents: body.amountCents, method: body.method, reason: body.reason },
      });
      return balances(tx, id, Number(k.total_cents));
    });
    res.status(201).json({ balances: out });
  });

  r.post('/:id/payments/:paymentId/reverse', requirePermission(db, 'payments.reverse'), async (req, res) => {
    const { id, paymentId } = parseParams(PayParams, req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), req);
    const auth = res.locals.auth!;
    const out = await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      const orig = (await tx.query('SELECT * FROM payments WHERE id = $1 AND contract_id = $2', [paymentId, id])).rows[0];
      if (!orig) throw notFound('Payment not found');
      if (orig.kind === 'reversal') throw new AppError(409, 'cannot_reverse_reversal', 'A correction cannot itself be reversed');
      const already = await tx.query('SELECT 1 FROM payments WHERE reverses_id = $1', [paymentId]);
      if (already.rowCount) throw new AppError(409, 'already_reversed', 'This entry was already corrected');
      if (orig.kind === 'rental') {
        // RC-03: a receipt that money was given back from cannot be cancelled while a refund
        // still stands on it (that would count the refunded part twice). Reverse the refund first.
        const live = await tx.query(
          `SELECT 1 FROM payments r WHERE r.refunds_id = $1 AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.reverses_id = r.id)`,
          [paymentId],
        );
        if (live.rowCount) throw new AppError(409, 'refunded_receipt', 'Money was given back from this receipt: correct the refund first');
      }
      if (orig.kind === 'deposit_in') {
        const bal = await balances(tx, id, Number(k.total_cents));
        if (bal.depositHeldCents < Number(orig.amount_cents)) {
          throw new AppError(409, 'deposit_exceeded', 'Part of this deposit was already returned or kept');
        }
      }
      await tx.query(
        `INSERT INTO payments (contract_id, branch_id, kind, method, amount_cents, reference, reason, reverses_id, created_by)
         VALUES ($1, $2, 'reversal', $3, $4, $5, $6, $7, $8)`,
        [id, orig.branch_id, orig.method, orig.amount_cents, orig.reference, reason, paymentId, auth.user.id],
      );
      await tx.query(`INSERT INTO contract_events (contract_id, event, details, reason, actor_user_id) VALUES ($1, 'payment', $2, $3, $4)`, [
        id,
        JSON.stringify({ reversal: paymentId, kind: orig.kind, amountCents: Number(orig.amount_cents) }),
        reason,
        auth.user.id,
      ]);
      await recordAudit(tx, { ...auditContext(req, res), action: 'payment.reversal', targetType: 'contract', targetId: id, metadata: { paymentId, kind: orig.kind, reason } });
      return balances(tx, id, Number(k.total_cents));
    });
    res.status(201).json({ balances: out });
  });

  r.put('/:id/paper-number', requirePermission(db, 'contracts.manage'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const { paperNumber } = parseBody(z.object({ paperNumber: z.string().trim().min(1).max(30) }).strict(), req);
    const auth = res.locals.auth!;
    try {
      const row = await withTransaction(db, async (tx) => {
        const k = await loadContract(tx, auth, id, true);
        await tx.query('UPDATE contracts SET paper_number = $2, updated_at = now() WHERE id = $1', [id, paperNumber]);
        await tx.query(`INSERT INTO contract_events (contract_id, event, details, actor_user_id) VALUES ($1, 'paper_number', $2, $3)`, [
          id,
          JSON.stringify({ from: k.paper_number, to: paperNumber }),
          auth.user.id,
        ]);
        await recordAudit(tx, { ...auditContext(req, res), action: 'contract.paper_number', targetType: 'contract', targetId: id, metadata: { from: k.paper_number, to: paperNumber } });
        return loadContract(tx, auth, id);
      });
      res.json({ contract: toDto(row) });
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'contracts_paper_number_key') throw new AppError(409, 'paper_number_used', 'This paper contract number is already used');
      throw err;
    }
  });

  r.post('/:id/drivers', requirePermission(db, 'contracts.manage'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const d = parseBody(Driver, req);
    const auth = res.locals.auth!;
    await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      if (k.status !== 'open') throw new AppError(409, 'contract_closed', 'The contract is closed');
      await insertDriver(tx, id, d, auth.user.id);
      await tx.query(`INSERT INTO contract_events (contract_id, event, details, actor_user_id) VALUES ($1, 'driver_added', $2, $3)`, [id, JSON.stringify({ fullName: d.fullName }), auth.user.id]);
      await recordAudit(tx, { ...auditContext(req, res), action: 'contract.driver_add', targetType: 'contract', targetId: id });
    });
    res.status(201).json({ ok: true });
  });

  /** Scan of the signed paper contract — the official document (D-015). Replacing keeps the old file. */
  r.put('/:id/signed-scan', requirePermission(db, 'contracts.manage'), raw, async (req, res) => {
    const { id } = parseParams(Params, req);
    const auth = res.locals.auth!;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const row = await withTransaction(db, async (tx) => {
      const k = await loadContract(tx, auth, id, true);
      const file = await storeUpload(tx, storage, bytes, { declaredType: req.get('content-type'), originalName: req.get('x-file-name'), userId: auth.user.id, allowed: ALLOWED_TYPES });
      await tx.query('UPDATE contracts SET signed_scan_file_id = $2, updated_at = now() WHERE id = $1', [id, file.id]);
      await tx.query(`INSERT INTO contract_events (contract_id, event, details, actor_user_id) VALUES ($1, 'signed_scan', $2, $3)`, [
        id,
        JSON.stringify({ fileId: file.id, previousFileId: k.signed_scan_file_id }),
        auth.user.id,
      ]);
      await recordAudit(tx, { ...auditContext(req, res), action: 'contract.signed_scan', targetType: 'contract', targetId: id, metadata: { fileId: file.id } });
      return loadContract(tx, auth, id);
    });
    res.json({ contract: toDto(row) });
  });

  /** Paper contract OCR never changes the immutable printed snapshot or payment ledger. */
  r.post('/:id/signed-scan/analyze', requirePermission(db, 'contracts.manage'), async (req,res) => {
    const {id} = parseParams(Params,req);
    const auth = res.locals.auth!;
    if (auth.user.role !== 'manager') throw forbidden('Only manager may analyze signed contracts');
    const k = await loadContract(db,auth,id);
    if (!k.signed_scan_file_id) throw notFound('No signed scan attached');
    const {rows} = await db.query<{storage_key:string;size_bytes:number;mime_type:string}>(
      'SELECT storage_key,size_bytes,mime_type FROM stored_files WHERE id=$1',[k.signed_scan_file_id],
    );
    if (!rows[0]) throw notFound('Signed scan file not found');
    const output = await analyzePrivateDocument(storage,rows[0],'contract_signed');
    const candidatePlate = output.fields.plateNumber?.value;
    const candidateNumber = output.fields.contractNumber?.value;
    const plateMatch = candidatePlate && k.snapshot?.vehicle?.plate
      ? plateKey(candidatePlate)===plateKey(k.snapshot.vehicle.plate) : null;
    const paperNumberMatch = candidateNumber && k.paper_number
      ? candidateNumber.trim()===String(k.paper_number).trim() : null;
    await recordAudit(db,{...auditContext(req,res),
      action:'contract.signed_scan_ocr_analyzed',targetType:'contract',targetId:id,
      metadata:{fieldCount:Object.keys(output.fields).length,plateMatch,paperNumberMatch},
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json({suggestions:output.fields,quality:output.quality,warnings:output.warnings,
      enhanced:output.enhanced ?? false,comparisons:{plateMatch,paperNumberMatch},
      requiresHumanReview:true});
  });

  r.get('/:id/signed-scan/review', requirePermission(db, 'contracts.manage'), async (req,res) => {
    const {id}=parseParams(Params,req);
    const auth=res.locals.auth!;
    if (auth.user.role !== 'manager') throw forbidden('Only manager may see signed scan review');
    const k=await loadContract(db,auth,id);
    const {rows}=await db.query(
      `SELECT r.fields,r.status,r.revision,r.reviewed_at FROM contract_signed_scan_reviews r
       WHERE r.contract_id=$1 AND r.file_id=$2`,[id,k.signed_scan_file_id],
    );
    const scan = k.signed_scan_file_id ? await db.query<{mime_type:string}>(
      'SELECT mime_type FROM stored_files WHERE id=$1',[k.signed_scan_file_id],
    ) : null;
    res.setHeader('Cache-Control','private, no-store');
    res.json({review:rows[0] ?? null,mimeType:scan?.rows[0]?.mime_type ?? 'application/pdf'});
  });

  r.put('/:id/signed-scan/review', requirePermission(db, 'contracts.manage'), async (req,res)=>{
    const {id}=parseParams(Params,req);
    const auth=res.locals.auth!;
    if (auth.user.role !== 'manager') throw forbidden('Only manager may approve signed contracts');
    const review=parseBody(DocumentReviewPayload,req);
    const saved=await withTransaction(db,async tx=>{
      const k=await loadContract(tx,auth,id,true);
      const fileId=k.signed_scan_file_id;
      if(!fileId) throw notFound('No signed scan attached');
      const before=await tx.query<{revision:number;status:string;fields:Record<string,string>}>(
        `SELECT revision,status,fields FROM contract_signed_scan_reviews
         WHERE contract_id=$1 AND file_id=$2 FOR UPDATE`,[id,fileId],
      );
      const prior=before.rows[0];
      if((prior?.revision ?? 0)!==review.expectedRevision)
        throw new AppError(409,'stale_document_review','Signed scan review changed; reload');
      const result=await tx.query<{revision:number}>(
        `INSERT INTO contract_signed_scan_reviews
         (contract_id,file_id,fields,status,reviewed_by,reason)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6)
         ON CONFLICT(contract_id,file_id) DO UPDATE SET
           fields=EXCLUDED.fields,status=EXCLUDED.status,reviewed_by=EXCLUDED.reviewed_by,
           reason=EXCLUDED.reason,reviewed_at=now(),
           revision=contract_signed_scan_reviews.revision+1
         RETURNING revision`,
        [id,fileId,JSON.stringify(review.fields),review.status,auth.user.id,review.reason ?? null],
      );
      await recordAudit(tx,{...auditContext(req,res),
        action:'contract.signed_scan_reviewed',targetType:'contract',targetId:id,
        metadata:{fileId,status:review.status,revision:result.rows[0]!.revision,
          previousStatus:prior?.status ?? null,
          modifiedFields:Object.keys(review.fields).filter(key=>review.fields[key]!==prior?.fields[key])},
      });
      return result.rows[0]!;
    });
    res.setHeader('Cache-Control','private, no-store');
    res.json({status:review.status,revision:saved.revision});
  });

  r.post('/:id/photos', requirePermission(db, 'contracts.manage'), raw, async (req, res) => {
    const { id } = parseParams(Params, req);
    const { phase } = parseQuery(z.object({ phase: z.enum(['out', 'in']) }), req);
    const auth = res.locals.auth!;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await withTransaction(db, async (tx) => {
      await loadContract(tx, auth, id, true);
      const file = await storeUpload(tx, storage, bytes, { declaredType: req.get('content-type'), originalName: req.get('x-file-name'), userId: auth.user.id, allowed: ['image/jpeg', 'image/png', 'image/webp'] });
      const ins = await tx.query<{ id: string }>(
        'INSERT INTO contract_photos (contract_id, phase, file_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id',
        [id, phase, file.id, auth.user.id],
      );
      if (ins.rows[0]) await recordAudit(tx, { ...auditContext(req, res), action: 'contract.photo', targetType: 'contract', targetId: id, metadata: { phase, fileId: file.id } });
      return { fileId: file.id, duplicate: !ins.rows[0] };
    });
    res.status(out.duplicate ? 200 : 201).json(out);
  });

  /** Files linked to this contract only: photos, signed scan, company logo printed on it. */
  r.get('/:id/files/:fileId', requirePermission(db, 'contracts.read'), async (req, res) => {
    const { id, fileId } = parseParams(FileParams, req);
    const k = await loadContract(db, res.locals.auth!, id);
    const { rows } = await db.query<{ storage_key: string; mime_type: string; size_bytes: number; original_name: string | null }>(
      `SELECT f.storage_key, f.mime_type, f.size_bytes, f.original_name FROM stored_files f
        WHERE f.id = $1 AND (EXISTS (SELECT 1 FROM contract_photos p WHERE p.file_id = f.id AND p.contract_id = $2)
                          OR f.id = $3 OR f.id = $4)`,
      [fileId, id, k.signed_scan_file_id, k.snapshot?.company?.logoFileId ?? null],
    );
    if (!rows[0]) throw notFound('File not found');
    await sendStoredFile(res, storage, rows[0]);
  });

  return r;
}

/* ---------------- contract templates ---------------- */

const Article = z.object({ title: z.string().trim().max(200), body: z.string().trim().min(1).max(5000) }).strict();
const TemplateBody = z
  .object({
    title: z.string().trim().min(1).max(120),
    handedDocuments: z.array(z.string().trim().min(1).max(80)).max(20),
    responsibilityClause: optText(1000),
    termsTitle: z.string().trim().min(1).max(120),
    terms: z.array(Article).min(1).max(60),
    termsAr: z.array(Article).max(60).nullish(),
    showVehicleDiagram: z.boolean().default(true),
    secondDriverSection: z.boolean().default(true),
    notes: optText(500),
  })
  .strict();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const templateDto = (t: any) =>
  t && {
    id: t.id,
    version: t.version,
    title: t.title,
    handedDocuments: t.handed_documents,
    responsibilityClause: t.responsibility_clause,
    termsTitle: t.terms_title,
    terms: t.terms,
    termsAr: t.terms_ar,
    showVehicleDiagram: t.show_vehicle_diagram,
    secondDriverSection: t.second_driver_section,
    notes: t.notes,
    createdAt: t.created_at,
  };

export function contractTemplatesRouter(db: Db): Router {
  const r = Router();
  r.get('/current', requirePermission(db, 'contracts.read'), async (_req, res) => {
    const { rows } = await db.query('SELECT * FROM contract_templates ORDER BY version DESC LIMIT 1');
    res.json({ template: templateDto(rows[0]) });
  });
  r.get('/', requirePermission(db, 'contracts.templates'), async (_req, res) => {
    const { rows } = await db.query(
      `SELECT t.id, t.version, t.title, t.notes, t.created_at, u.full_name AS by,
              (SELECT count(*)::int FROM contracts k WHERE k.template_id = t.id) AS contracts
         FROM contract_templates t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.version DESC`,
    );
    res.json({ items: rows.map((t) => ({ id: t.id, version: t.version, title: t.title, notes: t.notes, createdAt: t.created_at, by: t.by, contracts: t.contracts })) });
  });
  /** Saving creates a NEW version; contracts already made keep theirs. */
  r.post('/', requirePermission(db, 'contracts.templates'), async (req, res) => {
    const b = parseBody(TemplateBody, req);
    const row = await withTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7007)');
      const next = (await tx.query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM contract_templates')).rows[0]!.v;
      const { rows } = await tx.query(
        `INSERT INTO contract_templates (version, title, handed_documents, responsibility_clause, terms_title, terms, terms_ar,
                                         show_vehicle_diagram, second_driver_section, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [next, b.title, b.handedDocuments, b.responsibilityClause, b.termsTitle, JSON.stringify(b.terms), b.termsAr ? JSON.stringify(b.termsAr) : null,
          b.showVehicleDiagram, b.secondDriverSection, b.notes, res.locals.auth!.user.id],
      );
      await recordAudit(tx, { ...auditContext(req, res), action: 'contract_template.create', targetType: 'contract_template', targetId: rows[0].id, metadata: { version: next, articles: b.terms.length } });
      return rows[0];
    });
    res.status(201).json({ template: templateDto(row) });
  });
  return r;
}
