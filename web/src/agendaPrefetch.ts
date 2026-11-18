import { api } from './api';
import type { AgendaDay } from './agenda';

/** Short-lived, user-scoped initial agenda preload. No localStorage, cross-user data or fake progress.
 * Shared by the splash and the first dashboard render to avoid showing a second loading skeleton.
 */
const cache = new Map<string, { start: number; promise: Promise<AgendaDay> }>();
const TTL_MS = 15_000;
function key(userId: string, date: string) { return userId + ':' + date; }
export function readAgenda(userId: string, date: string, force = false): Promise<AgendaDay> {
  const k = key(userId, date);
  const now = Date.now();
  const entry = cache.get(k);
  if (!force && entry && now - entry.start < TTL_MS) return entry.promise;
  const promise = api<AgendaDay>(`/dashboard/agenda?date=${encodeURIComponent(date)}`).catch((error: unknown) => {
    if (cache.get(k)?.promise === promise) cache.delete(k);
    throw error;
  });
  cache.set(k, { start: now, promise });
  // Avoid holding data for another company/user indefinitely.
  for (const [k2, v] of cache) if (now - v.start > TTL_MS) cache.delete(k2);
  return promise;
}
export function clearAgenda(): void { cache.clear(); }
