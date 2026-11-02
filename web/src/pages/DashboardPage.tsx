import { CalendarClock, FileText, Repeat, UsersRound, Wallet, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useApi } from '../useApi';
import type { VehicleStatus } from '../vehicles';
import { useI18n, type MessageKey } from '../i18n';

const MODULES: Array<{ key: MessageKey; icon: LucideIcon; tone: string }> = [
  { key: 'module.customers', icon: UsersRound, tone: 'teal' },
  { key: 'module.reservations', icon: CalendarClock, tone: 'violet' },
  { key: 'module.returns', icon: Repeat, tone: 'amber' },
  { key: 'module.payments', icon: Wallet, tone: 'green' },
  { key: 'module.documents', icon: FileText, tone: 'rose' },
];

function casablancaHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Casablanca' }).format(new Date()));
}

const FLEET_ORDER: VehicleStatus[] = ['available', 'rented', 'inspection_pending', 'maintenance', 'out_of_service'];

function FleetToday() {
  const { t } = useI18n();
  const { data } = useApi<{ counts: Record<string, number>; total: number }>('/vehicles/summary');
  if (!data) return null;
  return (
    <div className="card fleet-today">
      <div className="card-head">
        <h2>{t('dashboard.fleetTitle')}</h2>
        <Link to="/vehicles" className="btn btn-small">
          {t('dashboard.seeFleet')}
        </Link>
      </div>
      {data.total === 0 ? (
        <p className="muted">{t('dashboard.fleetEmpty')}</p>
      ) : (
        <ul className="fleet-tiles">
          {FLEET_ORDER.map((s) => (
            <li key={s}>
              <Link to={`/vehicles?status=${s}`} className={`fleet-tile tile-${s}`}>
                <strong>{data.counts[s] ?? 0}</strong>
                <span>{t(`status.${s}` as MessageKey)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DashboardPage() {
  const { me, can } = useAuth();
  const { t, formatDateTime, formatLongDate } = useI18n();
  const firstName = me?.user.fullName.split(/\s+/)[0] ?? '';
  const greeting = casablancaHour() < 18 ? t('greeting.morning') : t('greeting.evening');

  return (
    <section>
      <div className="welcome-card">
        <h1>{t('dashboard.greeting', { greeting, name: firstName })}</h1>
        <p>{t('dashboard.today', { date: formatLongDate(new Date()) })}</p>
      </div>

      {can('vehicles.read') && <FleetToday />}

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
