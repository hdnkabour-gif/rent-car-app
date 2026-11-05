import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';
import { useI18n } from './i18n';

type Status = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface AuthValue {
  status: Status;
  me: Me | null;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const { setLang } = useI18n();

  const apply = useCallback(
    (m: Me | null) => {
      setMe(m);
      setStatus(m ? 'authenticated' : 'anonymous');
      if (m) setLang(m.user.preferredLanguage);
    },
    [setLang],
  );

  const fetchMe = useCallback(
    () =>
      api<Me>('/auth/me').then(apply, (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) apply(null);
        else setStatus('error');
      }),
    [apply],
  );

  const refresh = useCallback(async () => {
    setStatus('loading');
    await fetchMe();
  }, [fetchMe]);

  useEffect(() => {
    void fetchMe();
  }, [fetchMe]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      me,
      // UI convenience only. The API enforces every permission independently.
      can: (p) => Boolean(me?.permissions.includes(p)),
      login: async (email, password) => apply(await api<Me>('/auth/login', { method: 'POST', body: { email, password } })),
      logout: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        apply(null);
      },
      refresh,
    }),
    [status, me, apply, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
