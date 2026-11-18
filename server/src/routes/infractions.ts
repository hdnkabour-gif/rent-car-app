import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import type { ResolvedSession } from '../auth/sessions.js';
import { branchFilter } from '../domain/scope.js';
import { loadScoped } from './vehicles.js';

const Id = z.object({ id: z.uuid() });
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use Casablanca YYYY-MM-DDTHH:mm');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const statuses = ['new', 'under_review', 'contested', 'paid', 'closed'] as const;
const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const Create = z.object({
  vehicleId: z.uuid(),
  issuer: z.string().trim().min(2).max(100).transform((v) => v.toUpperCase()),
  noticeNumber: z.string().trim().min(2).max(100).transform((v) => v.toUpperCase()),
  occurredLocal: localDateTime,
  notifiedOn: isoDate.nullish(),
  location: optionalText(250),
  kind: optionalText(120),
  amountCents: z.number().int().min(0).max(100_000_000),
  notes: optionalText(500),
}).strict();
const Filter = z.object({
  vehicleId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  status: z.enum(statuses).optional(),
}).strict();
const Match = z.object({
  // Explicit manager decision. A null contract means investigated and no matching rental.
  contractId: z.uuid().nullable(),
  reason: z.string().trim().min(10).max(500),
}).strict();
const StatusChange = z.object({
  status: z.enum(statuses),
  reason: z.string().trim().min(10).max(500),
  paymentReference: optionalText(120),
}).strict();

const SELECT = `
 SELECT i.*, to_char(i.occurred_at AT TIME ZONE 'Africa/Casablanca', 'YYYY-MM-DD"T"HH24:MI') AS occurred_local,
        i.notified_on::text AS notified_local, v.plate, v.make, v.model,
        b.name AS branch_name, c.number AS contract_number
   FROM road_infractions i
   JOIN vehicles v ON v.id = i.vehicle_id
   JOIN branches b ON b.id = i.branch_id
   LEFT JOIN contracts c ON c.id = i.contract_id`;

type InfractionRow = Record<string, any>; // pg row, mapped explicitly to the public API shape
function dto(i: InfractionRow) {
  return {
    id: i.id,
    vehicle: { id: i.vehicle_id, plate: i.plate, make: i.make, model: i.model },
    branch: { id: i.branch_id, name: i.branch_name },
    issuer: i.issuer, noticeNumber: i.notice_number, source: i.source,
    occurredAt: i.occurred_at, occurredLocal: i.occurred_local,
    notifiedOn: i.notified_local, location: i.location, kind: i.kind,
    amountCents: Number(i.amount_cents), status: i.status, paymentReference: i.payment_reference,
    matchStatus: i.match_status, contractId: i.contract_id,
    contractNumber: i.contract_number === null ? null : Number(i.contract_number),
    reviewedAt: i.reviewed_at, reviewReason: i.review_reason,
    notes: i.notes, createdAt: i.created_at,
  };
}

async function loadInfraction(db: Queryable, auth: ResolvedSession, id: string, lock = false) {
  const params: unknown[] = [id];
  const scope = branchFilter(auth, 'v.branch_id', params);
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1 AND ${scope}${lock ? ' FOR UPDATE OF i' : ''}`, params);
  if (!rows[0]) throw notFound('Infraction not found');
  return rows[0] as InfractionRow;
}

export function infractionsRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'infractions.read'), async (req, res) => {
    const q = parseQuery(Filter, req);
    const auth = res.locals.auth!;
    const params: unknown[] = [];
    const conditions: string[] = [branchFilter(auth, 'v.branch_id', params)];
    if (q.vehicleId) { params.push(q.vehicleId); conditions.push(`i.vehicle_id = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); conditions.push(`v.branch_id = $${params.length}`); }
    if (q.status) { params.push(q.status); conditions.push(`i.status = $${params.length}`); }
    const { rows } = await db.query(`${SELECT} WHERE ${conditions.join(' AND ')} ORDER BY i.occurred_at DESC, i.created_at DESC LIMIT 300`, params);
    res.json({ items: rows.map(dto) });
  });

  r.post('/', requirePermission(db, 'infractions.manage'), async (req, res) => {
    const b = parseBody(Create, req);
    const auth = res.locals.auth!;
    try {
      const id = await withTransaction(db, async (tx) => {
        const v = await loadScoped(tx, auth, b.vehicleId, true);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO road_infractions
           (vehicle_id, branch_id, issuer, notice_number, occurred_at, notified_on, location, kind, amount_cents, notes, created_by)
           VALUES ($1,$2,$3,$4,$5::timestamp AT TIME ZONE 'Africa/Casablanca',$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [b.vehicleId, v.branch_id, b.issuer, b.noticeNumber, b.occurredLocal, b.notifiedOn ?? null,
            b.location, b.kind, b.amountCents, b.notes, auth.user.id],
        );
        const id = rows[0]!.id;
        await tx.query(`INSERT INTO road_infraction_events (infraction_id, action, actor_user_id)
                        VALUES ($1, 'registered', $2)`, [id, auth.user.id]);
        await recordAudit(tx, { ...auditContext(req, res), action: 'infraction.registered',
          targetType: 'road_infraction', targetId: id, metadata: { vehicleId: b.vehicleId } });
        return id;
      });
      const stored = await loadInfraction(db, auth, id);
      res.status(201).json({ infraction: dto(stored) });
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'road_infractions_notice_key')
        throw conflict('This vehicle already has this notice from this issuing authority');
      throw err;
    }
  });

  r.get('/:id/candidates', requirePermission(db, 'infractions.manage'), async (req, res) => {
    const { id } = parseParams(Id, req);
    const i = await loadInfraction(db, res.locals.auth!, id);
    // Actual departure and actual return are authoritative. If no return exists yet, the
    // planned end is only an indication; a manager reviews the resulting candidates.
    const { rows } = await db.query(
      `SELECT c.id, c.number, c.out_at, c.in_at, c.planned_end_at
         FROM contracts c
        WHERE c.vehicle_id = $1 AND c.out_at <= $2 AND COALESCE(c.in_at, c.planned_end_at) > $2
        ORDER BY c.out_at DESC LIMIT 20`, [i.vehicle_id, i.occurred_at]);
    res.json({ candidates: rows.map((c) => ({ id: c.id, number: Number(c.number),
      outAt: c.out_at, inAt: c.in_at, plannedEndAt: c.planned_end_at,
      provisional: c.in_at === null })) });
  });

  r.post('/:id/match', requirePermission(db, 'infractions.manage'), async (req, res) => {
    const { id } = parseParams(Id, req);
    const b = parseBody(Match, req);
    const auth = res.locals.auth!;
    await withTransaction(db, async (tx) => {
      const i = await loadInfraction(tx, auth, id, true);
      if (b.contractId) {
        const selected = await tx.query(
          `SELECT 1 FROM contracts c WHERE c.id = $1 AND c.vehicle_id = $2
             AND c.out_at <= $3 AND COALESCE(c.in_at, c.planned_end_at) > $3`,
          [b.contractId, i.vehicle_id, i.occurred_at]);
        if (!selected.rowCount) throw new AppError(400, 'contract_not_candidate', 'Contract does not match the vehicle and incident time');
      }
      const matchStatus = b.contractId ? 'confirmed' : 'no_contract';
      if (i.contract_id === b.contractId && i.match_status === matchStatus)
        throw conflict('This review decision is already recorded');
      await tx.query(
        `UPDATE road_infractions SET contract_id = $2, match_status = $3,
               reviewed_at = now(), reviewed_by = $4, review_reason = $5, updated_at = now() WHERE id = $1`,
        [id, b.contractId, matchStatus, auth.user.id, b.reason]);
      await tx.query(
        `INSERT INTO road_infraction_events
          (infraction_id, action, previous_contract_id, next_contract_id, reason, actor_user_id)
         VALUES ($1, 'match_reviewed', $2, $3, $4, $5)`,
        [id, i.contract_id, b.contractId, b.reason, auth.user.id]);
      await recordAudit(tx, { ...auditContext(req, res), action: 'infraction.match_reviewed',
        targetType: 'road_infraction', targetId: id,
        metadata: { matchStatus, previousContractId: i.contract_id, contractId: b.contractId } });
    });
    res.json({ infraction: dto(await loadInfraction(db, auth, id)) });
  });

  r.post('/:id/status', requirePermission(db, 'infractions.manage'), async (req, res) => {
    const { id } = parseParams(Id, req);
    const b = parseBody(StatusChange, req);
    const auth = res.locals.auth!;
    if (b.status === 'paid' && !b.paymentReference)
      throw new AppError(400, 'payment_reference_required', 'A payment reference is required before marking a fine as paid');
    await withTransaction(db, async (tx) => {
      const i = await loadInfraction(tx, auth, id, true);
      if (i.status === b.status) throw conflict('This status is already recorded');
      await tx.query(
        `UPDATE road_infractions SET status = $2, payment_reference = COALESCE($3, payment_reference), updated_at = now()
         WHERE id = $1`, [id, b.status, b.paymentReference]);
      await tx.query(
        `INSERT INTO road_infraction_events
         (infraction_id, action, previous_status, next_status, reason, actor_user_id)
         VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
        [id, i.status, b.status, b.reason, auth.user.id]);
      await recordAudit(tx, { ...auditContext(req, res), action: 'infraction.status_changed',
        targetType: 'road_infraction', targetId: id, metadata: { from: i.status, to: b.status } });
    });
    res.json({ infraction: dto(await loadInfraction(db, auth, id)) });
  });

  return r;
}
