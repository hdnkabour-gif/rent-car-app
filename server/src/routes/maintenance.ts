import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, notFound } from '../http/errors.js';
import { parseBody, parseParams } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { ResolvedSession } from '../auth/sessions.js';
import { branchFilter } from '../domain/scope.js';
import { loadScoped } from './vehicles.js';
import { insertExpense } from './cash.js';

const TZ = 'Africa/Casablanca';
export const MAINTENANCE_ITEMS = ['oil_change', 'oil_filter', 'air_filter', 'fuel_filter', 'tyres', 'brakes', 'timing_belt', 'battery', 'air_conditioning', 'general_service', 'other'] as const;
/** "Soon" window before an item is due (BR-16: oil change by mileage, other items by km and/or date). */
export const SOON_KM = 1000;
export const SOON_DAYS = 15;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const PlanBody = z
  .object({
    item: z.enum(MAINTENANCE_ITEMS),
    label: optText(80),
    intervalKm: z.number().int().min(100).max(500000).nullish(),
    intervalMonths: z.number().int().min(1).max(120).nullish(),
    lastDoneKm: z.number().int().min(0).max(5_000_000).nullish(),
    lastDoneOn: isoDate.nullish(),
  })
  .strict()
  .refine((b) => b.intervalKm || b.intervalMonths, { message: 'Give an interval in km and/or months', path: ['intervalKm'] })
  .refine((b) => b.item !== 'other' || b.label, { message: 'Name the item', path: ['label'] });

const RecordBody = z
  .object({
    planId: z.uuid().nullish(),
    item: z.enum(MAINTENANCE_ITEMS),
    label: optText(80),
    doneOn: isoDate,
    km: z.number().int().min(0).max(5_000_000),
    garage: optText(120),
    costCents: z.number().int().min(0).max(10_000_000_000).nullish(),
    /** Paid now: also recorded as an expense of the vehicle's branch. */
    paidWith: z.enum(['cash', 'transfer', 'cheque', 'card']).nullish(),
    notes: optText(1000),
  })
  .strict()
  .refine((b) => !b.paidWith || (b.costCents ?? 0) > 0, { message: 'Give the cost', path: ['costCents'] });

/** Plans with their due status, computed from the vehicle's current mileage and today's date. */
const PLAN_SELECT = `
  SELECT p.*, p.last_done_on::text AS last_done_on_s, v.mileage_km, v.plate, v.make, v.model, v.branch_id, v.status AS vehicle_status,
         CASE WHEN p.interval_km IS NOT NULL AND p.last_done_km IS NOT NULL THEN p.last_done_km + p.interval_km END AS next_km,
         CASE WHEN p.interval_months IS NOT NULL AND p.last_done_on IS NOT NULL THEN (p.last_done_on + make_interval(months => p.interval_months))::date::text END AS next_on,
         CASE WHEN p.interval_km IS NOT NULL AND p.last_done_km IS NOT NULL THEN p.last_done_km + p.interval_km - v.mileage_km END AS km_left,
         CASE WHEN p.interval_months IS NOT NULL AND p.last_done_on IS NOT NULL
              THEN ((p.last_done_on + make_interval(months => p.interval_months))::date - (now() AT TIME ZONE '${TZ}')::date) END AS days_left
    FROM maintenance_plans p JOIN vehicles v ON v.id = p.vehicle_id`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const planDto = (p: any) => {
  const kmLeft = p.km_left === null ? null : Number(p.km_left);
  const daysLeft = p.days_left === null ? null : Number(p.days_left);
  const unknown = (p.interval_km && p.last_done_km === null) || (p.interval_months && p.last_done_on === null);
  const status: 'due' | 'soon' | 'ok' | 'unknown' =
    (kmLeft !== null && kmLeft <= 0) || (daysLeft !== null && daysLeft <= 0)
      ? 'due'
      : (kmLeft !== null && kmLeft <= SOON_KM) || (daysLeft !== null && daysLeft <= SOON_DAYS)
        ? 'soon'
        : unknown
          ? 'unknown'
          : 'ok';
  return {
    id: p.id, item: p.item, label: p.label, intervalKm: p.interval_km, intervalMonths: p.interval_months,
    lastDoneKm: p.last_done_km, lastDoneOn: p.last_done_on_s, nextKm: p.next_km === null ? null : Number(p.next_km), nextOn: p.next_on,
    kmLeft, daysLeft, status, vehicle: { id: p.vehicle_id, plate: p.plate, make: p.make, model: p.model, mileageKm: p.mileage_km, status: p.vehicle_status },
  };
};

async function scopedPlans(db: Queryable, auth: ResolvedSession) {
  const params: unknown[] = [];
  const scope = branchFilter(auth, 'v.branch_id', params);
  const { rows } = await db.query(`${PLAN_SELECT} WHERE p.archived_at IS NULL AND v.status <> 'retired' AND ${scope}`, params);
  return rows.map(planDto);
}

export function maintenanceRouter(db: Db): Router {
  const r = Router();

  r.get('/due', requirePermission(db, 'vehicles.read'), async (_req, res) => {
    const plans = (await scopedPlans(db, res.locals.auth!)).filter((p) => p.status === 'due' || p.status === 'soon');
    plans.sort((a, b) => (a.status === b.status ? (a.kmLeft ?? 1e9) - (b.kmLeft ?? 1e9) : a.status === 'due' ? -1 : 1));
    res.json({ items: plans });
  });

  r.get('/summary', requirePermission(db, 'vehicles.read'), async (_req, res) => {
    const plans = await scopedPlans(db, res.locals.auth!);
    res.json({ due: plans.filter((p) => p.status === 'due').length, soon: plans.filter((p) => p.status === 'soon').length });
  });

  r.get('/vehicles/:id', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const { id } = parseParams(z.object({ id: z.uuid() }), req);
    await loadScoped(db, res.locals.auth!, id);
    const plans = (await db.query(`${PLAN_SELECT} WHERE p.vehicle_id = $1 AND p.archived_at IS NULL ORDER BY p.item`, [id])).rows.map(planDto);
    const records = (
      await db.query(
        `SELECT m.*, m.done_on::text AS done_on_s, u.full_name AS by FROM maintenance_records m LEFT JOIN users u ON u.id = m.created_by
          WHERE m.vehicle_id = $1 ORDER BY m.done_on DESC, m.created_at DESC LIMIT 200`,
        [id],
      )
    ).rows.map((m) => ({ id: m.id, item: m.item, label: m.label, doneOn: m.done_on_s, km: m.km, garage: m.garage, costCents: m.cost_cents === null ? null : Number(m.cost_cents), expenseId: m.expense_id, notes: m.notes, by: m.by, createdAt: m.created_at }));
    res.json({ plans, records });
  });

  r.post('/vehicles/:id/plans', requirePermission(db, 'vehicles.maintenance'), async (req, res) => {
    const { id } = parseParams(z.object({ id: z.uuid() }), req);
    const b = parseBody(PlanBody, req);
    const auth = res.locals.auth!;
    try {
      const planId = await withTransaction(db, async (tx) => {
        const v = await loadScoped(tx, auth, id, true);
        if (v.status === 'retired') throw new AppError(409, 'vehicle_retired', 'The vehicle is retired');
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO maintenance_plans (vehicle_id, item, label, interval_km, interval_months, last_done_km, last_done_on, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [id, b.item, b.label, b.intervalKm ?? null, b.intervalMonths ?? null, b.lastDoneKm ?? (b.intervalKm ? v.mileage_km : null), b.lastDoneOn ?? null, auth.user.id],
        );
        await recordAudit(tx, { ...auditContext(req, res), action: 'maintenance.plan_create', targetType: 'vehicle', targetId: id, metadata: { item: b.item, intervalKm: b.intervalKm ?? null, intervalMonths: b.intervalMonths ?? null } });
        return rows[0]!.id;
      });
      res.status(201).json({ id: planId });
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'maintenance_plans_vehicle_item_key') throw new AppError(409, 'plan_exists', 'This item is already planned for the vehicle');
      throw err;
    }
  });

  r.post('/vehicles/:id/plans/:planId/archive', requirePermission(db, 'vehicles.maintenance'), async (req, res) => {
    const { id, planId } = parseParams(z.object({ id: z.uuid(), planId: z.uuid() }), req);
    await withTransaction(db, async (tx) => {
      await loadScoped(tx, res.locals.auth!, id, true);
      const upd = await tx.query('UPDATE maintenance_plans SET archived_at = now(), updated_at = now() WHERE id = $1 AND vehicle_id = $2 AND archived_at IS NULL', [planId, id]);
      if (!upd.rowCount) throw notFound('Plan not found');
      await recordAudit(tx, { ...auditContext(req, res), action: 'maintenance.plan_archive', targetType: 'vehicle', targetId: id, metadata: { planId } });
    });
    res.status(204).end();
  });

  /** Work done by the garage: recorded once, never edited; the plan's next date/km follow from it. */
  r.post('/vehicles/:id/records', requirePermission(db, 'vehicles.maintenance'), async (req, res) => {
    const { id } = parseParams(z.object({ id: z.uuid() }), req);
    const b = parseBody(RecordBody, req);
    const auth = res.locals.auth!;
    const recordId = await withTransaction(db, async (tx) => {
      const v = await loadScoped(tx, auth, id, true);
      const future = await tx.query<{ f: boolean }>(`SELECT $1::date > (now() AT TIME ZONE '${TZ}')::date AS f`, [b.doneOn]);
      if (future.rows[0]!.f) throw new AppError(400, 'validation_failed', 'The work date cannot be in the future', [{ path: 'doneOn', message: 'Future' }]);
      if (b.planId) {
        const p = await tx.query('SELECT 1 FROM maintenance_plans WHERE id = $1 AND vehicle_id = $2 AND archived_at IS NULL FOR UPDATE', [b.planId, id]);
        if (!p.rowCount) throw new AppError(400, 'validation_failed', 'Unknown plan', [{ path: 'planId', message: 'Unknown plan' }]);
      }
      let expenseId: string | null = null;
      if (b.paidWith && b.costCents) {
        expenseId = await insertExpense(tx, auth, {
          branchId: v.branch_id, vehicleId: id, category: b.item === 'tyres' ? 'tyres' : 'maintenance', amountCents: b.costCents,
          method: b.paidWith, spentOn: b.doneOn, supplier: b.garage, reference: null, notes: `${b.item}${b.label ? ` — ${b.label}` : ''}`, receiptFileId: null,
        });
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO maintenance_records (vehicle_id, plan_id, item, label, done_on, km, garage, cost_cents, expense_id, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [id, b.planId ?? null, b.item, b.label, b.doneOn, b.km, b.garage, b.costCents ?? null, expenseId, b.notes, auth.user.id],
      );
      if (b.planId) {
        await tx.query('UPDATE maintenance_plans SET last_done_km = $2, last_done_on = $3, updated_at = now() WHERE id = $1', [b.planId, b.km, b.doneOn]);
      }
      await recordAudit(tx, { ...auditContext(req, res), action: 'maintenance.record', targetType: 'vehicle', targetId: id, metadata: { item: b.item, km: b.km, costCents: b.costCents ?? null, expenseId } });
      return rows[0]!.id;
    });
    res.status(201).json({ id: recordId });
  });

  return r;
}
