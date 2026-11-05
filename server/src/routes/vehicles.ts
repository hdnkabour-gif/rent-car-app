import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, diffFields, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { ResolvedSession } from '../auth/sessions.js';
import { assertBranchInScope, branchFilter } from '../domain/scope.js';
import { plateKey } from '../domain/plates.js';
import { uuidParam } from './schemas.js';

export const VEHICLE_STATUSES = ['available', 'rented', 'inspection_pending', 'maintenance', 'out_of_service', 'retired'] as const;
type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const VehicleBody = z
  .object({
    branchId: z.uuid(),
    plate: z.string().trim().min(2).max(30),
    internalCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,20}$/, 'Letters, digits and dashes only')
      .nullish()
      .or(z.literal('').transform(() => null)),
    make: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(60),
    catalogModelId: z.uuid().nullish(),
    catalogGenerationId: z.string().trim().max(80).nullish(),
    catalogEngineId: z.string().trim().max(80).nullish(),
    version: optText(60),
    modelYear: z.number().int().min(1980).max(2100).nullish(),
    color: optText(40),
    fuelType: z.enum(['diesel', 'petrol', 'hybrid', 'electric', 'lpg']),
    transmission: z.enum(['manual', 'automatic']),
    seats: z.number().int().min(1).max(60).nullish(),
    category: optText(40),
    vin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-HJ-NPR-Z0-9]{11,17}$/, 'Invalid VIN')
      .nullish()
      .or(z.literal('').transform(() => null)),
    firstRegistrationDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
      .nullish()
      .or(z.literal('').transform(() => null)),
    notes: optText(2000),
    /** Price per 24-hour day and usual deposit, in centimes of MAD. */
    dailyRateCents: z.number().int().min(0).max(100_000_000).nullish(),
    depositCents: z.number().int().min(0).max(100_000_000).nullish(),
  })
  .strict();

const CreateBody = VehicleBody.extend({
  // Mileage at registration in the system; afterwards it changes only through inspections.
  mileageKm: z.number().int().min(0).max(5_000_000).default(0),
});

const TransitionBody = z
  .object({
    to: z.enum(VEHICLE_STATUSES),
    // The status the user saw. If someone else changed the vehicle meanwhile, the request is refused.
    expectedStatus: z.enum(VEHICLE_STATUSES),
    reason: optText(1000),
    mileageKm: z.number().int().min(0).max(5_000_000).optional(),
    fuelEighths: z.number().int().min(0).max(8).optional(),
    cleaned: z.boolean().optional(),
    notes: optText(2000),
  })
  .strict();

const ListQuery = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(VEHICLE_STATUSES).optional(),
  branchId: z.uuid().optional(),
  /** 'alert': only vehicles with a document expired or expiring within 30 days. */
  docs: z.enum(['alert']).optional(),
  includeRetired: z.enum(['true', 'false']).optional(),
});

interface VehicleRow {
  id: string;
  branch_id: string;
  branch_name: string;
  branch_code: string;
  internal_code: string | null;
  plate: string;
  make: string;
  model: string;
  version: string | null;
  model_year: number | null;
  color: string | null;
  fuel_type: string;
  transmission: string;
  seats: number | null;
  category: string | null;
  vin: string | null;
  status: VehicleStatus;
  status_changed_at: Date;
  mileage_km: number;
  fuel_eighths: number | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  first_registration_date: string | null;
  daily_rate_cents: number | null;
  deposit_cents: number | null;
  document_alert: 'expired' | 'expiring' | null;
  catalog_model_id: string | null;
  catalog_generation_id: string | null;
  catalog_engine_id: string | null;
  catalog_generation_label: string | null;
  catalog_engine_version: string | null;
}

const SELECT = `
  SELECT v.id, v.branch_id, b.name AS branch_name, b.code AS branch_code, v.internal_code, v.plate, v.make, v.model,
         v.version, v.model_year, v.color, v.fuel_type, v.transmission, v.seats, v.category, v.vin, v.status,
         v.status_changed_at, v.mileage_km, v.fuel_eighths, v.notes, v.created_at, v.updated_at,
         v.first_registration_date::text AS first_registration_date, v.daily_rate_cents, v.deposit_cents,
         v.catalog_model_id, v.catalog_generation_id, v.catalog_engine_id,
         cg.label AS catalog_generation_label, ce.commercial_version AS catalog_engine_version,
         (SELECT CASE WHEN bool_or(d.expiry_date < (now() AT TIME ZONE 'Africa/Casablanca')::date) THEN 'expired'
                      WHEN bool_or(d.expiry_date <= (now() AT TIME ZONE 'Africa/Casablanca')::date + 30) THEN 'expiring' END
            FROM vehicle_documents d WHERE d.vehicle_id = v.id AND d.archived_at IS NULL) AS document_alert
    FROM vehicles v JOIN branches b ON b.id = v.branch_id
    LEFT JOIN vehicle_catalog_generations cg ON cg.id = v.catalog_generation_id
    LEFT JOIN vehicle_catalog_engines ce ON ce.id = v.catalog_engine_id`;

const toDto = (v: VehicleRow) => ({
  id: v.id,
  branch: { id: v.branch_id, name: v.branch_name, code: v.branch_code },
  internalCode: v.internal_code,
  plate: v.plate,
  make: v.make,
  model: v.model,
  catalogModelId: v.catalog_model_id,
  catalogGenerationId: v.catalog_generation_id,
  catalogEngineId: v.catalog_engine_id,
  catalogGenerationLabel: v.catalog_generation_label,
  catalogEngineVersion: v.catalog_engine_version,
  version: v.version,
  modelYear: v.model_year,
  color: v.color,
  fuelType: v.fuel_type,
  transmission: v.transmission,
  seats: v.seats,
  category: v.category,
  vin: v.vin,
  firstRegistrationDate: v.first_registration_date,
  dailyRateCents: v.daily_rate_cents,
  depositCents: v.deposit_cents,
  documentAlert: v.document_alert,
  status: v.status,
  statusChangedAt: v.status_changed_at,
  mileageKm: v.mileage_km,
  fuelEighths: v.fuel_eighths,
  notes: v.notes,
  createdAt: v.created_at,
  updatedAt: v.updated_at,
});

/** Editable descriptive fields (not status, mileage or fuel: those change only through inspections). */
const descriptive = (v: VehicleRow) => ({
  branchId: v.branch_id,
  plate: v.plate,
  internalCode: v.internal_code,
  make: v.make,
  model: v.model,
  catalogModelId: v.catalog_model_id,
  catalogGenerationId: v.catalog_generation_id,
  catalogEngineId: v.catalog_engine_id,
  version: v.version,
  modelYear: v.model_year,
  color: v.color,
  fuelType: v.fuel_type,
  transmission: v.transmission,
  seats: v.seats,
  category: v.category,
  vin: v.vin,
  firstRegistrationDate: v.first_registration_date,
  dailyRateCents: v.daily_rate_cents,
  depositCents: v.deposit_cents,
  notes: v.notes,
});

interface TransitionRule {
  to_status: VehicleStatus;
  permission_code: string | null;
  reason_required: boolean;
}

async function rulesFrom(db: Queryable, from: VehicleStatus): Promise<TransitionRule[]> {
  const { rows } = await db.query<TransitionRule>(
    'SELECT to_status, permission_code, reason_required FROM vehicle_status_transitions WHERE from_status = $1 ORDER BY to_status',
    [from],
  );
  return rows;
}

/** Manual transitions this user may perform from the given status (what the UI offers as buttons). */
function allowedFor(auth: ResolvedSession, rules: TransitionRule[]) {
  return rules
    .filter((r) => r.permission_code !== null && auth.permissions.includes(r.permission_code))
    .map((r) => ({
      to: r.to_status,
      reasonRequired: r.reason_required,
      inspection: r.to_status === 'available', // passing an inspection records mileage, fuel, cleaning
    }));
}

export async function loadScoped(db: Queryable, auth: ResolvedSession, id: string, lock = false): Promise<VehicleRow> {
  const params: unknown[] = [id];
  const scope = branchFilter(auth, 'v.branch_id', params);
  const { rows } = await db.query<VehicleRow>(`${SELECT} WHERE v.id = $1 AND ${scope}${lock ? ' FOR UPDATE OF v' : ''}`, params);
  // Out-of-scope vehicles are reported as not found, so their existence is not disclosed.
  if (!rows[0]) throw notFound('Vehicle not found');
  return rows[0];
}

async function assertCatalogSelection(
  db: Queryable,
  body: { make: string; model: string; catalogModelId?: string | null; catalogGenerationId?: string | null; catalogEngineId?: string | null },
): Promise<void> {
  if (!body.catalogModelId) {
    if (body.catalogGenerationId || body.catalogEngineId) {
      throw new AppError(400, 'validation_failed', 'A catalog model is required before selecting its generation or engine', [
        { path: 'catalogModelId', message: 'Required' },
      ]);
    }
    return; // Custom / "Autre" vehicle names remain supported.
  }

  const selected = await db.query<{ model_name: string; brand_name: string }>(
    `SELECT m.name AS model_name, b.name AS brand_name
       FROM vehicle_catalog_models m JOIN vehicle_catalog_brands b ON b.id = m.brand_id
      WHERE m.id = $1`,
    [body.catalogModelId],
  );
  const model = selected.rows[0];
  if (!model || model.brand_name !== body.make || model.model_name !== body.model) {
    throw new AppError(400, 'validation_failed', 'The selected catalog model does not match the make and model names', [
      { path: 'catalogModelId', message: 'Mismatched catalog selection' },
    ]);
  }

  if (body.catalogGenerationId) {
    const generation = await db.query(
      'SELECT 1 FROM vehicle_catalog_generations WHERE id = $1 AND model_id = $2',
      [body.catalogGenerationId, body.catalogModelId],
    );
    if (!generation.rowCount) {
      throw new AppError(400, 'validation_failed', 'The selected generation does not belong to this model', [
        { path: 'catalogGenerationId', message: 'Mismatched generation' },
      ]);
    }
  }
  if (body.catalogEngineId) {
    if (!body.catalogGenerationId) {
      throw new AppError(400, 'validation_failed', 'Select a generation before selecting an engine', [
        { path: 'catalogGenerationId', message: 'Required' },
      ]);
    }
    const engine = await db.query(
      'SELECT 1 FROM vehicle_catalog_engines WHERE id = $1 AND generation_id = $2',
      [body.catalogEngineId, body.catalogGenerationId],
    );
    if (!engine.rowCount) {
      throw new AppError(400, 'validation_failed', 'The selected engine does not belong to this generation', [
        { path: 'catalogEngineId', message: 'Mismatched engine' },
      ]);
    }
  }
}

function uniqueViolation(err: unknown, index: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === index;
}

export function vehiclesRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const q = parseQuery(ListQuery, req);
    const auth = res.locals.auth!;
    const params: unknown[] = [];
    const where = [branchFilter(auth, 'v.branch_id', params)];
    if (q.status) {
      params.push(q.status);
      where.push(`v.status = $${params.length}`);
    } else if (q.includeRetired !== 'true') {
      where.push(`v.status <> 'retired'`);
    }
    if (q.branchId) {
      params.push(q.branchId);
      where.push(`v.branch_id = $${params.length}`);
    }
    if (q.docs === 'alert') {
      where.push(`EXISTS (SELECT 1 FROM vehicle_documents d WHERE d.vehicle_id = v.id AND d.archived_at IS NULL
                     AND d.expiry_date <= (now() AT TIME ZONE 'Africa/Casablanca')::date + 30)`);
    }
    if (q.q) {
      const key = plateKey(q.q);
      const text = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(text);
      const t = params.length;
      const clauses = [`v.make ILIKE $${t}`, `v.model ILIKE $${t}`, `(v.make || ' ' || v.model) ILIKE $${t}`, `v.internal_code ILIKE $${t}`];
      if (key) {
        params.push(`%${key}%`);
        clauses.push(`v.plate_key LIKE $${params.length}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    const { rows } = await db.query<VehicleRow>(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY b.name, v.status, v.make, v.model, v.plate LIMIT 500`,
      params,
    );
    res.json({ items: rows.map(toDto) });
  });

  /** Counts per status in the user's scope (home screen). */
  r.get('/summary', requirePermission(db, 'vehicles.read'), async (_req, res) => {
    const params: unknown[] = [];
    const scope = branchFilter(res.locals.auth!, 'branch_id', params);
    const { rows } = await db.query<{ status: VehicleStatus; n: number }>(
      `SELECT status, count(*)::int AS n FROM vehicles WHERE ${scope} AND status <> 'retired' GROUP BY status`,
      params,
    );
    const counts = Object.fromEntries(VEHICLE_STATUSES.filter((s) => s !== 'retired').map((s) => [s, 0]));
    for (const row of rows) counts[row.status] = row.n;
    const docParams: unknown[] = [];
    const docScope = branchFilter(res.locals.auth!, 'v.branch_id', docParams);
    const docs = await db.query<{ expired: number; expiring: number }>(
      `SELECT count(*) FILTER (WHERE d.expiry_date < (now() AT TIME ZONE 'Africa/Casablanca')::date)::int AS expired,
              count(*) FILTER (WHERE d.expiry_date >= (now() AT TIME ZONE 'Africa/Casablanca')::date
                                 AND d.expiry_date <= (now() AT TIME ZONE 'Africa/Casablanca')::date + 30)::int AS expiring
         FROM vehicle_documents d JOIN vehicles v ON v.id = d.vehicle_id
        WHERE d.archived_at IS NULL AND v.status <> 'retired' AND ${docScope}`,
      docParams,
    );
    res.json({ counts, total: rows.reduce((a, b) => a + b.n, 0), documents: docs.rows[0] });
  });

  r.get('/:id', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const { id } = parseParams(uuidParam, req);
    const auth = res.locals.auth!;
    const v = await loadScoped(db, auth, id);
    const { rows: history } = await db.query<{
      id: string;
      from_status: string | null;
      to_status: string;
      changed_at: Date;
      changed_by_name: string | null;
      reason: string | null;
      mileage_km: number | null;
      fuel_eighths: number | null;
      cleaned: boolean | null;
      notes: string | null;
    }>(
      `SELECT h.id, h.from_status, h.to_status, h.changed_at, u.full_name AS changed_by_name, h.reason,
              h.mileage_km, h.fuel_eighths, h.cleaned, h.notes
         FROM vehicle_status_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.vehicle_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [id],
    );
    res.json({
      vehicle: toDto(v),
      allowedTransitions: allowedFor(auth, await rulesFrom(db, v.status)),
      history: history.map((h) => ({
        id: Number(h.id),
        from: h.from_status,
        to: h.to_status,
        at: h.changed_at,
        by: h.changed_by_name,
        reason: h.reason,
        mileageKm: h.mileage_km,
        fuelEighths: h.fuel_eighths,
        cleaned: h.cleaned,
        notes: h.notes,
      })),
    });
  });

  r.post('/', requirePermission(db, 'vehicles.manage'), async (req, res) => {
    const body = parseBody(CreateBody, req);
    const auth = res.locals.auth!;
    assertBranchInScope(auth, body.branchId);
    const key = plateKey(body.plate);
    if (key.length < 2) throw new AppError(400, 'validation_failed', 'Plate is not readable', [{ path: 'plate', message: 'Invalid plate' }]);
    try {
      const created = await withTransaction(db, async (tx) => {
        const branch = await tx.query('SELECT 1 FROM branches WHERE id = $1 AND is_active', [body.branchId]);
        if (!branch.rowCount) throw new AppError(400, 'validation_failed', 'Unknown or inactive branch', [{ path: 'branchId', message: 'Unknown branch' }]);
        await assertCatalogSelection(tx, body);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO vehicles (branch_id, internal_code, plate, plate_key, make, model, version, model_year, color, fuel_type,
                                 transmission, seats, category, vin, mileage_km, notes, created_by, first_registration_date,
                                 daily_rate_cents, deposit_cents, catalog_model_id, catalog_generation_id, catalog_engine_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING id`,
          [
            body.branchId, body.internalCode ?? null, body.plate, key, body.make, body.model, body.version, body.modelYear ?? null,
            body.color, body.fuelType, body.transmission, body.seats ?? null, body.category, body.vin ?? null, body.mileageKm,
            body.notes, auth.user.id, body.firstRegistrationDate ?? null, body.dailyRateCents ?? null, body.depositCents ?? null,
            body.catalogModelId ?? null, body.catalogGenerationId ?? null, body.catalogEngineId ?? null,
          ],
        );
        const id = rows[0]!.id;
        await tx.query(
          `INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, changed_by, reason, mileage_km)
           VALUES ($1, NULL, 'inspection_pending', $2, NULL, $3)`, // reason NULL: the UI labels creation in the user's language
          [id, auth.user.id, body.mileageKm],
        );
        await recordAudit(tx, {
          ...auditContext(req, res),
          action: 'vehicle.create',
          targetType: 'vehicle',
          targetId: id,
          metadata: { plate: body.plate, branchId: body.branchId },
        });
        return (await tx.query<VehicleRow>(`${SELECT} WHERE v.id = $1`, [id])).rows[0]!;
      });
      res.status(201).json(toDto(created));
    } catch (err) {
      if (uniqueViolation(err, 'vehicles_plate_key_active')) throw conflict('A vehicle with this plate already exists');
      if (uniqueViolation(err, 'vehicles_internal_code_key')) throw conflict('A vehicle with this internal code already exists');
      throw err;
    }
  });

  r.put('/:id', requirePermission(db, 'vehicles.manage'), async (req, res) => {
    const { id } = parseParams(uuidParam, req);
    const body = parseBody(VehicleBody, req);
    const auth = res.locals.auth!;
    assertBranchInScope(auth, body.branchId);
    const key = plateKey(body.plate);
    try {
      const updated = await withTransaction(db, async (tx) => {
        const before = await loadScoped(tx, auth, id, true);
        if (before.status === 'retired') throw conflict('A retired vehicle cannot be edited');
        await assertCatalogSelection(tx, body);
        if (before.branch_id !== body.branchId && before.status === 'rented') {
          throw conflict('A rented vehicle cannot change branch until it is returned');
        }
        await tx.query(
          `UPDATE vehicles SET branch_id = $2, internal_code = $3, plate = $4, plate_key = $5, make = $6, model = $7,
                  version = $8, model_year = $9, color = $10, fuel_type = $11, transmission = $12, seats = $13,
                  category = $14, vin = $15, notes = $16, first_registration_date = $17, daily_rate_cents = $18,
                  deposit_cents = $19, catalog_model_id = $20, catalog_generation_id = $21, catalog_engine_id = $22,
                  updated_at = now()
            WHERE id = $1`,
          [
            id, body.branchId, body.internalCode ?? null, body.plate, key, body.make, body.model, body.version,
            body.modelYear ?? null, body.color, body.fuelType, body.transmission, body.seats ?? null, body.category,
            body.vin ?? null, body.notes, body.firstRegistrationDate ?? null, body.dailyRateCents ?? null, body.depositCents ?? null,
            body.catalogModelId ?? null, body.catalogGenerationId ?? null, body.catalogEngineId ?? null,
          ],
        );
        const after = (await tx.query<VehicleRow>(`${SELECT} WHERE v.id = $1`, [id])).rows[0]!;
        await recordAudit(tx, {
          ...auditContext(req, res),
          action: 'vehicle.update',
          targetType: 'vehicle',
          targetId: id,
          metadata: { changes: diffFields(descriptive(before), descriptive(after)) },
        });
        return after;
      });
      res.json(toDto(updated));
    } catch (err) {
      if (uniqueViolation(err, 'vehicles_plate_key_active')) throw conflict('A vehicle with this plate already exists');
      if (uniqueViolation(err, 'vehicles_internal_code_key')) throw conflict('A vehicle with this internal code already exists');
      throw err;
    }
  });

  r.post('/:id/transitions', requirePermission(db, 'vehicles.read'), async (req, res) => {
    const { id } = parseParams(uuidParam, req);
    const body = parseBody(TransitionBody, req);
    const auth = res.locals.auth!;

    const result = await withTransaction(db, async (tx) => {
      // Row lock: two people acting on the same vehicle are serialised; the second sees the new status.
      const v = await loadScoped(tx, auth, id, true);
      if (v.status !== body.expectedStatus) {
        throw new AppError(409, 'stale_status', 'The vehicle changed meanwhile. Reload and try again.', { current: v.status });
      }
      const rule = (await rulesFrom(tx, v.status)).find((x) => x.to_status === body.to);
      if (!rule) throw new AppError(409, 'invalid_transition', `A vehicle cannot go from ${v.status} to ${body.to}`);
      if (rule.permission_code === null) {
        throw new AppError(409, 'workflow_only', 'This change is made by the check-out or check-in workflow, not manually');
      }
      if (!auth.permissions.includes(rule.permission_code)) {
        // Written on its own connection: this transaction is rolled back by the refusal below.
        await recordAudit(db, {
          ...auditContext(req, res),
          action: 'authz.denied',
          outcome: 'denied',
          targetType: 'vehicle',
          targetId: id,
          metadata: { permission: rule.permission_code, transition: `${v.status}->${body.to}` },
        });
        throw new AppError(403, 'forbidden', 'You do not have permission to perform this action');
      }
      if (rule.reason_required && !body.reason) {
        throw new AppError(400, 'validation_failed', 'A reason is required', [{ path: 'reason', message: 'Required' }]);
      }
      if (body.to === 'retired') {
        // D-028: a vehicle with future bookings cannot be retired; cancel or move them first.
        const future = await tx.query(
          `SELECT 1 FROM reservations WHERE vehicle_id = $1 AND status IN ('confirmed', 'in_progress') AND end_at > now() LIMIT 1`,
          [id],
        );
        if (future.rowCount) throw new AppError(409, 'has_reservations', 'The vehicle has upcoming reservations');
      }
      const isInspection = body.to === 'available';
      if (isInspection && (body.mileageKm === undefined || body.fuelEighths === undefined)) {
        throw new AppError(400, 'validation_failed', 'Inspection needs mileage and fuel level', [
          ...(body.mileageKm === undefined ? [{ path: 'mileageKm', message: 'Required' }] : []),
          ...(body.fuelEighths === undefined ? [{ path: 'fuelEighths', message: 'Required' }] : []),
        ]);
      }
      if (body.mileageKm !== undefined && body.mileageKm < v.mileage_km) {
        if (!auth.permissions.includes('vehicles.admin') || !body.reason) {
          throw new AppError(422, 'mileage_decrease', 'Mileage cannot be lower than the last reading', { lastMileageKm: v.mileage_km });
        }
      }

      // Compare-and-set on the status: a concurrent change makes this update touch 0 rows.
      const upd = await tx.query(
        `UPDATE vehicles SET status = $3, status_changed_at = now(),
                mileage_km = COALESCE($4, mileage_km), fuel_eighths = COALESCE($5, fuel_eighths), updated_at = now()
          WHERE id = $1 AND status = $2`,
        [id, v.status, body.to, body.mileageKm ?? null, body.fuelEighths ?? null],
      );
      if (upd.rowCount !== 1) throw new AppError(409, 'stale_status', 'The vehicle changed meanwhile. Reload and try again.');
      await tx.query(
        `INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, changed_by, reason, mileage_km, fuel_eighths, cleaned, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, v.status, body.to, auth.user.id, body.reason, body.mileageKm ?? null, body.fuelEighths ?? null, body.cleaned ?? null, body.notes],
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'vehicle.status_change',
        targetType: 'vehicle',
        targetId: id,
        metadata: {
          from: v.status,
          to: body.to,
          reason: body.reason,
          mileageKm: body.mileageKm ?? null,
          mileageCorrected: body.mileageKm !== undefined && body.mileageKm < v.mileage_km,
        },
      });
      return (await tx.query<VehicleRow>(`${SELECT} WHERE v.id = $1`, [id])).rows[0]!;
    });

    res.json({ vehicle: toDto(result), allowedTransitions: allowedFor(auth, await rulesFrom(db, result.status)) });
  });

  return r;
}

