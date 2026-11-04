import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { parseQuery } from '../http/validate.js';
import { requirePermission } from '../auth/middleware.js';

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Keyset pagination: return entries with id < before.
  before: z.coerce.number().int().positive().optional(),
  action: z.string().regex(/^[a-z_.]{1,60}$/).optional(),
  actorUserId: z.uuid().optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
});

export function auditLogsRouter(db: Db): Router {
  const r = Router();
  r.get('/', requirePermission(db, 'audit_logs.read'), async (req, res) => {
    const q = parseQuery(Query, req);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.before) add('a.id < ?', q.before);
    if (q.action) add('a.action = ?', q.action);
    if (q.actorUserId) add('a.actor_user_id = ?', q.actorUserId);
    if (q.outcome) add('a.outcome = ?', q.outcome);
    params.push(q.limit + 1);
    const { rows } = await db.query<{
      id: string;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_name: string | null;
      action: string;
      outcome: string;
      target_type: string | null;
      target_id: string | null;
      target_name: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT a.id, a.occurred_at, a.actor_user_id, u.full_name AS actor_name, a.action, a.outcome,
              a.target_type, a.target_id,
              COALESCE(tu.full_name, tc.full_name, tv.make || ' ' || tv.model || ' · ' || tv.plate, tb.name,
                       'R-' || lpad(tr.number::text, 5, '0')) AS target_name,
              a.metadata
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN users tu ON a.target_type = 'user' AND tu.id::text = a.target_id
         LEFT JOIN customers tc ON a.target_type = 'customer' AND tc.id::text = a.target_id
         LEFT JOIN vehicles tv ON a.target_type = 'vehicle' AND tv.id::text = a.target_id
         LEFT JOIN branches tb ON a.target_type = 'branch' AND tb.id::text = a.target_id
         LEFT JOIN reservations tr ON a.target_type = 'reservation' AND tr.id::text = a.target_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map((r) => ({
      id: Number(r.id),
      occurredAt: r.occurred_at,
      actor: r.actor_user_id ? { id: r.actor_user_id, fullName: r.actor_name } : null,
      action: r.action,
      outcome: r.outcome,
      targetType: r.target_type,
      targetId: r.target_id,
      // Human-readable target for the UI (staff should not see raw ids).
      targetName: r.target_name,
      metadata: r.metadata,
    }));
    res.json({ items, nextBefore: hasMore ? items[items.length - 1]!.id : null });
  });
  return r;
}
