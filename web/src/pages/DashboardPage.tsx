import { CalendarClock, CarFront, FileText, Repeat, UsersRound, Wallet, type LucideIcon } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';

const MODULES: Array<{ key: MessageKey; icon: LucideIcon; tone: string }> = [
  { key: 'module.vehicles', icon: CarFront, tone: 'blue' },
  { key: 'module.customers', icon: UsersRound, tone: 'teal' },
  { key: 'module.reservations', icon: CalendarClock, tone: 'violet' },
  { key: 'module.returns', icon: Repeat, tone: 'amber' },
  { key: 'module.payments', icon: Wallet, tone: 'green' },
  { key: 'module.documents', icon: FileText, tone: 'rose' },
];

function casablancaHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Casablanca' }).format(new Date()));
}

export function DashboardPage() {
  const { me } = useAuth();
  const { t, formatDateTime, formatLongDate } = useI18n();
  const firstName = me?.user.fullName.split(/\s+/)[0] ?? '';
  const greeting = casablancaHour() < 18 ? t('greeting.morning') : t('greeting.evening');

  return (
    <section>
      <div className="welcome-card">
        <h1>{t('dashboard.greeting', { greeting, name: firstName })}</h1>
        <p>{t('dashboard.today', { date: formatLongDate(new Date()) })}</p>
      </div>

      <div className="section-title">
        <h2>{t('dashboard.modulesTitle')}</h2>
        <p className="muted small">{t('dashboard.modulesHint')}</p>
      </div>
      <ul className="module-grid">
        {MODULES.map(({ key, icon: Icon, tone }) => (
          <li key={key} className="module-card" aria-disabled="true">
            <span className={`module-icon tone-${tone}`} aria-hidden="true">
              <Icon size={24} strokeWidth={1.8} />
            </span>
            <span className="module-label">{t(key)}</span>
            <span className="chip">{t('common.soon')}</span>
          </li>
        ))}
      </ul>

      {me?.session?.expiresAt && (
        <p className="muted small">{t('dashboard.session', { time: formatDateTime(me.session.expiresAt) })}</p>
      )}
    </section>
  );
}
