import express, { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { ResolvedSession } from '../auth/sessions.js';
import type { AppConfig } from '../config.js';
import { assertBranchInScope, branchFilter } from '../domain/scope.js';
import { ALLOWED_TYPES, type FileStorage } from '../storage/storage.js';
import { sendStoredFile, storeUpload } from '../storage/files.js';

const TZ = 'Africa/Casablanca';
export const EXPENSE_CATEGORIES = ['fuel', 'washing', 'maintenance', 'repair', 'tyres', 'insurance', 'tax', 'parking', 'rent', 'salary', 'office', 'other'] as const;
const METHODS = ['cash', 'transfer', 'cheque', 'card'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const ExpenseBody = z
  .object({
    branchId: z.uuid(),
    vehicleId: z.uuid().nullish(),
    category: z.enum(EXPENSE_CATEGORIES),
    amountCents: z.number().int().min(1).max(10_000_000_000),
    method: z.enum(METHODS),
    spentOn: isoDate.optional(),
    supplier: optText(120),
    reference: optText(80),
    notes: optText(1000),
    receiptFileId: z.uuid().nullish(),
  })
  .strict();

/** Inserts an expense (used by the expenses API and by maintenance records paid on the spot). */
export async function insertExpense(tx: Queryable, auth: ResolvedSession, b: z.infer<typeof ExpenseBody>): Promise<string> {
  assertBranchInScope(auth, b.branchId);
  if (b.vehicleId) {
    const v = await tx.query<{ branch_id: string }>('SELECT branch_id FROM vehicles WHERE id = $1', [b.vehicleId]);
    if (!v.rows[0]) throw new AppError(400, 'validation_failed', 'Unknown vehicle', [{ path: 'vehicleId', message: 'Unknown vehicle' }]);
    assertBranchInScope(auth, v.rows[0].branch_id);
  }
  // A receipt must be a file this same person uploaded: an expense can never be used to reach
  // another document (e.g. a customer's ID scan) by its id.
  if (b.receiptFileId) {
    const own = await tx.query('SELECT 1 FROM stored_files WHERE id = $1 AND uploaded_by = $2', [b.receiptFileId, auth.user.id]);
    if (!own.rowCount) throw new AppError(400, 'validation_failed', 'Unknown receipt', [{ path: 'receiptFileId', message: 'Unknown receipt' }]);
  }
  const future = await tx.query<{ f: boolean }>(`SELECT coalesce($1::date, (now() AT TIME ZONE '${TZ}')::date) > (now() AT TIME ZONE '${TZ}')::date AS f`, [b.spentOn ?? null]);
  if (future.rows[0]!.f) throw new AppError(400, 'validation_failed', 'An expense cannot be in the future', [{ path: 'spentOn', message: 'Future date' }]);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO expenses (branch_id, vehicle_id, category, amount_cents, method, spent_on, supplier, reference, notes, receipt_file_id, created_by)
     VALUES ($1, $2, $3, $4, $5, coalesce($6::date, (now() AT TIME ZONE '${TZ}')::date), $7, $8, $9, $10, $11) RETURNING id`,
    [b.branchId, b.vehicleId ?? null, b.category, b.amountCents, b.method, b.spentOn ?? null, b.supplier, b.reference, b.notes, b.receiptFileId ?? null, auth.user.id],
  );
  return rows[0]!.id;
}

/** Everything that moved money in one branch on one (Casablanca) day, from the two ledgers. */
export async function dayTotals(db: Queryable, branchId: string, date: string) {
  const pays = await db.query<{ id: string; kind: string; method: string; amount_cents: string; created_at: Date; orig_kind: string | null; reference: string | null; contract_number: string; by: string | null }>(
    `SELECT p.id, p.kind, p.method, p.amount_cents, p.created_at, o.kind AS orig_kind, p.reference, k.number AS contract_number, u.full_name AS by
       FROM payments p LEFT JOIN payments o ON o.id = p.reverses_id JOIN contracts k ON k.id = p.contract_id LEFT JOIN users u ON u.id = p.created_by
      WHERE p.branch_id = $1 AND (p.created_at AT TIME ZONE '${TZ}')::date = $2::date ORDER BY p.created_at`,
    [branchId, date],
  );
  const exps = await db.query<{ id: string; kind: string; method: string; amount_cents: string; created_at: Date; category: string; orig_category: string | null; supplier: string | null; by: string | null }>(
    `SELECT e.id, e.kind, e.method, e.amount_cents, e.created_at, e.category, o.category AS orig_category, e.supplier, u.full_name AS by
       FROM expenses e LEFT JOIN expenses o ON o.id = e.reverses_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.branch_id = $1 AND e.spent_on = $2::date ORDER BY e.created_at`,
    [branchId, date],
  );
  const zero = () => Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<(typeof METHODS)[number], number>;
  const t = { rental: zero(), depositIn: zero(), depositOut: zero(), depositKept: zero(), expenses: zero() };
  // Effect of each movement on the till (cash only). A kept deposit stays in the till: no cash moves.
  const cashEffect: Record<string, number> = { rental: 1, deposit_in: 1, deposit_out: -1, deposit_kept: 0 };
  let expectedCash = 0;
  const movements: Array<{ at: Date; source: 'payment' | 'expense'; kind: string; method: string; amountCents: number; signedCashCents: number; label: string | null; by: string | null }> = [];
  for (const p of pays.rows) {
    const amount = Number(p.amount_cents);
    const base = p.kind === 'reversal' ? p.orig_kind! : p.kind;
    const sign = p.kind === 'reversal' ? -1 : 1;
    const bucket = base === 'rental' ? t.rental : base === 'deposit_in' ? t.depositIn : base === 'deposit_out' ? t.depositOut : t.depositKept;
    bucket[p.method as keyof typeof bucket] += sign * amount;
    const cash = p.method === 'cash' ? sign * (cashEffect[base] ?? 0) * amount : 0;
    expectedCash += cash;
    movements.push({ at: p.created_at, source: 'payment', kind: p.kind === 'reversal' ? `reversal:${base}` : base, method: p.method, amountCents: amount, signedCashCents: cash, label: `C-${String(p.contract_number).padStart(5, '0')}`, by: p.by });
  }
  for (const e of exps.rows) {
    const amount = Number(e.amount_cents);
    const sign = e.kind === 'reversal' ? -1 : 1;
    t.expenses[e.method as keyof typeof t.expenses] += sign * amount;
    const cash = e.method === 'cash' ? -sign * amount : 0;
    expectedCash += cash;
    movements.push({ at: e.created_at, source: 'expense', kind: e.kind === 'reversal' ? 'reversal:expense' : `expense:${e.category}`, method: e.method, amountCents: amount, signedCashCents: cash, label: e.supplier, by: e.by });
  }
  movements.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { totals: t, expectedCashCents: expectedCash, movements };
}

export function cashRouter(db: Db, config: AppConfig, storage: FileStorage): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: config.maxUploadBytes });

  /* ---------- expenses ---------- */
  r.get('/expenses', requirePermission(db, 'cash.read'), async (req, res) => {
    const q = parseQuery(z.object({ from: isoDate.optional(), to: isoDate.optional(), branchId: z.uuid().optional(), vehicleId: z.uuid().optional() }), req);
    const params: unknown[] = [];
    const where = [branchFilter(res.locals.auth!, 'e.branch_id', params)];
    if (q.from) {
      params.push(q.from);
      where.push(`e.spent_on >= $${params.length}`);
    }
    if (q.to) {
      params.push(q.to);
      where.push(`e.spent_on <= $${params.length}`);
    }
    if (q.branchId) {
      params.push(q.branchId);
      where.push(`e.branch_id = $${params.length}`);
    }
    if (q.vehicleId) {
      params.push(q.vehicleId);
      where.push(`e.vehicle_id = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT e.*, e.spent_on::text AS spent_on_s, b.name AS branch_name, v.plate, u.full_name AS by,
              (SELECT x.id FROM expenses x WHERE x.reverses_id = e.id) AS reversed_by
         FROM expenses e JOIN branches b ON b.id = e.branch_id LEFT JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN users u ON u.id = e.created_by
        WHERE ${where.join(' AND ')} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 300`,
      params,
    );
    res.json({
      items: rows.map((e) => ({
        id: e.id, kind: e.kind, category: e.category, amountCents: Number(e.amount_cents), method: e.method, spentOn: e.spent_on_s,
        supplier: e.supplier, reference: e.reference, notes: e.notes, reason: e.reason, reversesId: e.reverses_id, reversedBy: e.reversed_by,
        branch: { id: e.branch_id, name: e.branch_name }, vehicle: e.vehicle_id ? { id: e.vehicle_id, plate: e.plate } : null,
        receiptFileId: e.receipt_file_id, createdAt: e.created_at, by: e.by,
      })),
    });
  });

  /** Receipt photo/PDF uploaded first; its id is then given with the expense. */
  r.post('/expenses/receipt', requirePermission(db, 'expenses.record'), raw, async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const file = await withTransaction(db, (tx) =>
      storeUpload(tx, storage, bytes, { declaredType: req.get('content-type'), originalName: req.get('x-file-name'), userId: res.locals.auth!.user.id, allowed: ALLOWED_TYPES }),
    );
    res.status(201).json({ fileId: file.id });
  });

  r.post('/expenses', requirePermission(db, 'expenses.record'), async (req, res) => {
    const b = parseBody(ExpenseBody, req);
    const auth = res.locals.auth!;
    const id = await withTransaction(db, async (tx) => {
      const id = await insertExpense(tx, auth, b);
      await recordAudit(tx, { ...auditContext(req, res), action: 'expense.create', targetType: 'branch', targetId: b.branchId, metadata: { expenseId: id, category: b.category, amountCents: b.amountCents, method: b.method } });
      return id;
    });
    res.status(201).json({ id });
  });

  r.post('/expenses/:id/reverse', requirePermission(db, 'payments.reverse'), async (req, res) => {
    const { id } = parseParams(z.object({ id: z.uuid() }), req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), req);
    const auth = res.locals.auth!;
    await withTransaction(db, async (tx) => {
      const o = (await tx.query('SELECT * FROM expenses WHERE id = $1', [id])).rows[0];
      if (!o) throw notFound('Expense not found');
      assertBranchInScope(auth, o.branch_id);
      if (o.kind === 'reversal') throw new AppError(409, 'cannot_reverse_reversal', 'A correction cannot itself be reversed');
      if ((await tx.query('SELECT 1 FROM expenses WHERE reverses_id = $1', [id])).rowCount) throw new AppError(409, 'already_reversed', 'Already corrected');
      await tx.query(
        `INSERT INTO expenses (branch_id, vehicle_id, kind, category, amount_cents, method, spent_on, supplier, reference, reverses_id, reason, created_by)
         VALUES ($1, $2, 'reversal', $3, $4, $5, (now() AT TIME ZONE '${TZ}')::date, $6, $7, $8, $9, $10)`,
        [o.branch_id, o.vehicle_id, o.category, o.amount_cents, o.method, o.supplier, o.reference, id, reason, auth.user.id],
      );
      await recordAudit(tx, { ...auditContext(req, res), action: 'expense.reversal', targetType: 'branch', targetId: o.branch_id, metadata: { expenseId: id, reason } });
    });
    res.status(201).json({ ok: true });
  });

  r.get('/expenses/:id/receipt', requirePermission(db, 'cash.read'), async (req, res) => {
    const { id } = parseParams(z.object({ id: z.uuid() }), req);
    const e = (await db.query('SELECT branch_id, receipt_file_id FROM expenses WHERE id = $1', [id])).rows[0];
    if (!e || !e.receipt_file_id) throw notFound('No receipt');
    assertBranchInScope(res.locals.auth!, e.branch_id);
    const f = (await db.query('SELECT storage_key, mime_type, size_bytes, original_name FROM stored_files WHERE id = $1', [e.receipt_file_id])).rows[0];
    await sendStoredFile(res, storage, f);
  });

  /* ---------- cash of the day and closing ---------- */
  const DayQuery = z.object({ branchId: z.uuid(), date: isoDate.optional() });
  const today = async () => (await db.query<{ d: string }>(`SELECT (now() AT TIME ZONE '${TZ}')::date::text AS d`)).rows[0]!.d;

  r.get('/day', requirePermission(db, 'cash.read'), async (req, res) => {
    const q = parseQuery(DayQuery, req);
    assertBranchInScope(res.locals.auth!, q.branchId);
    const date = q.date ?? (await today());
    const day = await dayTotals(db, q.branchId, date);
    const closing = (await db.query(`SELECT c.*, u.full_name AS by FROM cash_closings c LEFT JOIN users u ON u.id = c.closed_by WHERE c.branch_id = $1 AND c.business_date = $2`, [q.branchId, date])).rows[0];
    res.json({
      date,
      ...day,
      closing: closing
        ? { expectedCashCents: Number(closing.expected_cash_cents), countedCashCents: Number(closing.counted_cash_cents), differenceCents: Number(closing.difference_cents), notes: closing.notes, at: closing.closed_at, by: closing.by,
            changedSince: Number(closing.expected_cash_cents) !== day.expectedCashCents }
        : null,
    });
  });

  r.post('/close', requirePermission(db, 'cash.close'), async (req, res) => {
    const b = parseBody(z.object({ branchId: z.uuid(), date: isoDate, countedCashCents: z.number().int().min(0).max(10_000_000_000), notes: optText(1000) }).strict(), req);
    const auth = res.locals.auth!;
    assertBranchInScope(auth, b.branchId);
    if (b.date > (await today())) throw new AppError(400, 'validation_failed', 'A future day cannot be closed', [{ path: 'date', message: 'Future' }]);
    const out = await withTransaction(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cash:${b.branchId}:${b.date}`]);
      if ((await tx.query('SELECT 1 FROM cash_closings WHERE branch_id = $1 AND business_date = $2', [b.branchId, b.date])).rowCount) {
        throw new AppError(409, 'already_closed', 'This day is already closed');
      }
      const day = await dayTotals(tx, b.branchId, b.date);
      const diff = b.countedCashCents - day.expectedCashCents;
      if (diff !== 0 && !b.notes) throw new AppError(400, 'validation_failed', 'Explain the difference', [{ path: 'notes', message: 'Required' }]);
      await tx.query(
        `INSERT INTO cash_closings (branch_id, business_date, expected_cash_cents, counted_cash_cents, difference_cents, totals, notes, closed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [b.branchId, b.date, day.expectedCashCents, b.countedCashCents, diff, JSON.stringify(day.totals), b.notes, auth.user.id],
      );
      await recordAudit(tx, { ...auditContext(req, res), action: 'cash.close', targetType: 'branch', targetId: b.branchId, metadata: { date: b.date, expectedCashCents: day.expectedCashCents, countedCashCents: b.countedCashCents, differenceCents: diff } });
      return { expectedCashCents: day.expectedCashCents, differenceCents: diff };
    });
    res.status(201).json(out);
  });

  r.get('/closings', requirePermission(db, 'cash.read'), async (req, res) => {
    const q = parseQuery(z.object({ branchId: z.uuid().optional() }), req);
    const params: unknown[] = [];
    const where = [branchFilter(res.locals.auth!, 'c.branch_id', params)];
    if (q.branchId) {
      params.push(q.branchId);
      where.push(`c.branch_id = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT c.*, c.business_date::text AS d, b.name AS branch_name, u.full_name AS by FROM cash_closings c JOIN branches b ON b.id = c.branch_id
        LEFT JOIN users u ON u.id = c.closed_by WHERE ${where.join(' AND ')} ORDER BY c.business_date DESC LIMIT 120`,
      params,
    );
    res.json({ items: rows.map((c) => ({ id: c.id, date: c.d, branch: { id: c.branch_id, name: c.branch_name }, expectedCashCents: Number(c.expected_cash_cents), countedCashCents: Number(c.counted_cash_cents), differenceCents: Number(c.difference_cents), notes: c.notes, at: c.closed_at, by: c.by })) });
  });

  return r;
}
