import type { Request, Response } from 'express';
import type { Queryable } from '../db/pool.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  outcome?: AuditOutcome;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ipAddress?: string | null;
}

/**
 * Keys that must never be persisted in audit metadata (credentials, tokens, identity-document
 * contents, OCR values). Matching keys are dropped, not masked, so nothing leaks via length.
 */
const FORBIDDEN_KEY = /pass(word)?|secret|token|hash|cookie|session_?id|authorization|api_?key|ocr|document_?(content|data|number)|cin|passport|licen[cs]e_?number|iban|card/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) continue;
      out[k] = sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  const metadata = sanitizeMetadata(entry.metadata ?? {}) as Record<string, unknown>;
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, action, outcome, target_type, target_id, request_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.outcome ?? 'success',
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.requestId ?? null,
      entry.ipAddress ?? null,
      JSON.stringify(metadata),
    ],
  );
}

/** Request-scoped context fields every audit entry should carry. */
export function auditContext(req: Request, res: Response): Pick<AuditEntry, 'requestId' | 'ipAddress' | 'actorUserId'> {
  return {
    requestId: (res.locals.requestId as string | undefined) ?? null,
    ipAddress: req.ip ?? null,
    actorUserId: res.locals.auth?.user.id ?? null,
  };
}

/** Field-level diff of non-sensitive values for audit "changes" metadata. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: T): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}
