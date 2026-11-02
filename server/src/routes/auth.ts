import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { withTransaction, type Db } from '../db/pool.js';
import { AppError, unauthorized } from '../http/errors.js';
import { parseBody } from '../http/validate.js';
import { auditContext, recordAudit } from '../audit/audit.js';
import { getDummyHash, hashPassword, needsRehash, PASSWORD_MAX_LENGTH, verifyPassword } from '../auth/password.js';
import { createSession, revokeAllUserSessions, revokeSession } from '../auth/sessions.js';
import { requireAuth } from '../auth/middleware.js';
import { emailSchema, languageSchema, newPasswordSchema } from './schemas.js';

const LoginBody = z.object({
  email: emailSchema,
  // Max length bounds hashing cost for hostile input.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});

const PreferencesBody = z.object({ preferredLanguage: languageSchema });

const INVALID_LOGIN = 'Invalid email or password, or the account is temporarily locked';

export function authRouter(db: Db, config: AppConfig): Router {
  const r = Router();

  const loginLimiter = rateLimit({
    windowMs: config.login.rateLimitWindowMinutes * 60_000,
    limit: config.login.rateLimitMax,
    // Only failed attempts count, so a whole office behind one address can still log in normally.
    // Counters are in memory: they reset on restart and assume a single API process (see SECURITY.md).
    // The per-account lockout is stored in PostgreSQL and survives restarts.
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'rate_limited', 'Too many login attempts. Try again later.')),
  });

  const setCookie = (res: Response, token: string) => {
    res.cookie(config.cookie.name, token, {
      httpOnly: true,
      secure: config.cookie.secure,
      sameSite: 'strict',
      path: '/',
      maxAge: config.session.absoluteHours * 3_600_000,
    });
  };
  const clearCookie = (res: Response) => {
    res.clearCookie(config.cookie.name, { httpOnly: true, secure: config.cookie.secure, sameSite: 'strict', path: '/' });
  };

  r.post('/login', loginLimiter, async (req, res) => {
    const body = parseBody(LoginBody, req);
    const ctx = { ...auditContext(req, res), actorUserId: null };
    const { rows } = await db.query<{
      id: string;
      password_hash: string;
      is_active: boolean;
      locked: boolean;
      failed_login_count: number;
    }>(
      `SELECT id, password_hash, is_active, (locked_until IS NOT NULL AND locked_until > now()) AS locked, failed_login_count
         FROM users WHERE email = $1`,
      [body.email],
    );
    const user = rows[0];

    if (!user) {
      await verifyPassword(body.password, await getDummyHash());
      await recordAudit(db, { ...ctx, action: 'auth.login', outcome: 'failure', metadata: { reason: 'unknown_account' } });
      throw unauthorized(INVALID_LOGIN);
    }

    const passwordOk = await verifyPassword(body.password, user.password_hash);

    if (user.locked || !user.is_active) {
      await recordAudit(db, {
        ...ctx,
        action: 'auth.login',
        outcome: 'failure',
        targetType: 'user',
        targetId: user.id,
        metadata: { reason: user.locked ? 'locked' : 'inactive' },
      });
      throw unauthorized(INVALID_LOGIN);
    }

    if (!passwordOk) {
      const { rows: upd } = await db.query<{ locked: boolean }>(
        `UPDATE users
            SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1
          RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
        [user.id, config.login.lockoutThreshold, config.login.lockoutMinutes],
      );
      await recordAudit(db, {
        ...ctx,
        action: 'auth.login',
        outcome: 'failure',
        targetType: 'user',
        targetId: user.id,
        metadata: { reason: 'bad_password', lockedNow: upd[0]?.locked ?? false },
      });
      throw unauthorized(INVALID_LOGIN);
    }

    // Prevent session fixation: drop any session the browser already had.
    if (res.locals.auth) await revokeSession(db, res.locals.auth.sessionId, 'logout');

    const session = await withTransaction(db, async (tx) => {
      const newHash = needsRehash(user.password_hash) ? await hashPassword(body.password) : null;
      await tx.query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(),
                          password_hash = COALESCE($2, password_hash)
          WHERE id = $1`,
        [user.id, newHash],
      );
      const s = await createSession(tx, user.id, config.session, req.get('user-agent'));
      await recordAudit(tx, {
        ...ctx,
        actorUserId: user.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        metadata: { sessionRef: s.sessionId.slice(0, 8) },
      });
      return s;
    });

    setCookie(res, session.token);
    const me = await loadMe(db, user.id);
    res.json({ ...me, session: { expiresAt: session.expiresAt } });
  });

  r.post('/logout', async (req, res) => {
    const auth = res.locals.auth;
    if (auth) {
      await revokeSession(db, auth.sessionId, 'logout');
      await recordAudit(db, { ...auditContext(req, res), action: 'auth.logout', targetType: 'user', targetId: auth.user.id });
    }
    clearCookie(res);
    res.status(204).end();
  });

  r.post('/logout-all', requireAuth, async (req, res) => {
    const auth = res.locals.auth!;
    const count = await revokeAllUserSessions(db, auth.user.id, 'logout_all');
    await recordAudit(db, {
      ...auditContext(req, res),
      action: 'auth.logout_all',
      targetType: 'user',
      targetId: auth.user.id,
      metadata: { revokedSessions: count },
    });
    clearCookie(res);
    res.status(204).end();
  });

  r.get('/me', requireAuth, async (_req, res) => {
    const auth = res.locals.auth!;
    const me = await loadMe(db, auth.user.id);
    res.json({ ...me, session: { expiresAt: auth.expiresAt, idleExpiresAt: auth.idleExpiresAt } });
  });

  r.patch('/me/preferences', requireAuth, async (req, res) => {
    const body = parseBody(PreferencesBody, req);
    const auth = res.locals.auth!;
    await db.query('UPDATE users SET preferred_language = $2, updated_at = now() WHERE id = $1', [
      auth.user.id,
      body.preferredLanguage,
    ]);
    res.json(await loadMe(db, auth.user.id));
  });

  r.post('/change-password', requireAuth, async (req, res) => {
    const body = parseBody(ChangePasswordBody, req);
    const auth = res.locals.auth!;
    const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [auth.user.id]);
    const ok = rows[0] ? await verifyPassword(body.currentPassword, rows[0].password_hash) : false;
    if (!ok) {
      await recordAudit(db, {
        ...auditContext(req, res),
        action: 'auth.password_change',
        outcome: 'failure',
        targetType: 'user',
        targetId: auth.user.id,
        metadata: { reason: 'bad_current_password' },
      });
      throw new AppError(400, 'invalid_current_password', 'Current password is incorrect');
    }
    const newHash = await hashPassword(body.newPassword);
    await withTransaction(db, async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [
        auth.user.id,
        newHash,
      ]);
      // Sign out every other device; keep the current session.
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [auth.user.id, auth.sessionId],
      );
      await recordAudit(tx, { ...auditContext(req, res), action: 'auth.password_change', targetType: 'user', targetId: auth.user.id });
    });
    res.status(204).end();
  });

  return r;
}

export async function loadMe(db: Db, userId: string) {
  const { rows } = await db.query<{
    id: string;
    email: string;
    full_name: string;
    role_code: string;
    preferred_language: 'fr' | 'ar';
    permissions: string[];
  }>(
    `SELECT u.id, u.email, u.full_name, u.role_code, u.preferred_language,
            COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
                     FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u LEFT JOIN role_permissions rp ON rp.role_code = u.role_code
      WHERE u.id = $1 GROUP BY u.id`,
    [userId],
  );
  const u = rows[0];
  if (!u) throw unauthorized();
  return {
    user: { id: u.id, email: u.email, fullName: u.full_name, role: u.role_code, preferredLanguage: u.preferred_language },
    permissions: u.permissions,
  };
}
