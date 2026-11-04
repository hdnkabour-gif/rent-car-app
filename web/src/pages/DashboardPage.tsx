import { CalendarClock, CalendarPlus, FileText, FileWarning, IdCard, KeyRound, Undo2, UserPlus, type LucideIcon } from 'lucide-react';
import { BrandMark, useBranding } from '../branding';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useApi } from '../useApi';
import type { VehicleStatus } from '../vehicles';
import { useI18n, type MessageKey } from '../i18n';

// Every module of the first release is now live; future modules are listed here when announced.
const MODULES: Array<{ key: MessageKey; icon: LucideIcon; tone: string }> = [];

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

function ReservationsToday() {
  const { t } = useI18n();
  const { data } = useApi<{ departures: number; returns: number; upcoming: number }>('/reservations/summary');
  if (!data) return null;
  const tiles = [
    { n: data.departures, label: t('dashboard.resDepartures'), to: '/reservations?view=departures_today', tone: 'tile-rented' },
    { n: data.returns, label: t('dashboard.resReturns'), to: '/reservations?view=returns_today', tone: 'tile-inspection_pending' },
    { n: data.upcoming, label: t('dashboard.resUpcoming'), to: '/reservations', tone: 'tile-available' },
  ];
  return (
    <div className="card fleet-today">
      <div className="card-head">
        <h2>
          <CalendarClock size={20} aria-hidden="true" /> {t('dashboard.resTitle')}
        </h2>
        <Link to="/reservations/new" className="btn btn-small btn-primary">
          {t('res.add')}
        </Link>
      </div>
      <ul className="fleet-tiles">
        {tiles.map((x) => (
          <li key={x.to}>
            <Link to={x.to} className={`fleet-tile ${x.tone}`}>
              <strong>{x.n}</strong>
              <span>{x.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContractsToday() {
  const { t } = useI18n();
  const { data } = useApi<{ open: number; late: number; returnsToday: number; lateFeePending: number }>('/contracts/summary');
  if (!data) return null;
  const tiles = [
    { n: data.open, label: t('k.dashboardOpen'), to: '/contracts', tone: 'tile-rented' },
    { n: data.late, label: t('k.dashboardLate'), to: '/contracts?view=late', tone: 'tile-out_of_service' },
    { n: data.returnsToday, label: t('k.dashboardReturns'), to: '/contracts', tone: 'tile-inspection_pending' },
    ...(data.lateFeePending ? [{ n: data.lateFeePending, label: t('k.dashboardLateFee'), to: '/contracts?view=late_fee', tone: 'tile-maintenance' }] : []),
  ];
  return (
    <div className="card fleet-today">
      <div className="card-head">
        <h2>
          <FileText size={20} aria-hidden="true" /> {t('k.dashboardTitle')}
        </h2>
      </div>
      <ul className="fleet-tiles">
        {tiles.map((x) => (
          <li key={x.label}>
            <Link to={x.to} className={`fleet-tile ${x.tone}`}>
              <strong>{x.n}</strong>
              <span>{x.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Manager only: is what protects company data in place (persistent files, recent backup)? */
function DataSafety() {
  const { t, formatDateTime } = useI18n();
  const { data } = useApi<{ storage: { warning: boolean }; backup: { warning: boolean; last: { at: string; ok: boolean } | null; lastOkAt: string | null; overdueHours: number } }>('/system/status');
  if (!data || (!data.storage.warning && !data.backup.warning)) return null;
  return (
    <div className="alert alert-error data-safety" role="alert">
      <strong>{t('safety.title')}</strong>
      <ul>
        {data.storage.warning && <li>{t('safety.storage')}</li>}
        {data.backup.warning && (
          <li>
            {data.backup.last === null
              ? t('safety.noBackup')
              : !data.backup.last.ok
                ? t('safety.backupFailed', { time: formatDateTime(data.backup.last.at) })
                : t('safety.backupOld', { time: formatDateTime(data.backup.last.at), h: String(data.backup.overdueHours) })}
          </li>
        )}
      </ul>
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
  const brand = useBranding();
  const greeting = casablancaHour() < 18 ? t('greeting.morning') : t('greeting.evening');

  return (
    <section>
      <div className="welcome-card">
        <div className="welcome-top">
          <BrandMark size={56} className="welcome-mark" />
          <div className="welcome-text">
            {brand.name && <div className="welcome-company">{brand.name}</div>}
            <h1>{t('dashboard.greeting', { greeting, name: firstName })}</h1>
            <p>{t('dashboard.today', { date: formatLongDate(new Date()) })}</p>
          </div>
        </div>
        <nav className="quick-actions" aria-label={t('dashboard.quick')}>
          {can('reservations.manage') && (
            <Link to="/reservations/new" className="quick-action">
              <CalendarPlus size={22} aria-hidden="true" />
              <span>{t('res.add')}</span>
            </Link>
          )}
          {can('contracts.read') && (
            <Link to="/reservations?view=departures_today" className="quick-action">
              <KeyRound size={22} aria-hidden="true" />
              <span>{t('dashboard.quickDepartures')}</span>
            </Link>
          )}
          {can('contracts.read') && (
            <Link to="/contracts" className="quick-action">
              <Undo2 size={22} aria-hidden="true" className="flip-rtl" />
              <span>{t('dashboard.quickReturns')}</span>
            </Link>
          )}
          {can('customers.manage') && (
            <Link to="/customers/new" className="quick-action">
              <UserPlus size={22} aria-hidden="true" />
              <span>{t('customers.add')}</span>
            </Link>
          )}
        </nav>
      </div>

      {can('company_settings.update') && <DataSafety />}
      {can('reservations.read') && <ReservationsToday />}
      {can('contracts.read') && <ContractsToday />}
      {can('vehicles.read') && <FleetToday />}
      {can('customers.read') && <CustomersToday />}

      {MODULES.length > 0 && (
        <>
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
        </>
      )}

      {me?.session?.expiresAt && (
        <p className="muted small">{t('dashboard.session', { time: formatDateTime(me.session.expiresAt) })}</p>
      )}
    </section>
  );
}
