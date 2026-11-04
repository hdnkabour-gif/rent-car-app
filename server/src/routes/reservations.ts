import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { ResolvedSession } from '../auth/sessions.js';
import { assertBranchInScope, branchFilter } from '../domain/scope.js';
import { loadScoped } from './vehicles.js';

const TZ = 'Africa/Casablanca';
/** Local Casablanca date-time as typed in the form, e.g. "2026-11-20T10:00". */
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm');
const PLACES = ['agency', 'airport', 'hotel', 'other'] as const;
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const ReservationBody = z
  .object({
    customerId: z.uuid(),
    vehicleId: z.uuid(),
    start: localDateTime,
    end: localDateTime,
    returnBranchId: z.uuid().nullish(),
    pickupPlace: z.enum(PLACES).default('agency'),
    pickupDetails: optText(200),
    returnPlace: z.enum(PLACES).default('agency'),
    returnDetails: optText(200),
    /** Agreed price per day in centimes; omitted = the vehicle price. */
    dailyCents: z.number().int().min(0).max(100_000_000).nullish(),
    priceReason: optText(500),
    depositCents: z.number().int().min(0).max(100_000_000).nullish(),
    notes: optText(2000),
  })
  .strict()
  .refine((b) => b.end > b.start, { message: 'The return is before the pickup', path: ['end'] });
type ReservationInput = z.infer<typeof ReservationBody>;

const Params = z.object({ id: z.uuid() });
const Reason = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const reservationRef = (n: number | string) => `R-${String(n).padStart(5, '0')}`;

const SELECT = `
  SELECT r.*, to_char(r.start_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI') AS start_local,
         to_char(r.end_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI') AS end_local,
         c.full_name AS customer_name, c.phone AS customer_phone, c.blocked_at AS customer_blocked_at,
         v.plate, v.make, v.model, v.status AS vehicle_status,
         b.name AS branch_name, rb.name AS return_branch_name, u.full_name AS created_by_name
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN branches b ON b.id = r.branch_id
    JOIN branches rb ON rb.id = r.return_branch_id
    LEFT JOIN users u ON u.id = r.created_by`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toDto = (r: any) => ({
  id: r.id,
  number: Number(r.number),
  reference: reservationRef(r.number),
  status: r.status as 'confirmed' | 'cancelled' | 'no_show' | 'in_progress' | 'completed',
  startAt: r.start_at,
  endAt: r.end_at,
  startLocal: r.start_local,
  endLocal: r.end_local,
  days: r.days,
  customer: { id: r.customer_id, fullName: r.customer_name, phone: r.customer_phone, blocked: Boolean(r.customer_blocked_at) },
  vehicle: { id: r.vehicle_id, plate: r.plate, make: r.make, model: r.model, status: r.vehicle_status },
  branch: { id: r.branch_id, name: r.branch_name },
  returnBranch: { id: r.return_branch_id, name: r.return_branch_name },
  pickupPlace: r.pickup_place,
  pickupDetails: r.pickup_details,
  returnPlace: r.return_place,
  returnDetails: r.return_details,
  listDailyCents: r.list_daily_cents,
  dailyCents: r.daily_cents,
  priceReason: r.price_reason,
  totalCents: Number(r.total_cents),
  depositCents: r.deposit_cents,
  notes: r.notes,
  cancelReason: r.cancel_reason,
  createdBy: r.created_by_name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function loadReservation(db: Queryable, auth: ResolvedSession, id: string, lock = false) {
  const params: unknown[] = [id];
  const scope = branchFilter(auth, 'r.branch_id', params);
  const { rows } = await db.query(`${SELECT} WHERE r.id = $1 AND ${scope}${lock ? ' FOR UPDATE OF r' : ''}`, params);
  if (!rows[0]) throw notFound('Reservation not found');
  return rows[0];
}

type Warning =
  | 'customer_licence_expires'
  | 'customer_id_expires'
  | 'customer_licence_missing'
  | 'vehicle_not_ready'
  | 'vehicle_no_price'
  | 'start_in_past';

interface Quote {
  startAt: Date;
  endAt: Date;
  days: number;
  listDailyCents: number;
  dailyCents: number;
  totalCents: number;
  depositCents: number;
  priceChanged: boolean;
  warnings: Warning[];
  conflicts: Array<{ id: string; reference: string; startAt: Date; endAt: Date; customerName: string }>;
  vehicle: Awaited<ReturnType<typeof loadScoped>>;
}

/**
 * Everything checked before a reservation is saved, also used for the live preview in the form.
 * Blocking problems throw; the rest come back as warnings for staff to read.
 */
async function quote(db: Queryable, auth: ResolvedSession, b: ReservationInput, excludeId: string | null, lock: boolean): Promise<Quote> {
  const vehicle = await loadScoped(db, auth, b.vehicleId, lock);
  if (vehicle.status === 'retired') throw new AppError(409, 'vehicle_retired', 'The vehicle is retired');
  const c = await db.query<{ blocked_at: Date | null; licence_expiry: Date | null; id_doc_expiry: Date | null; licence_number: string | null }>(
    'SELECT blocked_at, licence_expiry, id_doc_expiry, licence_number FROM customers WHERE id = $1',
    [b.customerId],
  );
  const customer = c.rows[0];
  if (!customer) throw new AppError(400, 'validation_failed', 'Unknown customer', [{ path: 'customerId', message: 'Unknown customer' }]);
  if (customer.blocked_at) throw new AppError(409, 'customer_blocked', 'This customer is marked "do not rent"');
  if (b.returnBranchId) {
    const rb = await db.query('SELECT 1 FROM branches WHERE id = $1 AND is_active', [b.returnBranchId]);
    if (!rb.rowCount) throw new AppError(400, 'validation_failed', 'Unknown branch', [{ path: 'returnBranchId', message: 'Unknown branch' }]);
  }

  const t = await db.query<{ start_at: Date; end_at: Date; days: number; in_past: boolean; ended: boolean; lic: boolean; idd: boolean }>(
    `SELECT s AS start_at, e AS end_at,
            GREATEST(1, ceil(extract(epoch FROM (e - s)) / 86400))::int AS days,
            s < now() - interval '1 hour' AS in_past,
            e <= now() AS ended,
            ($3::date IS NOT NULL AND $3::date < (e AT TIME ZONE '${TZ}')::date) AS lic,
            ($4::date IS NOT NULL AND $4::date < (e AT TIME ZONE '${TZ}')::date) AS idd
       FROM (SELECT ($1::timestamp AT TIME ZONE '${TZ}') AS s, ($2::timestamp AT TIME ZONE '${TZ}') AS e) x`,
    [b.start, b.end, customer.licence_expiry, customer.id_doc_expiry],
  );
  const time = t.rows[0]!;
  if (time.ended) throw new AppError(400, 'validation_failed', 'The return date is already past', [{ path: 'end', message: 'In the past' }]);
  if (time.days > 366) throw new AppError(400, 'validation_failed', 'A reservation is limited to 366 days', [{ path: 'end', message: 'Too long' }]);

  const listDailyCents = vehicle.daily_rate_cents ?? b.dailyCents ?? 0;
  const dailyCents = b.dailyCents ?? listDailyCents;
  const priceChanged = vehicle.daily_rate_cents !== null && dailyCents !== vehicle.daily_rate_cents;

  const warnings: Warning[] = [];
  if (time.lic) warnings.push('customer_licence_expires');
  if (time.idd) warnings.push('customer_id_expires');
  if (!customer.licence_number) warnings.push('customer_licence_missing');
  if (vehicle.status === 'maintenance' || vehicle.status === 'out_of_service') warnings.push('vehicle_not_ready');
  if (vehicle.daily_rate_cents === null) warnings.push('vehicle_no_price');
  if (time.in_past) warnings.push('start_in_past');

  const conflicts = await db.query<{ id: string; number: string; start_at: Date; end_at: Date; full_name: string }>(
    `SELECT r.id, r.number, r.start_at, r.end_at, c.full_name FROM reservations r JOIN customers c ON c.id = r.customer_id
      WHERE r.vehicle_id = $1 AND r.status IN ('confirmed', 'in_progress') AND ($4::uuid IS NULL OR r.id <> $4)
        AND r.period && tstzrange($2, $3, '[)') ORDER BY r.start_at`,
    [b.vehicleId, time.start_at, time.end_at, excludeId],
  );

  return {
    startAt: time.start_at,
    endAt: time.end_at,
    days: time.days,
    listDailyCents,
    dailyCents,
    totalCents: time.days * dailyCents,
    depositCents: b.depositCents ?? vehicle.deposit_cents ?? 0,
    priceChanged,
    warnings,
    conflicts: conflicts.rows.map((r) => ({ id: r.id, reference: reservationRef(r.number), startAt: r.start_at, endAt: r.end_at, customerName: r.full_name })),
    vehicle,
  };
}

function assertPriceAllowed(auth: ResolvedSession, q: Quote, b: ReservationInput) {
  if (!q.priceChanged) return;
  if (!auth.permissions.includes('pricing.change')) throw forbidden('Only an authorized person can agree a different price');
  if (!b.priceReason) {
    throw new AppError(400, 'validation_failed', 'Give the reason for the price change', [{ path: 'priceReason', message: 'Required' }]);
  }
}

const quoteDto = (q: Quote) => ({
  startAt: q.startAt,
  endAt: q.endAt,
  days: q.days,
  listDailyCents: q.listDailyCents,
  dailyCents: q.dailyCents,
  totalCents: q.totalCents,
  depositCents: q.depositCents,
  priceChanged: q.priceChanged,
  warnings: q.warnings,
  conflicts: q.conflicts,
  available: q.conflicts.length === 0,
});

function overlapError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23P01' && e.constraint === 'reservations_no_overlap';
}
const unavailable = () => new AppError(409, 'vehicle_unavailable', 'The vehicle is already reserved for part of these dates');

/** Reservation fields shown in the change history (no personal data beyond what is on the booking). */
const tracked = (r: Record<string, unknown>) => ({
  start: r.start_local,
  end: r.end_local,
  vehicle: r.plate,
  dailyCents: r.daily_cents,
  totalCents: Number(r.total_cents),
  depositCents: r.deposit_cents,
  pickupPlace: r.pickup_place,
  returnPlace: r.return_place,
  returnBranch: r.return_branch_name,
});

export function reservationsRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'reservations.read'), async (req, res) => {
    const q = parseQuery(
      z.object({
        view: z.enum(['upcoming', 'departures_today', 'returns_today', 'past', 'all']).default('upcoming'),
        status: z.enum(['confirmed', 'cancelled', 'no_show', 'in_progress', 'completed']).optional(),
        customerId: z.uuid().optional(),
        vehicleId: z.uuid().optional(),
        q: z.string().trim().max(60).optional(),
      }),
      req,
    );
    const auth = res.locals.auth!;
    const params: unknown[] = [];
    const where = [branchFilter(auth, 'r.branch_id', params)];
    const today = `(now() AT TIME ZONE '${TZ}')::date`;
    if (q.view === 'upcoming') where.push(`r.end_at >= now() AND r.status IN ('confirmed', 'in_progress')`);
    if (q.view === 'departures_today') where.push(`(r.start_at AT TIME ZONE '${TZ}')::date = ${today} AND r.status = 'confirmed'`);
    if (q.view === 'returns_today') where.push(`(r.end_at AT TIME ZONE '${TZ}')::date = ${today} AND r.status IN ('confirmed', 'in_progress')`);
    if (q.view === 'past') where.push(`(r.end_at < now() OR r.status IN ('cancelled', 'no_show', 'completed'))`);
    if (q.status) {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    if (q.customerId) {
      params.push(q.customerId);
      where.push(`r.customer_id = $${params.length}`);
    }
    if (q.vehicleId) {
      params.push(q.vehicleId);
      where.push(`r.vehicle_id = $${params.length}`);
    }
    if (q.q) {
      const num = q.q.replace(/^R-?/i, '');
      const clauses: string[] = [];
      params.push(`%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      clauses.push(`lower(c.full_name) LIKE $${params.length}`, `lower(v.plate) LIKE $${params.length}`);
      if (/^\d{1,12}$/.test(num)) {
        params.push(Number(num));
        clauses.push(`r.number = $${params.length}`);
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    const order = q.view === 'past' ? 'r.start_at DESC' : 'r.start_at ASC';
    const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
    res.json({ items: rows.map(toDto) });
  });

  r.get('/summary', requirePermission(db, 'reservations.read'), async (_req, res) => {
    const params: unknown[] = [];
    const scope = branchFilter(res.locals.auth!, 'branch_id', params);
    const today = `(now() AT TIME ZONE '${TZ}')::date`;
    const { rows } = await db.query<{ departures: number; returns: number; upcoming: number }>(
      `SELECT count(*) FILTER (WHERE (start_at AT TIME ZONE '${TZ}')::date = ${today} AND status = 'confirmed')::int AS departures,
              count(*) FILTER (WHERE (end_at AT TIME ZONE '${TZ}')::date = ${today} AND status IN ('confirmed', 'in_progress'))::int AS returns,
              count(*) FILTER (WHERE end_at >= now() AND status IN ('confirmed', 'in_progress'))::int AS upcoming
         FROM reservations WHERE ${scope}`,
      params,
    );
    res.json(rows[0]);
  });

  /** Which vehicles are free for these dates (in the user's branches). */
  r.get('/availability', requirePermission(db, 'reservations.read'), async (req, res) => {
    const q = parseQuery(
      z.object({ start: localDateTime, end: localDateTime, branchId: z.uuid().optional(), excludeReservationId: z.uuid().optional() }),
      req,
    );
    if (q.end <= q.start) throw new AppError(400, 'validation_failed', 'The return is before the pickup', [{ path: 'end', message: 'Before pickup' }]);
    const params: unknown[] = [q.start, q.end, q.excludeReservationId ?? null];
    const where = [branchFilter(res.locals.auth!, 'v.branch_id', params), `v.status <> 'retired'`];
    if (q.branchId) {
      params.push(q.branchId);
      where.push(`v.branch_id = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT v.id, v.plate, v.make, v.model, v.category, v.transmission, v.fuel_type, v.seats, v.status, v.daily_rate_cents,
              v.deposit_cents, b.id AS branch_id, b.name AS branch_name,
              (SELECT min(r.number) FROM reservations r
                WHERE r.vehicle_id = v.id AND r.status IN ('confirmed', 'in_progress') AND ($3::uuid IS NULL OR r.id <> $3)
                  AND r.period && tstzrange($1::timestamp AT TIME ZONE '${TZ}', $2::timestamp AT TIME ZONE '${TZ}', '[)')) AS conflict
         FROM vehicles v JOIN branches b ON b.id = v.branch_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.name, v.make, v.model, v.plate`,
      params,
    );
    res.json({
      items: rows.map((v) => ({
        id: v.id,
        plate: v.plate,
        make: v.make,
        model: v.model,
        category: v.category,
        transmission: v.transmission,
        fuelType: v.fuel_type,
        seats: v.seats,
        status: v.status,
        dailyRateCents: v.daily_rate_cents,
        depositCents: v.deposit_cents,
        branch: { id: v.branch_id, name: v.branch_name },
        available: v.conflict === null,
        conflictReference: v.conflict === null ? null : reservationRef(v.conflict),
      })),
    });
  });

  /** Preview: days, price, warnings and conflicts, without saving anything. */
  r.post('/quote', requirePermission(db, 'reservations.manage'), async (req, res) => {
    const b = parseBody(ReservationBody, req);
    const { excludeReservationId } = parseQuery(z.object({ excludeReservationId: z.uuid().optional() }), req);
    res.json(quoteDto(await quote(db, res.locals.auth!, b, excludeReservationId ?? null, false)));
  });

  r.get('/:id', requirePermission(db, 'reservations.read'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const row = await loadReservation(db, res.locals.auth!, id);
    const ev = await db.query(
      `SELECT e.id, e.event, e.changes, e.reason, e.occurred_at, u.full_name AS actor
         FROM reservation_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.reservation_id = $1 ORDER BY e.id`,
      [id],
    );
    res.json({
      reservation: toDto(row),
      events: ev.rows.map((e) => ({ id: Number(e.id), event: e.event, changes: e.changes, reason: e.reason, at: e.occurred_at, by: e.actor })),
    });
  });

  r.post('/', requirePermission(db, 'reservations.manage'), async (req, res) => {
    const b = parseBody(ReservationBody, req);
    const auth = res.locals.auth!;
    try {
      const out = await withTransaction(db, async (tx) => {
        const q = await quote(tx, auth, b, null, true);
        assertBranchInScope(auth, q.vehicle.branch_id);
        assertPriceAllowed(auth, q, b);
        if (q.conflicts.length) throw unavailable();
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO reservations (branch_id, return_branch_id, customer_id, vehicle_id, start_at, end_at, days, pickup_place,
                                     pickup_details, return_place, return_details, list_daily_cents, daily_cents, price_reason,
                                     total_cents, deposit_cents, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
          [
            q.vehicle.branch_id, b.returnBranchId ?? q.vehicle.branch_id, b.customerId, b.vehicleId, q.startAt, q.endAt, q.days,
            b.pickupPlace, b.pickupDetails, b.returnPlace, b.returnDetails, q.listDailyCents, q.dailyCents,
            q.priceChanged ? b.priceReason : null, q.totalCents, q.depositCents, b.notes, auth.user.id,
          ],
        );
        const id = rows[0]!.id;
        const row = await loadReservation(tx, auth, id);
        await tx.query(`INSERT INTO reservation_events (reservation_id, event, changes, actor_user_id) VALUES ($1, 'created', $2, $3)`, [
          id,
          JSON.stringify(tracked(row)),
          auth.user.id,
        ]);
        await recordAudit(tx, {
          ...auditContext(req, res),
          action: 'reservation.create',
          targetType: 'reservation',
          targetId: id,
          metadata: { reference: reservationRef(row.number), days: q.days, totalCents: q.totalCents, priceChanged: q.priceChanged, priceReason: q.priceChanged ? b.priceReason : null },
        });
        return { row, warnings: q.warnings };
      });
      res.status(201).json({ reservation: toDto(out.row), warnings: out.warnings });
    } catch (err) {
      if (overlapError(err)) throw unavailable();
      throw err;
    }
  });

  r.put('/:id', requirePermission(db, 'reservations.manage'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const b = parseBody(ReservationBody, req);
    const auth = res.locals.auth!;
    try {
      const out = await withTransaction(db, async (tx) => {
        const before = await loadReservation(tx, auth, id, true);
        if (before.status !== 'confirmed') throw new AppError(409, 'reservation_closed', 'Only a confirmed reservation can be changed');
        if (b.customerId !== before.customer_id) throw new AppError(409, 'customer_change', 'The customer of a reservation cannot be changed; cancel and book again');
        const q = await quote(tx, auth, b, id, true);
        assertBranchInScope(auth, q.vehicle.branch_id);
        // Same vehicle: the price agreed at booking stays the reference, unless the vehicle changes.
        if (b.vehicleId === before.vehicle_id && b.dailyCents === undefined) {
          q.dailyCents = before.daily_cents;
          q.listDailyCents = before.list_daily_cents;
          q.priceChanged = before.daily_cents !== before.list_daily_cents;
          q.totalCents = q.days * q.dailyCents;
        } else if (b.vehicleId === before.vehicle_id) {
          q.listDailyCents = before.list_daily_cents;
          q.priceChanged = q.dailyCents !== before.list_daily_cents;
        }
        // A (new) agreed price different from the list price needs the right and a reason.
        const priceTouched = q.dailyCents !== before.daily_cents || q.listDailyCents !== before.list_daily_cents;
        if (priceTouched) assertPriceAllowed(auth, q, b);
        if (q.conflicts.length) throw unavailable();
        await tx.query(
          `UPDATE reservations SET branch_id = $2, return_branch_id = $3, vehicle_id = $4, start_at = $5, end_at = $6, days = $7,
                  pickup_place = $8, pickup_details = $9, return_place = $10, return_details = $11, list_daily_cents = $12,
                  daily_cents = $13, price_reason = $14, total_cents = $15, deposit_cents = $16, notes = $17, updated_at = now()
            WHERE id = $1`,
          [
            id, q.vehicle.branch_id, b.returnBranchId ?? q.vehicle.branch_id, b.vehicleId, q.startAt, q.endAt, q.days, b.pickupPlace,
            b.pickupDetails, b.returnPlace, b.returnDetails, q.listDailyCents, q.dailyCents,
            q.priceChanged ? (priceTouched ? b.priceReason : before.price_reason) : null,
            q.totalCents, q.depositCents, b.notes,
          ],
        );
        const after = await loadReservation(tx, auth, id);
        const from = tracked(before);
        const to = tracked(after);
        const changes = Object.fromEntries(
          Object.keys(to)
            .filter((k) => JSON.stringify(from[k as keyof typeof from]) !== JSON.stringify(to[k as keyof typeof to]))
            .map((k) => [k, { from: from[k as keyof typeof from], to: to[k as keyof typeof to] }]),
        );
        if (Object.keys(changes).length || before.notes !== after.notes) {
          await tx.query(`INSERT INTO reservation_events (reservation_id, event, changes, reason, actor_user_id) VALUES ($1, 'changed', $2, $3, $4)`, [
            id,
            JSON.stringify(changes),
            priceTouched ? b.priceReason : null,
            auth.user.id,
          ]);
          await recordAudit(tx, {
            ...auditContext(req, res),
            action: 'reservation.update',
            targetType: 'reservation',
            targetId: id,
            metadata: { reference: reservationRef(after.number), changes },
          });
        }
        return { row: after, warnings: q.warnings };
      });
      res.json({ reservation: toDto(out.row), warnings: out.warnings });
    } catch (err) {
      if (overlapError(err)) throw unavailable();
      throw err;
    }
  });

  const close = (event: 'cancelled' | 'no_show') =>
    async (req: Request, res: Response) => {
      const { id } = parseParams(Params, req);
      const { reason } = parseBody(Reason, req);
      const auth = res.locals.auth!;
      const row = await withTransaction(db, async (tx) => {
        const before = await loadReservation(tx, auth, id, true);
        if (before.status !== 'confirmed') throw new AppError(409, 'reservation_closed', 'Only a confirmed reservation can be closed');
        if (event === 'no_show') {
          const started = await tx.query<{ ok: boolean }>('SELECT $1::timestamptz <= now() AS ok', [before.start_at]);
          if (!started.rows[0]!.ok) throw new AppError(409, 'not_started', 'A no-show can be recorded only after the pickup time');
        }
        await tx.query('UPDATE reservations SET status = $2, cancel_reason = $3, updated_at = now() WHERE id = $1', [id, event, reason]);
        await tx.query('INSERT INTO reservation_events (reservation_id, event, reason, actor_user_id) VALUES ($1, $2, $3, $4)', [
          id,
          event,
          reason,
          auth.user.id,
        ]);
        await recordAudit(tx, {
          ...auditContext(req, res),
          action: event === 'cancelled' ? 'reservation.cancel' : 'reservation.no_show',
          targetType: 'reservation',
          targetId: id,
          metadata: { reference: reservationRef(before.number), reason },
        });
        return loadReservation(tx, auth, id);
      });
      res.json({ reservation: toDto(row) });
    };
  r.post('/:id/cancel', requirePermission(db, 'reservations.manage'), close('cancelled'));
  r.post('/:id/no-show', requirePermission(db, 'reservations.manage'), close('no_show'));

  /** Undo a cancellation or no-show by mistake: allowed only if the vehicle is still free. */
  r.post('/:id/reopen', requirePermission(db, 'reservations.manage'), async (req, res) => {
    const { id } = parseParams(Params, req);
    const { reason } = parseBody(Reason, req);
    const auth = res.locals.auth!;
    try {
      const row = await withTransaction(db, async (tx) => {
        const before = await loadReservation(tx, auth, id, true);
        if (before.status !== 'cancelled' && before.status !== 'no_show') throw new AppError(409, 'reservation_open', 'The reservation is not cancelled');
        const ended = await tx.query<{ ended: boolean }>('SELECT $1::timestamptz <= now() AS ended', [before.end_at]);
        if (ended.rows[0]!.ended) throw new AppError(409, 'reservation_past', 'The reservation dates are past');
        await tx.query(`UPDATE reservations SET status = 'confirmed', cancel_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
        await tx.query(`INSERT INTO reservation_events (reservation_id, event, reason, actor_user_id) VALUES ($1, 'reopened', $2, $3)`, [
          id,
          reason,
          auth.user.id,
        ]);
        await recordAudit(tx, {
          ...auditContext(req, res),
          action: 'reservation.reopen',
          targetType: 'reservation',
          targetId: id,
          metadata: { reference: reservationRef(before.number), reason },
        });
        return loadReservation(tx, auth, id);
      });
      res.json({ reservation: toDto(row) });
    } catch (err) {
      if (overlapError(err)) throw unavailable();
      throw err;
    }
  });

  return r;
}
