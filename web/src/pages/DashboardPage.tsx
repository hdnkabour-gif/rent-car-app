import { CalendarClock, FileText, FileWarning, IdCard, Repeat, Wallet, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useApi } from '../useApi';
import type { VehicleStatus } from '../vehicles';
import { useI18n, type MessageKey } from '../i18n';

const MODULES: Array<{ key: MessageKey; icon: LucideIcon; tone: string }> = [
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
  const { data } = useApi<{ counts: Record<string, number>; total: number; documents?: { expired: number; expiring: number } }>('/vehicles/summary');
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
      {data.documents && data.documents.expired + data.documents.expiring > 0 && (
        <div className={`doc-summary ${data.documents.expired ? 'doc-summary-danger' : ''}`} role="status">
          <FileWarning size={22} aria-hidden="true" />
          <div>
            <strong>{t('dashboard.documentsTitle')}</strong>
            <div className="small">
              {data.documents.expired > 0 && <span>{`${data.documents.expired} ${t('dashboard.documentsExpired')}`}</span>}
              {data.documents.expired > 0 && data.documents.expiring > 0 && ' · '}
              {data.documents.expiring > 0 && <span>{`${data.documents.expiring} ${t('dashboard.documentsExpiring')}`}</span>}
            </div>
          </div>
          <Link to="/vehicles?docs=alert" className="btn btn-small">
            {t('dashboard.seeFleet')}
          </Link>
        </div>
      )}
    </div>
  );
}

function CustomersToday() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { data } = useApi<{ total: number; blocked: number; pendingDocuments: number }>('/customers/summary');
  if (!data) return null;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{t('dashboard.customersTitle')}</h2>
          <p className="muted small">{t('dashboard.customersCount', { n: String(data.total) })}</p>
        </div>
        <Link to="/customers" className="btn btn-small">
          {t('dashboard.seeCustomers')}
        </Link>
      </div>
      {data.pendingDocuments > 0 && (
        <Link to="/customers?filter=pending_documents" className="doc-summary" role="status">
          <IdCard size={22} aria-hidden="true" />
          <div>
            <strong>{t('dashboard.customersPending', { n: String(data.pendingDocuments) })}</strong>
            {!can('customers.verify') && <div className="small">{t('customers.docs.hint')}</div>}
          </div>
        </Link>
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
      {can('customers.read') && <CustomersToday />}

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
