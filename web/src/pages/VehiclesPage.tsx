import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CarFront, Plus, Search } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { Empty, ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { FuelGauge } from '../components/Fuel';
import { Plate } from '../components/Plate';
import { VEHICLE_STATUSES, formatKm, type Branch, type Vehicle, type VehicleStatus } from '../vehicles';

const FILTERS = VEHICLE_STATUSES.filter((s) => s !== 'retired');

export function VehiclesPage() {
  const { me, can } = useAuth();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(params.get('q') ?? '');
  const status = (params.get('status') ?? '') as VehicleStatus | '';
  const branchId = params.get('branch') ?? '';
  const q = params.get('q') ?? '';
  const docs = params.get('docs') === 'alert' ? 'alert' : '';

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  if (branchId) query.set('branchId', branchId);
  if (docs) query.set('docs', docs);
  const list = useApi<{ items: Vehicle[] }>(`/vehicles?${query.toString()}`);
  const summary = useApi<{ counts: Record<string, number>; total: number }>('/vehicles/summary');
  const branches = useApi<{ items: Branch[] }>('/branches');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const activeBranches = useMemo(() => (branches.data?.items ?? []).filter((b) => b.isActive), [branches.data]);
  const noBranch = me && !me.permissions.includes('branches.all') && (me.branchIds ?? []).length === 0;

  return (
    <section>
      <PageHeader
        title={t('vehicles.title')}
        subtitle={t('vehicles.subtitle')}
        actions={
          can('vehicles.manage') && (
            <Link to="/vehicles/new" className="btn btn-primary">
              <Plus size={18} aria-hidden="true" /> {t('vehicles.add')}
            </Link>
          )
        }
      />

      {noBranch && <div className="alert alert-info">{t('vehicles.noBranch')}</div>}

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
          placeholder={t('vehicles.search')}
          aria-label={t('vehicles.search')}
          onChange={(e) => {
            setTyped(e.target.value);
            if (e.target.value === '') set('q', '');
          }}
        />
      </form>

      <div className="filter-row">
        <div className="chips" role="group" aria-label={t('users.status')}>
          <button type="button" className={`chip-btn${status === '' ? ' active' : ''}`} onClick={() => set('status', '')}>
            {t('vehicles.allStatuses')} {summary.data && <span className="count">{summary.data.total}</span>}
          </button>
          {FILTERS.map((s) => (
            <button key={s} type="button" className={`chip-btn${status === s ? ' active' : ''}`} onClick={() => set('status', s)}>
              {t(`status.${s}` as MessageKey)} {summary.data && <span className="count">{summary.data.counts[s] ?? 0}</span>}
            </button>
          ))}
          <button type="button" aria-pressed={docs === 'alert'} className={`chip-btn${docs === 'alert' ? ' active' : ''}`} onClick={() => set('docs', docs ? '' : 'alert')}>
            {t('docs.filterAlert')}
          </button>
        </div>
        {activeBranches.length > 1 && (
          <select value={branchId} onChange={(e) => set('branch', e.target.value)} aria-label={t('vehicles.branch')} className="branch-select">
            <option value="">{t('vehicles.allBranches')}</option>
            {activeBranches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.items.length === 0 ? (
        <Empty messageKey="vehicles.none" />
      ) : (
        <ul className="vehicle-grid">
          {list.data.items.map((v) => (
            <li key={v.id}>
              <Link to={`/vehicles/${v.id}`} className="vehicle-card">
                <div className="vehicle-card-top">
                  <span className="vehicle-icon" aria-hidden="true">
                    <CarFront size={22} />
                  </span>
                  <div className="vehicle-names">
                    <strong>
                      {v.make} {v.model}
                    </strong>
                    <Plate value={v.plate} />
                  </div>
                  <StatusBadge status={v.status} />
                </div>
                {v.documentAlert && (
                  <span className={`badge ${v.documentAlert === 'expired' ? 'badge-failure' : 'badge-warning'} doc-alert`}>
                    {t(`docs.alert.${v.documentAlert}` as MessageKey)}
                  </span>
                )}
                <div className="vehicle-card-meta muted small">
                  <span>{t('vehicles.km', { km: formatKm(v.mileageKm) })}</span>
                  <FuelGauge eighths={v.fuelEighths} />
                  <span>{v.branch.name}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
