import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { parseQuery } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import { assertBranchInScope, branchFilter } from '../domain/scope.js';

const TZ = 'Africa/Casablanca';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const Range = z.object({ from: isoDate, to: isoDate, branchId: z.uuid().optional() });

/** Keeps spreadsheets safe: a cell starting with = + - @ is never run as a formula (CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const money = (c: number | string) => (Number(c) / 100).toFixed(2).replace('.', ',');

export function reportsRouter(db: Db): Router {
  const r = Router();

  function scope(req: Parameters<Parameters<Router['get']>[1]>[0], res: Parameters<Parameters<Router['get']>[1]>[1], column: string, params: unknown[]) {
    const q = parseQuery(Range, req);
    if (q.to < q.from) throw new AppError(400, 'validation_failed', 'End before start', [{ path: 'to', message: 'Before start' }]);
    const where = [branchFilter(res.locals.auth!, column, params)];
    if (q.branchId) {
      assertBranchInScope(res.locals.auth!, q.branchId);
      params.push(q.branchId);
      where.push(`${column} = $${params.length}`);
    }
    return { q, where };
  }

  /**
   * Business summary for a period. Rent paid and deposits kept are income; deposits received and
   * returned are NOT income (CLAUDE.md). Expenses by category. Fleet use = rented time / period.
   */
  r.get('/summary', requirePermission(db, 'reports.read'), async (req, res) => {
    const p1: unknown[] = [];
    const { q, where } = scope(req, res, 'p.branch_id', p1);
    p1.push(q.from, q.to);
    const fromI = p1.length - 1;
    const toI = p1.length;
    const pay = await db.query<{ kind: string; method: string; total: string }>(
      `SELECT CASE WHEN coalesce(o.kind, p.kind) = 'rental_refund' THEN 'rental' ELSE coalesce(o.kind, p.kind) END AS kind, p.method,
              sum(CASE WHEN p.kind = 'reversal' THEN -p.amount_cents ELSE p.amount_cents END
                  * CASE WHEN coalesce(o.kind, p.kind) = 'rental_refund' THEN -1 ELSE 1 END) AS total
         FROM payments p LEFT JOIN payments o ON o.id = p.reverses_id
        WHERE ${where.join(' AND ')} AND (p.created_at AT TIME ZONE '${TZ}')::date BETWEEN $${fromI} AND $${toI}
        GROUP BY 1, 2`,
      p1,
    );
    const p2: unknown[] = [];
    const s2 = scope(req, res, 'e.branch_id', p2);
    p2.push(q.from, q.to);
    const exp = await db.query<{ category: string; total: string }>(
      `SELECT coalesce(o.category, e.category) AS category, sum(CASE WHEN e.kind = 'reversal' THEN -e.amount_cents ELSE e.amount_cents END) AS total
         FROM expenses e LEFT JOIN expenses o ON o.id = e.reverses_id
        WHERE ${s2.where.join(' AND ')} AND e.spent_on BETWEEN $${p2.length - 1} AND $${p2.length} GROUP BY 1`,
      p2,
    );
    const p3: unknown[] = [];
    const s3 = scope(req, res, 'k.branch_id', p3);
    p3.push(q.from, q.to);
    const k = (
      await db.query<{ contracts: number; days: string | null; billed: string | null; late_fees: string | null; outstanding: string | null }>(
        `SELECT count(*)::int AS contracts, sum(k.days) AS days, sum(k.total_cents) AS billed, sum(k.late_fee_cents) AS late_fees,
                sum(k.total_cents - coalesce((SELECT sum(CASE WHEN x.kind = 'rental' THEN x.amount_cents WHEN x.kind = 'reversal' AND o.kind = 'rental' THEN -x.amount_cents
                                                             WHEN x.kind = 'rental_refund' THEN -x.amount_cents WHEN x.kind = 'reversal' AND o.kind = 'rental_refund' THEN x.amount_cents ELSE 0 END)
                                         FROM payments x LEFT JOIN payments o ON o.id = x.reverses_id WHERE x.contract_id = k.id), 0)) AS outstanding
           FROM contracts k WHERE ${s3.where.join(' AND ')} AND (k.out_at AT TIME ZONE '${TZ}')::date BETWEEN $${p3.length - 1} AND $${p3.length}`,
        p3,
      )
    ).rows[0]!;
    const p4: unknown[] = [];
    const s4 = scope(req, res, 'r.branch_id', p4);
    p4.push(q.from, q.to);
    const resv = (
      await db.query<{ created: number; cancelled: number; no_show: number }>(
        `SELECT count(*)::int AS created, count(*) FILTER (WHERE r.status = 'cancelled')::int AS cancelled, count(*) FILTER (WHERE r.status = 'no_show')::int AS no_show
           FROM reservations r WHERE ${s4.where.join(' AND ')} AND (r.created_at AT TIME ZONE '${TZ}')::date BETWEEN $${p4.length - 1} AND $${p4.length}`,
        p4,
      )
    ).rows[0]!;
    const p5: unknown[] = [];
    const s5 = scope(req, res, 'v.branch_id', p5);
    p5.push(q.from, q.to);
    const fleet = await db.query<{ id: string; plate: string; make: string; model: string; rented_hours: string; revenue: string | null }>(
      `WITH win AS (SELECT ($${p5.length - 1}::date::timestamp AT TIME ZONE '${TZ}') AS a, (($${p5.length}::date + 1)::timestamp AT TIME ZONE '${TZ}') AS b)
       SELECT v.id, v.plate, v.make, v.model,
              coalesce(sum(extract(epoch FROM (least(coalesce(k.in_at, now()), win.b) - greatest(k.out_at, win.a))) / 3600)
                       FILTER (WHERE k.id IS NOT NULL AND least(coalesce(k.in_at, now()), win.b) > greatest(k.out_at, win.a)), 0) AS rented_hours,
              sum(k.total_cents) FILTER (WHERE (k.out_at AT TIME ZONE '${TZ}')::date BETWEEN $${p5.length - 1} AND $${p5.length}) AS revenue
         FROM vehicles v CROSS JOIN win LEFT JOIN contracts k ON k.vehicle_id = v.id
        WHERE ${s5.where.join(' AND ')} AND v.status <> 'retired' GROUP BY v.id, v.plate, v.make, v.model ORDER BY 5 DESC`,
      p5,
    );
    const periodHours = ((Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86400_000 + 1) * 24;

    const by = (kind: string) => Object.fromEntries(pay.rows.filter((x) => x.kind === kind).map((x) => [x.method, Number(x.total)]));
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    const rental = by('rental');
    const kept = by('deposit_kept');
    const expenses = Object.fromEntries(exp.rows.map((x) => [x.category, Number(x.total)]));
    const income = sum(rental) + sum(kept);
    res.json({
      from: q.from,
      to: q.to,
      income: { rentalByMethod: rental, rentalCents: sum(rental), depositKeptCents: sum(kept), totalCents: income },
      deposits: { receivedByMethod: by('deposit_in'), receivedCents: sum(by('deposit_in')), returnedCents: sum(by('deposit_out')), keptCents: sum(kept) },
      expenses: { byCategory: expenses, totalCents: sum(expenses) },
      resultCents: income - sum(expenses),
      contracts: { count: k.contracts, days: Number(k.days ?? 0), billedCents: Number(k.billed ?? 0), lateFeesCents: Number(k.late_fees ?? 0), outstandingCents: Number(k.outstanding ?? 0) },
      reservations: resv,
      fleet: fleet.rows.map((v) => ({ id: v.id, plate: v.plate, make: v.make, model: v.model, utilisation: Math.min(1, Number(v.rented_hours) / periodHours), revenueCents: Number(v.revenue ?? 0) })),
    });
  });

  /** CSV for the accountant (semicolon, UTF-8 with BOM: opens directly in Excel FR). */
  r.get('/export.csv', requirePermission(db, 'reports.read'), async (req, res) => {
    const { type } = parseQuery(z.object({ type: z.enum(['payments', 'expenses']) }).passthrough(), req);
    const params: unknown[] = [];
    const col = type === 'payments' ? 'p.branch_id' : 'e.branch_id';
    const { q, where } = scope(req, res, col, params);
    params.push(q.from, q.to);
    let lines: string[];
    if (type === 'payments') {
      const { rows } = await db.query(
        `SELECT p.created_at, b.name AS branch, k.number, c.full_name, p.kind, coalesce(o.kind, '') AS reverses_kind, p.method, p.amount_cents, p.reference, p.reason, u.full_name AS by
           FROM payments p JOIN contracts k ON k.id = p.contract_id JOIN customers c ON c.id = k.customer_id JOIN branches b ON b.id = p.branch_id
           LEFT JOIN payments o ON o.id = p.reverses_id LEFT JOIN users u ON u.id = p.created_by
          WHERE ${where.join(' AND ')} AND (p.created_at AT TIME ZONE '${TZ}')::date BETWEEN $${params.length - 1} AND $${params.length} ORDER BY p.created_at`,
        params,
      );
      lines = ['Date;Agence;Contrat;Client;Type;Corrige;Mode;Montant MAD;Reference;Motif;Par'];
      for (const x of rows) lines.push([new Date(x.created_at).toISOString(), x.branch, `C-${String(x.number).padStart(5, '0')}`, x.full_name, x.kind, x.reverses_kind, x.method, money(x.kind === 'reversal' ? -x.amount_cents : x.amount_cents), x.reference, x.reason, x.by].map(csvCell).join(';'));
    } else {
      const { rows } = await db.query(
        `SELECT e.spent_on::text AS d, b.name AS branch, v.plate, e.kind, e.category, e.method, e.amount_cents, e.supplier, e.reference, coalesce(e.reason, e.notes) AS notes, u.full_name AS by
           FROM expenses e JOIN branches b ON b.id = e.branch_id LEFT JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN users u ON u.id = e.created_by
          WHERE ${where.join(' AND ')} AND e.spent_on BETWEEN $${params.length - 1} AND $${params.length} ORDER BY e.spent_on, e.created_at`,
        params,
      );
      lines = ['Date;Agence;Vehicule;Type;Categorie;Mode;Montant MAD;Fournisseur;Reference;Notes;Par'];
      for (const x of rows) lines.push([x.d, x.branch, x.plate, x.kind, x.category, x.method, money(x.kind === 'reversal' ? -x.amount_cents : x.amount_cents), x.supplier, x.reference, x.notes, x.by].map(csvCell).join(';'));
    }
    await recordAudit(db, { ...auditContext(req, res), action: 'report.export', metadata: { type, from: q.from, to: q.to, rows: lines.length - 1 } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fleetora-${type}-${q.from}_${q.to}.csv"`);
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  return r;
}
