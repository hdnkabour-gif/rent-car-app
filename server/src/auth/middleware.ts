import type { RequestHandler } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { forbidden, unauthorized } from '../http/errors.js';
import { recordAudit, auditContext } from '../audit/audit.js';
import { resolveSession, type ResolvedSession } from './sessions.js';

declare module 'express-serve-static-core' {
  interface Locals {
    auth?: ResolvedSession;
    requestId?: string;
  }
}

/** Attaches res.locals.auth when a valid session cookie is present. Never rejects by itself. */
export function loadSession(db: Db, config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.[config.cookie.name];
      if (typeof token === 'string' && token.length > 0 && token.length <= 128) {
        const session = await resolveSession(db, token, config.session);
        if (session) res.locals.auth = session;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (_req, res, next) => {
  if (!res.locals.auth) return next(unauthorized());
  next();
};

/**
 * Server-side authorization. Must be used on every protected route — hiding UI controls is
 * not a security boundary. Denials are written to the audit log.
 */
export function requirePermission(db: Db, permission: string): RequestHandler {
  return async (req, res, next) => {
    const auth = res.locals.auth;
    if (!auth) return next(unauthorized());
    if (auth.permissions.includes(permission)) return next();
    try {
      await recordAudit(db, {
        ...auditContext(req, res),
        action: 'authz.denied',
        outcome: 'denied',
        metadata: { permission, method: req.method, path: req.baseUrl + req.path },
      });
    } catch {
      // Never let audit failure turn a 403 into a 500.
    }
    next(forbidden());
  };
}
