import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, Plus, Search } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { Empty, ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { Plate } from '../components/Plate';
import { formatMoney, type Reservation } from '../reservations';

const VIEWS = ['upcoming', 'departures_today', 'returns_today', 'past'] as const;

export const RES_BADGE: Record<Reservation['status'], string> = {
  confirmed: 'badge-info',
  in_progress: 'badge-success',
  completed: 'badge-neutral',
  cancelled: 'badge-neutral',
  no_show: 'badge-failure',
};

export function ReservationCard({ r, showCustomer = true, showVehicle = true }: { r: Reservation; showCustomer?: boolean; showVehicle?: boolean }) {
  const { t, lang, formatDateTime } = useI18n();
  return (
    <Link to={`/reservations/${r.id}`} className="vehicle-card">
      <div className="vehicle-card-top">
        <span className="vehicle-icon" aria-hidden="true">
          <CalendarDays size={22} />
        </span>
        <div className="vehicle-names">
          <strong>
            <bdi dir="ltr">{r.reference}</bdi>
            {showCustomer && ` · ${r.customer.fullName}`}
          </strong>
          {showVehicle && (
            <span className="small">
              {r.vehicle.make} {r.vehicle.model} <Plate value={r.vehicle.plate} />
            </span>
          )}
        </div>
        <span className={`badge ${RES_BADGE[r.status]}`}>{t(`res.status.${r.status}` as MessageKey)}</span>
      </div>
      <div className="vehicle-card-meta muted small">
        <span>
          {formatDateTime(r.startAt)} → {formatDateTime(r.endAt)}
        </span>
        <span>{t('res.days', { n: String(r.days) })}</span>
        <strong>{formatMoney(r.totalCents, lang)}</strong>
        <span>{t(`res.place.${r.pickupPlace}` as MessageKey)}</span>
      </div>
    </Link>
  );
}

/** Reservations of a customer or a vehicle, shown on their card (BR-03: the full story in one place). */
export function ReservationList({ query, emptyKey = 'res.none', ...card }: { query: string; emptyKey?: MessageKey; showCustomer?: boolean; showVehicle?: boolean }) {
  const { data, error, reload } = useApi<{ items: Reservation[] }>(`/reservations?${query}`);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.items.length) return <Empty messageKey={emptyKey} />;
  return (
    <ul className="vehicle-grid">
      {data.items.map((r) => (
        <li key={r.id}>
          <ReservationCard r={r} {...card} />
        </li>
      ))}
    </ul>
  );
}

export function ReservationsPage() {
  const { can } = useAuth();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(params.get('q') ?? '');
  const view = (VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as (typeof VIEWS)[number]) : 'upcoming';
  const q = params.get('q') ?? '';
  const query = new URLSearchParams({ view: q ? 'all' : view });
  if (q) query.set('q', q);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <section>
      <PageHeader
        title={t('res.title')}
        subtitle={t('res.subtitle')}
        actions={
          can('reservations.manage') && (
            <Link to="/reservations/new" className="btn btn-primary">
              <Plus size={18} aria-hidden="true" /> {t('res.add')}
            </Link>
          )
        }
      />
      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', typed.trim());
        }}
      >
        <Search size={20} aria-hidden="true" />
        <input
          type="search"
          value={typed}
          placeholder={t('res.search')}
          aria-label={t('res.search')}
          onChange={(e) => {
            setTyped(e.target.value);
            if (e.target.value === '') set('q', '');
          }}
        />
      </form>
      {!q && (
        <div className="filter-row">
          <div className="chips" role="group" aria-label={t('res.title')}>
            {VIEWS.map((v) => (
              <button key={v} type="button" aria-pressed={view === v} className={`chip-btn${view === v ? ' active' : ''}`} onClick={() => set('view', v === 'upcoming' ? '' : v)}>
                {t(`res.view.${v}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
      )}
      <ReservationList query={query.toString()} />
    </section>
  );
}
