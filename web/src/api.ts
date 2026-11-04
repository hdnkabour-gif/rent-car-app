export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export interface Me {
  user: { id: string; email: string; fullName: string; role: 'manager' | 'employee'; preferredLanguage: 'fr' | 'ar' };
  permissions: string[];
  branchIds?: string[];
  session?: { expiresAt: string; idleExpiresAt?: string };
}

/**
 * Same-origin fetch wrapper. The session lives in an HttpOnly cookie (never readable by JS);
 * the custom header satisfies the API's anti-CSRF check.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fleetora',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Network error');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

/** Sends one file as the raw request body (no multipart): the server checks its real content. */
export async function uploadFile<T>(path: string, file: Blob & { name?: string }, opts: { method?: 'POST' | 'PUT'; caption?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fleetora',
        'Content-Type': file.type || 'application/octet-stream',
        ...(file.name ? { 'X-File-Name': encodeURIComponent(file.name) } : {}),
        ...(opts.caption ? { 'X-Caption': encodeURIComponent(opts.caption) } : {}),
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Network error');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? (res.status === 413 ? 'payload_too_large' : 'error'), e.message ?? res.statusText, e.details);
  }
  return data as T;
}
