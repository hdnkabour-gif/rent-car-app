import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';

export type RevokeReason = 'logout' | 'logout_all' | 'user_deactivated' | 'role_changed' | 'password_changed' | 'admin';

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  preferredLanguage: 'fr' | 'ar';
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
  permissions: string[];
  /** Branches the user is assigned to. Users with branches.all may work in every branch. */
  branchIds: string[];
  expiresAt: Date;
  idleExpiresAt: Date;
}

/** Opaque 256-bit random token. Only its SHA-256 hash is stored, so a DB leak exposes no live tokens. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export async function createSession(
  db: Queryable,
  userId: string,
  policy: SessionPolicy,
  userAgent: string | undefined,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateToken();
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (user_id, token_hash, idle_expires_at, expires_at, user_agent)
     VALUES ($1, $2,
             LEAST(now() + make_interval(mins => $3), now() + make_interval(hours => $4)),
             now() + make_interval(hours => $4),
             $5)
     RETURNING id, expires_at`,
    [userId, hashToken(token), policy.idleMinutes, policy.absoluteHours, userAgent?.slice(0, 512) ?? null],
  );
  const row = rows[0]!;
  return { token, sessionId: row.id, expiresAt: row.expires_at };
}

/**
 * Looks up a live session by token. A session is valid only if it is not revoked, has not hit its
 * absolute or idle expiry, and its user is still active. Valid sessions get their idle window
 * extended (at most once a minute, to limit writes).
 */
export async function resolveSession(db: Queryable, token: string, policy: SessionPolicy): Promise<ResolvedSession | null> {
  const { rows } = await db.query<{
    session_id: string;
    expires_at: Date;
    idle_expires_at: Date;
    last_seen_at: Date;
    user_id: string;
    email: string;
    full_name: string;
    role_code: string;
    preferred_language: 'fr' | 'ar';
    permissions: string[];
    branch_ids: string[];
  }>(
    `SELECT s.id AS session_id, s.expires_at, s.idle_expires_at, s.last_seen_at,
            u.id AS user_id, u.email, u.full_name, u.role_code, u.preferred_language,
            ARRAY(SELECT p.permission_code FROM user_effective_permissions p
                   WHERE p.user_id = u.id ORDER BY 1) AS permissions,
            ARRAY(SELECT ub.branch_id::text FROM user_branches ub
                   WHERE ub.user_id = u.id ORDER BY 1) AS branch_ids
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.idle_expires_at > now()
        AND u.is_active`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  let idleExpiresAt = row.idle_expires_at;
  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    const upd = await db.query<{ idle_expires_at: Date }>(
      `UPDATE sessions
          SET last_seen_at = now(),
              idle_expires_at = LEAST(now() + make_interval(mins => $2), expires_at)
        WHERE id = $1
        RETURNING idle_expires_at`,
      [row.session_id, policy.idleMinutes],
    );
    idleExpiresAt = upd.rows[0]?.idle_expires_at ?? idleExpiresAt;
  }

  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    idleExpiresAt,
    permissions: row.permissions,
    branchIds: row.branch_ids,
    user: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role_code,
      preferredLanguage: row.preferred_language,
    },
  };
}

export async function revokeSession(db: Queryable, sessionId: string, reason: RevokeReason): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
    reason,
  ]);
}

export async function revokeAllUserSessions(db: Queryable, userId: string, reason: RevokeReason): Promise<number> {
  const res = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return res.rowCount ?? 0;
}

/** Housekeeping: delete sessions that ended more than `days` ago. */
export async function purgeOldSessions(db: Queryable, days = 30): Promise<number> {
  const res = await db.query(
    `DELETE FROM sessions
      WHERE expires_at < now() - make_interval(days => $1)
         OR revoked_at < now() - make_interval(days => $1)`,
    [days],
  );
  return res.rowCount ?? 0;
}
