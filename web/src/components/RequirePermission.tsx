import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';

/** Hides routes the user may not use. This is UX only — the API is the security boundary. */
export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  const { t } = useI18n();
  if (!can(permission)) {
    return (
      <div className="state state-error" role="alert">
        {t('error.forbidden')}
      </div>
    );
  }
  return <>{children}</>;
}
