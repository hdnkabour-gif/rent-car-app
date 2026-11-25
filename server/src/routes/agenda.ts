import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { requirePermission } from '../auth/middleware.js';
import { branchFilter } from '../domain/scope.js';
import { parseQuery } from '../http/validate.js';

const TZ = 'Africa/Casablanca';
const Day = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const todayCasablanca = () => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
type Kind = 'reservation' | 'pickup' | 'return' | 'payment' | 'maintenance' | 'document';
interface Event {
  id: string;
  kind: Kind;
  time: string | null;
  title: string;
  vehicle: { id: string; plate: string; make: string; model: string; photoFileId: string | null };
  branch: string;
  customer: string | null;
  reference: string | null;
  detail: string | null;
  link: string;
  overdue: boolean;
  urgent: boolean;
  amountCents: number | null;
  provisional: boolean;
}
const photo = (vehicleIdColumn: string) => `(SELECT vp.file_id FROM vehicle_photos vp WHERE vp.vehicle_id = ${vehicleIdColumn} AND vp.archived_at IS NULL ORDER BY vp.created_at DESC LIMIT 1)`;
const base = (row: Record<string, unknown>, kind: Kind, link: string): Event => ({
  id: `${kind}:${String(row.id)}`,
  kind, time: row.at ? new Date(row.at as string).toISOString() : null,
  title: kind,
  vehicle: {
    id: String(row.vehicle_id), plate: String(row.plate), make: String(row.make), model: String(row.model),
    photoFileId: row.photo_file_id ? String(row.photo_file_id) : null,
  },
  branch: String(row.branch_name), customer: row.customer_name ? String(row.customer_name) : null,
  reference: row.reference ? String(row.reference) : null,
  detail: row.detail ? String(row.detail) : null,
  link, overdue: Boolean(row.overdue), urgent: Boolean(row.urgent),
  amountCents: row.amount_cents === undefined || row.amount_cents === null ? null : Number(row.amount_cents),
  provisional: Boolean(row.provisional),
});

export function agendaRouter(db: Db): Router {
  const r = Router();
  r.get('/', requirePermission(db, 'dashboard.view'), async (req, res) => {
    const q = parseQuery(Day, req);
    const date = q.date ?? todayCasablanca();
    // A syntactically correct but impossible calendar date must not silently return an empty agenda.
    if (Number.isNaN(Date.parse(`${date}T12:00:00.000Z`)) || new Date(`${date}T12:00:00.000Z`).toISOString().slice(0, 10) !== date)
      return res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid calendar date' } });
    const auth = res.locals.auth!;
    const permissions = new Set(auth.permissions);
    const canSeeCustomer = permissions.has('customers.read');
    const items: Event[] = [];
    // Each query is filtered server-side by branch ownership. No endpoint ever uses client-submitted
    // branch ids to widen access; employee roles get only the event types they are authorized to read.
    if (permissions.has('reservations.read')) {
      const p: unknown[] = [date];
      const scope = branchFilter(auth, 'r.branch_id', p);
      const out = await db.query(
        `SELECT r.id, r.number AS reference, r.vehicle_id, r.start_at AS at,
                v.plate, v.make, v.model, ${photo('v.id')} AS photo_file_id,
                b.name AS branch_name, c.full_name AS customer_name,
                r.pickup_place AS detail, FALSE AS overdue, FALSE AS urgent
           FROM reservations r JOIN vehicles v ON v.id = r.vehicle_id
           JOIN branches b ON b.id = r.branch_id JOIN customers c ON c.id = r.customer_id
          WHERE ${scope} AND r.status = 'confirmed'
            AND (r.start_at AT TIME ZONE '${TZ}')::date = $1::date
          ORDER BY r.start_at LIMIT 100`, p,
      );
      items.push(...out.rows.map(row => base({ ...row, customer_name: canSeeCustomer ? row.customer_name : null }, 'reservation', `/reservations/${row.id}`)));
    }
    if (permissions.has('contracts.read')) {
      const p: unknown[] = [date];
      const scope = branchFilter(auth, 'k.branch_id', p);
      const take = await db.query(
        `SELECT k.id, k.number AS reference, k.vehicle_id, k.out_at AS at,
                v.plate, v.make, v.model, ${photo('v.id')} AS photo_file_id,
                b.name AS branch_name, c.full_name AS customer_name,
                NULL::text AS detail, FALSE AS overdue, FALSE AS urgent
           FROM contracts k JOIN vehicles v ON v.id=k.vehicle_id
           JOIN branches b ON b.id=k.branch_id JOIN customers c ON c.id=k.customer_id
          WHERE ${scope} AND (k.out_at AT TIME ZONE '${TZ}')::date = $1::date
          ORDER BY k.out_at LIMIT 100`, p,
      );
      items.push(...take.rows.map(row => base({ ...row, customer_name: canSeeCustomer ? row.customer_name : null }, 'pickup', `/contracts/${row.id}`)));
      const rp: unknown[] = [date];
      const retScope = branchFilter(auth, 'k.branch_id', rp);
      const returns = await db.query(
        `SELECT k.id, k.number AS reference, k.vehicle_id,
                CASE WHEN k.status='closed' THEN k.in_at ELSE k.planned_end_at END AS at,
                v.plate, v.make, v.model, ${photo('v.id')} AS photo_file_id,
                b.name AS branch_name, c.full_name AS customer_name,
                CASE WHEN k.status='closed' THEN 'returned'
                     WHEN k.planned_end_at < now() THEN 'late' ELSE 'expected' END AS detail,
                (k.status='open' AND k.planned_end_at < now()) AS overdue,
                (k.status='open' AND k.planned_end_at < now()) AS urgent,
                (k.status='open') AS provisional
           FROM contracts k JOIN vehicles v ON v.id=k.vehicle_id
           JOIN branches b ON b.id=k.branch_id JOIN customers c ON c.id=k.customer_id
          WHERE ${retScope} AND (
            (k.status='closed' AND (k.in_at AT TIME ZONE '${TZ}')::date = $1::date)
            OR (k.status='open' AND (
              (k.planned_end_at AT TIME ZONE '${TZ}')::date = $1::date
              OR (k.planned_end_at < now()
                  AND $1::date=(now() AT TIME ZONE '${TZ}')::date)))
          ) ORDER BY at LIMIT 100`, rp,
      );
      items.push(...returns.rows.map(row => base({ ...row, customer_name: canSeeCustomer ? row.customer_name : null }, 'return', `/contracts/${row.id}`)));

      if (permissions.has('cash.read')) {
        const pp: unknown[] = [date];
        const paymentScope = branchFilter(auth, 'k.branch_id', pp);
        const due = await db.query(
          `SELECT k.id, k.number AS reference, k.vehicle_id, k.planned_end_at AS at,
                  v.plate,v.make,v.model,${photo('v.id')} AS photo_file_id,
                  b.name AS branch_name, c.full_name AS customer_name,
                  'remaining' AS detail, (k.planned_end_at < now()) AS overdue,
                  (k.planned_end_at < now()) AS urgent,
                  greatest(k.total_cents - coalesce((
                    SELECT sum(CASE WHEN p.kind='rental' THEN p.amount_cents
                                    WHEN p.kind='reversal' AND o.kind='rental' THEN -p.amount_cents WHEN p.kind='rental_refund' THEN -p.amount_cents
                                    WHEN p.kind='reversal' AND o.kind='rental_refund' THEN p.amount_cents ELSE 0 END)
                    FROM payments p LEFT JOIN payments o ON o.id = p.reverses_id WHERE p.contract_id=k.id
                  ),0),0) AS amount_cents
             FROM contracts k JOIN vehicles v ON v.id=k.vehicle_id
             JOIN branches b ON b.id=k.branch_id JOIN customers c ON c.id=k.customer_id
            WHERE ${paymentScope} AND k.status='open'
              AND ((k.planned_end_at AT TIME ZONE '${TZ}')::date = $1::date
                OR (k.planned_end_at < now() AND $1::date=(now() AT TIME ZONE '${TZ}')::date))
              AND k.total_cents > coalesce((
                SELECT sum(CASE WHEN p.kind='rental' THEN p.amount_cents
                                WHEN p.kind='reversal' AND o.kind='rental' THEN -p.amount_cents WHEN p.kind='rental_refund' THEN -p.amount_cents
                                    WHEN p.kind='reversal' AND o.kind='rental_refund' THEN p.amount_cents ELSE 0 END)
                FROM payments p LEFT JOIN payments o ON o.id=p.reverses_id WHERE p.contract_id=k.id
              ),0) ORDER BY k.planned_end_at LIMIT 100`, pp,
        );
        items.push(...due.rows.map(row => base({ ...row, customer_name: canSeeCustomer ? row.customer_name : null }, 'payment', `/contracts/${row.id}`)));
      }
    }
    if (permissions.has('vehicles.read')) {
      const p: unknown[] = [date];
      const scope = branchFilter(auth, 'v.branch_id', p);
      const maintenance = await db.query(
        `SELECT p.id, p.vehicle_id, NULL::text AS reference,
                (p.last_done_on + make_interval(months => p.interval_months))::date::timestamp
                  AT TIME ZONE '${TZ}' AS at,
                v.plate,v.make,v.model,${photo('v.id')} AS photo_file_id,
                b.name AS branch_name, NULL::text AS customer_name, coalesce(p.label,p.item) AS detail,
                ((p.last_done_on + make_interval(months => p.interval_months))::date < $1::date) AS overdue,
                TRUE AS urgent
           FROM maintenance_plans p JOIN vehicles v ON v.id=p.vehicle_id
           JOIN branches b ON b.id=v.branch_id
          WHERE ${scope} AND p.archived_at IS NULL AND v.status<>'retired'
            AND p.interval_months IS NOT NULL AND p.last_done_on IS NOT NULL
            AND ((p.last_done_on + make_interval(months => p.interval_months))::date = $1::date
             OR ((p.last_done_on + make_interval(months => p.interval_months))::date < $1::date
                 AND $1::date=(now() AT TIME ZONE '${TZ}')::date))
          ORDER BY at LIMIT 70`, p,
      );
      items.push(...maintenance.rows.map(row => base(row, 'maintenance', `/vehicles/${row.vehicle_id}`)));
      const d: unknown[] = [date];
      const documentScope = branchFilter(auth, 'v.branch_id', d);
      const docs = await db.query(
        `SELECT d.id,d.vehicle_id,NULL::text AS reference,
                d.expiry_date::timestamp AT TIME ZONE '${TZ}' AS at,
                v.plate,v.make,v.model,${photo('v.id')} AS photo_file_id,
                b.name AS branch_name,NULL::text AS customer_name,
                coalesce(d.label,d.doc_type) AS detail,
                (d.expiry_date < $1::date) AS overdue,TRUE AS urgent
           FROM vehicle_documents d JOIN vehicles v ON v.id=d.vehicle_id
           JOIN branches b ON b.id=v.branch_id
          WHERE ${documentScope} AND d.archived_at IS NULL AND d.expiry_date IS NOT NULL
            AND (d.expiry_date = $1::date OR
                (d.expiry_date < $1::date AND $1::date=(now() AT TIME ZONE '${TZ}')::date))
          ORDER BY d.expiry_date LIMIT 70`, d,
      );
      items.push(...docs.rows.map(row => base(row, 'document', `/vehicles/${row.vehicle_id}`)));
    }
    const priority: Record<Kind, number> = { document: 0, maintenance: 1, return: 2, payment: 3, reservation: 4, pickup: 5 };
    items.sort((a,b) => Number(b.overdue)-Number(a.overdue) ||
      (a.time ?? '').localeCompare(b.time ?? '') || priority[a.kind]-priority[b.kind]);
    // Even when a role may see reservations, it must not learn private vehicle photo file IDs
    // unless that role also has the explicit vehicles.read permission.
    if (!permissions.has('vehicles.read')) for (const event of items) event.vehicle.photoFileId = null;
    const data = items.slice(0,150);
    res.json({
      date, today: todayCasablanca(), generatedAt: new Date().toISOString(),
      truncated: items.length > data.length,
      totals: {
        reservations: data.filter(x=>x.kind==='reservation').length,
        pickups: data.filter(x=>x.kind==='pickup').length,
        returns: data.filter(x=>x.kind==='return').length,
        attention: data.filter(x=>x.urgent).length,
        outstandingCents: data.filter(x=>x.kind==='payment').reduce((sum,x)=>sum+(x.amountCents ?? 0),0),
      },
      items: data,
    });
  });
  return r;
}
