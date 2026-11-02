import { useAuth } from '../auth';
import { useI18n } from '../i18n';

export function DashboardPage() {
  const { me } = useAuth();
  const { t, formatDateTime } = useI18n();
  return (
    <section>
      <h1>{t('dashboard.title')}</h1>
      <p>{t('dashboard.welcome', { name: me?.user.fullName ?? '' })}</p>
      <div className="card placeholder">{t('dashboard.placeholder')}</div>
      {me?.session?.expiresAt && <p className="muted small">{t('dashboard.session', { time: formatDateTime(me.session.expiresAt) })}</p>}
    </section>
  );
}
