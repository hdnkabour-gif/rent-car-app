import { Router } from 'express';
import { z } from 'zod';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { AppError, conflict, notFound } from '../http/errors.js';
import { parseBody, parseParams } from '../http/validate.js';
import { auditContext, diffFields, recordAudit } from '../audit/audit.js';
import { hashPassword } from '../auth/password.js';
import { requirePermission } from '../auth/middleware.js';
import { revokeAllUserSessions } from '../auth/sessions.js';
import { emailSchema, languageSchema, newPasswordSchema, roleSchema, uuidParam } from './schemas.js';

const fullNameSchema = z.string().trim().min(1).max(120);

const CreateUserBody = z.object({
  email: emailSchema,
  fullName: fullNameSchema,
  role: roleSchema,
  password: newPasswordSchema,
  preferredLanguage: languageSchema.default('fr'),
});

const UpdateUserBody = z
  .object({
    fullName: fullNameSchema.optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
    preferredLanguage: languageSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'No changes supplied' });

const ResetPasswordBody = z.object({ newPassword: newPasswordSchema });

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role_code: string;
  is_active: boolean;
  preferred_language: string;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = 'id, email, full_name, role_code, is_active, preferred_language, last_login_at, created_at';

const toDto = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  role: u.role_code,
  isActive: u.is_active,
  preferredLanguage: u.preferred_language,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

async function countOtherActiveManagers(db: Queryable, excludeId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users WHERE role_code = 'manager' AND is_active AND id <> $1`,
    [excludeId],
  );
  return rows[0]?.n ?? 0;
}

export function usersRouter(db: Db): Router {
  const r = Router();

  r.get('/', requirePermission(db, 'users.read'), async (_req, res) => {
    const { rows } = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY is_active DESC, full_name`);
    res.json({ items: rows.map(toDto) });
  });

  r.post('/', requirePermission(db, 'users.manage'), async (req, res) => {
    const body = parseBody(CreateUserBody, req);
    const passwordHash = await hashPassword(body.password);
    const user = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<UserRow>(
        `INSERT INTO users (email, full_name, role_code, password_hash, preferred_language)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING
         RETURNING ${USER_COLUMNS}`,
        [body.email, body.fullName, body.role, passwordHash, body.preferredLanguage],
      );
      const created = rows[0];
      if (!created) throw conflict('A user with this email already exists');
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'user.create',
        targetType: 'user',
        targetId: created.id,
        metadata: { role: created.role_code },
      });
      return created;
    });
    res.status(201).json(toDto(user));
  });

  r.patch('/:id', requirePermission(db, 'users.manage'), async (req, res) => {
    const { id } = parseParams(uuidParam, req);
    const body = parseBody(UpdateUserBody, req);
    const actorId = res.locals.auth!.user.id;

    const updated = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      const before = rows[0];
      if (!before) throw notFound('User not found');

      const removingManager =
        before.role_code === 'manager' &&
        before.is_active &&
        ((body.role !== undefined && body.role !== 'manager') || body.isActive === false);
      if (removingManager) {
        if (id === actorId) throw new AppError(409, 'self_lockout', 'You cannot remove your own manager access');
        // Serialise concurrent demotions so two requests cannot remove the last two managers.
        await tx.query(`SELECT id FROM users WHERE role_code = 'manager' AND is_active FOR UPDATE`);
        if ((await countOtherActiveManagers(tx, id)) === 0) {
          throw new AppError(409, 'last_manager', 'At least one active manager is required');
        }
      }

      const { rows: after } = await tx.query<UserRow>(
        `UPDATE users SET
            full_name = COALESCE($2, full_name),
            role_code = COALESCE($3, role_code),
            is_active = COALESCE($4, is_active),
            preferred_language = COALESCE($5, preferred_language),
            updated_at = now()
          WHERE id = $1
          RETURNING ${USER_COLUMNS}`,
        [id, body.fullName ?? null, body.role ?? null, body.isActive ?? null, body.preferredLanguage ?? null],
      );
      const next = after[0]!;

      let revoked = 0;
      if (before.is_active && !next.is_active) revoked = await revokeAllUserSessions(tx, id, 'user_deactivated');
      else if (before.role_code !== next.role_code) revoked = await revokeAllUserSessions(tx, id, 'role_changed');

      const changes = diffFields(
        { fullName: before.full_name, role: before.role_code, isActive: before.is_active, preferredLanguage: before.preferred_language },
        { fullName: next.full_name, role: next.role_code, isActive: next.is_active, preferredLanguage: next.preferred_language },
      );
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: before.is_active && !next.is_active ? 'user.deactivate' : 'user.update',
        targetType: 'user',
        targetId: id,
        metadata: { changes, revokedSessions: revoked },
      });
      return next;
    });
    res.json(toDto(updated));
  });

  r.post('/:id/reset-password', requirePermission(db, 'users.manage'), async (req, res) => {
    const { id } = parseParams(uuidParam, req);
    const body = parseBody(ResetPasswordBody, req);
    const hash = await hashPassword(body.newPassword);
    await withTransaction(db, async (tx) => {
      const upd = await tx.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0,
                          locked_until = NULL, updated_at = now()
          WHERE id = $1`,
        [id, hash],
      );
      if (upd.rowCount === 0) throw notFound('User not found');
      const revoked = await revokeAllUserSessions(tx, id, 'password_changed');
      await recordAudit(tx, {
        ...auditContext(req, res),
        action: 'user.password_reset',
        targetType: 'user',
        targetId: id,
        metadata: { revokedSessions: revoked },
      });
    });
    res.status(204).end();
  });

  return r;
}
