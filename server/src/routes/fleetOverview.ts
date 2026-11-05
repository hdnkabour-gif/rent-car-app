import { Router } from 'express';
import type { Db } from '../db/pool.js';
import { requirePermission } from '../auth/middleware.js';
import { branchFilter } from '../domain/scope.js';
import { scopedPlans } from './maintenance.js';

const TZ = 'Africa/Casablanca';
const STATUS_ORDER = ['rented', 'available', 'inspection_pending', 'maintenance', 'out_of_service'];

/**
 * Home screen, vehicle first: every vehicle in the user's branches with what matters about it now —
 * where it is (open contract: who and until when, late?), its next booking, document and
 * maintenance alerts, mileage and fuel. Customer names only for users allowed to see customers.
 */
export function fleetOverviewRouter(db: Db): Router {
  const r = Router();

  r.get('/overview', requirePermission(db, 'vehicles.read'), async (_req, res) => {
    const auth = res.locals.auth!;
    const perms = new Set(auth.permissions);
    const showCustomer = perms.has('customers.read');
    const showContracts = perms.has('contracts.read');
    const showReservations = perms.has('reservations.read');
    const params: unknown[] = [];
    const scope = branchFilter(auth, 'v.branch_id', params);
    const { rows } = await db.query(
      `SELECT v.id, v.plate, v.make, v.model, v.status, v.mileage_km, v.fuel_eighths, v.status_changed_at,
              b.id AS branch_id, b.name AS branch_name,
              d.doc_alert, d.doc_next_type, d.doc_next_expiry,
              k.id AS k_id, k.number AS k_number, k.planned_end_at AS k_end, k.out_at AS k_out, kc.full_name AS k_customer, kc.phone AS k_phone,
              n.id AS r_id, n.number AS r_number, n.start_at AS r_start, n.end_at AS r_end, nc.full_name AS r_customer
         FROM vehicles v JOIN branches b ON b.id = v.branch_id
         LEFT JOIN LATERAL (
           SELECT CASE WHEN bool_or(x.expiry_date < (now() AT TIME ZONE '${TZ}')::date) THEN 'expired'
                       WHEN bool_or(x.expiry_date <= (now() AT TIME ZONE '${TZ}')::date + 30) THEN 'expiring' END AS doc_alert,
                  (array_agg(x.doc_type ORDER BY x.expiry_date) FILTER (WHERE x.expiry_date <= (now() AT TIME ZONE '${TZ}')::date + 30))[1] AS doc_next_type,
                  (min(x.expiry_date) FILTER (WHERE x.expiry_date <= (now() AT TIME ZONE '${TZ}')::date + 30))::text AS doc_next_expiry
             FROM vehicle_documents x WHERE x.vehicle_id = v.id AND x.archived_at IS NULL) d ON true
         LEFT JOIN LATERAL (
           SELECT c.id, c.number, c.planned_end_at, c.out_at, c.customer_id FROM contracts c
            WHERE c.vehicle_id = v.id AND c.status = 'open' ORDER BY c.out_at DESC LIMIT 1) k ON true
         LEFT JOIN customers kc ON kc.id = k.customer_id
         LEFT JOIN LATERAL (
           SELECT x.id, x.number, x.start_at, x.end_at, x.customer_id FROM reservations x
            WHERE x.vehicle_id = v.id AND x.status = 'confirmed' AND x.end_at > now() ORDER BY x.start_at LIMIT 1) n ON true
         LEFT JOIN customers nc ON nc.id = n.customer_id
        WHERE v.status <> 'retired' AND ${scope}
        ORDER BY b.name, v.make, v.model, v.plate LIMIT 500`,
      params,
    );
    const plans = await scopedPlans(db, auth);
    const mt = new Map<string, { due: number; soon: number; next: { item: string; label: string | null; kmLeft: number | null; daysLeft: number | null } | null }>();
    for (const p of plans) {
      if (p.status !== 'due' && p.status !== 'soon') continue;
      const m = mt.get(p.vehicle.id) ?? { due: 0, soon: 0, next: null };
      m[p.status] += 1;
      if (!m.next || p.status === 'due') m.next = { item: p.item, label: p.label, kmLeft: p.kmLeft, daysLeft: p.daysLeft };
      mt.set(p.vehicle.id, m);
    }
    const now = Date.now();
    const items = rows.map((v) => {
      const contract = showContracts && v.k_id
        ? { id: v.k_id, number: Number(v.k_number), outAt: v.k_out, plannedEndAt: v.k_end, late: new Date(v.k_end).getTime() < now, customer: showCustomer ? v.k_customer : null, phone: showCustomer ? v.k_phone : null }
        : null;
      const nextReservation = showReservations && v.r_id
        ? { id: v.r_id, number: Number(v.r_number), startAt: v.r_start, endAt: v.r_end, customer: showCustomer ? v.r_customer : null }
        : null;
      const m = mt.get(v.id);
      const attention =
        (contract?.late ? 1 : 0) + (v.doc_alert === 'expired' ? 1 : 0) + (m?.due ? 1 : 0) + (v.status === 'out_of_service' ? 1 : 0);
      return {
        id: v.id, plate: v.plate, make: v.make, model: v.model, status: v.status, mileageKm: v.mileage_km, fuelEighths: v.fuel_eighths,
        branch: { id: v.branch_id, name: v.branch_name },
        contract, nextReservation,
        documents: v.doc_alert ? { alert: v.doc_alert, nextType: v.doc_next_type, nextExpiry: v.doc_next_expiry } : null,
        maintenance: m ? { status: m.due ? 'due' : 'soon', due: m.due, soon: m.soon, next: m.next } : null,
        needsAttention: attention > 0,
      };
    });
    items.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, items.filter((x) => x.status === s).length]));
    res.json({
      counts,
      total: items.length,
      attention: items.filter((x) => x.needsAttention).length,
      late: items.filter((x) => x.contract?.late).length,
      items,
    });
  });

  return r;
}
