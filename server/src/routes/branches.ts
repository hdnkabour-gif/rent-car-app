import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/pool.js';
import { conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams } from '../http/validate.js';
import { auditContext, diffFields, recordAudit } from '../audit/audit.js';
import { requirePermission } from '../auth/middleware.js';
import { branchScope } from '../domain/scope.js';
import { uuidParam } from './schemas.js';

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const BranchBody = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,6}$/, 'Code: 2 to 6 letters or digits'),
    name: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(100),
    address: optText(300),
    phone: optText(30),
    isActive: z.boolean().default(true),
  })
  .strict();

interface BranchRow {
  id: string;
  code: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
  vehicle_count: number;
}

const toDto = (b: BranchRow) => ({
  id: b.id,
  code: b.code,
  name: b.name,
  city: b.city,
  address: b.address,
  phone: b.phone,
  isActive: b.is_active,
  vehicleCount: b.vehicle_count,
});

const SELECT = `SELECT b.id, b.code, b.name, b.city, b.address, b.phone, b.is_active,
                       (SELECT count(*)::int FROM vehicles v WHERE v.branch_id = b.id AND v.status <> 'retired') AS vehicle_count
                  FROM branches b`;

export function branchesRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'branches.read'), async (_req, res) => {
    const scope = branchScope(res.locals.auth!);
    const { rows } = await db.query<BranchRow>(
      `${SELECT} ${scope === null ? '' : 'WHERE b.id = ANY($1::uuid[])'} ORDER BY b.is_active DESC, b.name`,
      scope === null ? [] : [scope],
    );
    res.json({ items: rows.map(toDto) });
  });

  r.post('/', requirePermission(db, 'branches.manage'), async (req, res) => {
    const b = parseBody(BranchBody, req);
    const created = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO branches (code, name, city, address, phone, is_active) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [b.code, b.name, b.city, b.address, b.phone, b.isActive],
      );
      if (!rows[0]) throw conflict('A branch with this code already exists');
      await recordAudit(tx, { ...auditContext(req, res), action: 'branch.create', targetType: 'branch', targetId: rows[0].id, metadata: { code: b.code } });
      return (await tx.query<BranchRow>(`${SELECT} WHERE b.id = $1`, [rows[0].id])).rows[0]!;
    });
    res.status(201).json(toDto(created));
  });

  r.put('/:id', requirePermission(db, 'branches.manage'), async (req, res) => {
    const { id } = parseParams(uuidParam, req);
    const b = parseBody(BranchBody, req);
    const updated = await withTransaction(db, async (tx) => {
      const before = (await tx.query<BranchRow>(`${SELECT} WHERE b.id = $1 FOR UPDATE OF b`, [id])).rows[0];
      if (!before) throw notFound('Branch not found');
      const dup = await tx.query('SELECT 1 FROM branches WHERE code = $1 AND id <> $2', [b.code, id]);
      if (dup.rowCount) throw conflict('A branch with this code already exists');
      await tx.query(
        `UPDATE branches SET code = $2, name = $3, city = $4, address = $5, phone = $6, is_active = $7, updated_at = now() WHERE id = $1`,
        [id, b.code, b.name, b.city, b.address, b.phone, b.isActive],
      );
      const after = (await tx.query<BranchRow>(`${SELECT} WHERE b.id = $1`, [id])).rows[0]!;
      const pick = (x: BranchRow) => ({ code: x.code, name: x.name, city: x.city, address: x.address, phone: x.phone, isActive: x.is_active });
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'branch.update',
        targetType: 'branch',
        targetId: id,
        metadata: { changes: diffFields(pick(before), pick(after)) },
      });
      return after;
    });
    res.json(toDto(updated));
  });

  return r;
}
