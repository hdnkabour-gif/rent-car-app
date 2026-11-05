import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/**
 * Loads a GET resource, cancelling stale requests. State is only set from async callbacks,
 * and `reload` is meant for event handlers (retry buttons, after a mutation).
 */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal }).then(
      (res) => {
        setData(res);
        setError(null);
      },
      (err: unknown) => {
        if ((err as Error)?.name !== 'AbortError') setError(err);
      },
    );
    return () => controller.abort();
  }, [path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload, setData };
}
