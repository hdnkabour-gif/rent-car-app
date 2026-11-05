import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarClock, Car, FileWarning, Gauge, KeyRound, Wrench } from 'lucide-react';
import { useApi } from '../useApi';
import { useI18n, type MessageKey } from '../i18n';
import { formatKm, type VehicleStatus } from '../vehicles';
import { StatusBadge } from './StatusBadge';
import { Plate } from './Plate';
import { FuelGauge } from './Fuel';

export interface OverviewVehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  status: VehicleStatus;
  mileageKm: number;
  fuelEighths: number | null;
  branch: { id: string; name: string };
  contract: { id: string; number: number; outAt: string; plannedEndAt: string; late: boolean; customer: string | null; phone: string | null } | null;
  nextReservation: { id: string; number: number; startAt: string; endAt: string; customer: string | null } | null;
  documents: { alert: 'expired' | 'expiring'; nextType: string | null; nextExpiry: string | null } | null;
  maintenance: { status: 'due' | 'soon'; due: number; soon: number; next: { item: string; label: string | null; kmLeft: number | null; daysLeft: number | null } | null } | null;
  needsAttention: boolean;
}
interface Overview {
  counts: Record<string, number>;
  total: number;
  attention: number;
  late: number;
  items: OverviewVehicle[];
}

const STATUSES: VehicleStatus[] = ['rented', 'available', 'inspection_pending', 'maintenance', 'out_of_service'];
const FIRST = 6;
type Filter = 'all' | 'attention' | VehicleStatus;

/**
 * Home screen, vehicle first: one card per vehicle saying in words where it is, until when,
 * what comes next and what needs doing. Problems (late, expired document, maintenance due) come first.
 */
export function FleetOverview() {
  const { t } = useI18n();
  const { data } = useApi<Overview>('/fleet/overview');
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);
  const list = useMemo(
    () => (data?.items ?? []).filter((v) => filter === 'all' || (filter === 'attention' ? v.needsAttention : v.status === filter)),
    [data, filter],
  );
  if (!data) return null;
  const branches = new Set(data.items.map((v) => v.branch.id)).size;
  const shown = showAll ? list : list.slice(0, FIRST);
  const chips: Array<{ key: Filter; label: string; n: number }> = [
    { key: 'all', label: t('fo.all'), n: data.total },
    ...(data.attention ? [{ key: 'attention' as Filter, label: t('fo.attention'), n: data.attention }] : []),
    ...STATUSES.filter((s) => data.counts[s]).map((s) => ({ key: s as Filter, label: t(`status.${s}` as MessageKey), n: data.counts[s]! })),
  ];

  return (
    <section className="card fleet-overview" aria-labelledby="fo-title">
      <div className="card-head">
        <div>
          <h2 id="fo-title">
            <Car size={20} aria-hidden="true" /> {t('fo.title')}
          </h2>
          <p className="muted small">{t('fo.hint')}</p>
        </div>
        <Link to="/vehicles" className="btn btn-small">
          {t('dashboard.seeFleet')}
        </Link>
      </div>
      {data.total === 0 ? (
        <p className="muted">{t('dashboard.fleetEmpty')}</p>
      ) : (
        <>
          <div className="chips" role="group" aria-label={t('fo.filter')}>
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`chip-btn${filter === c.key ? ' active' : ''}${c.key === 'attention' ? ' chip-attention' : ''}`}
                aria-pressed={filter === c.key}
                onClick={() => {
                  setFilter(c.key);
                  setShowAll(false);
                }}
              >
                {c.label} <span className="count">{c.n}</span>
              </button>
            ))}
          </div>
          {list.length === 0 ? (
            <p className="muted">{t('fo.none')}</p>
          ) : (
            <ul className="fo-grid">
              {shown.map((v) => (
                <li key={v.id}>
                  <VehicleNow v={v} showBranch={branches > 1} />
                </li>
              ))}
            </ul>
          )}
          {list.length > FIRST && (
            <button type="button" className="btn btn-small fo-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('fo.showLess') : t('fo.showAll', { n: String(list.length) })}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function VehicleNow({ v, showBranch }: { v: OverviewVehicle; showBranch: boolean }) {
  const { t, formatDateTime, formatDate } = useI18n();
  const docName = v.documents?.nextType ? t(`docs.type.${v.documents.nextType}` as MessageKey) : t('docs.title');
  const mtName = v.maintenance?.next ? v.maintenance.next.label ?? t(`mt.item.${v.maintenance.next.item}` as MessageKey) : '';
  return (
    <article className={`fo-card${v.needsAttention ? ' fo-card-alert' : ''}`} aria-label={`${v.make} ${v.model} ${v.plate}`}>
      <Link to={`/vehicles/${v.id}`} className="fo-head">
        <div>
          <strong>{`${v.make} ${v.model}`}</strong>
          <Plate value={v.plate} />
        </div>
        <StatusBadge status={v.status} />
      </Link>

      {v.contract ? (
        <Link to={`/contracts/${v.contract.id}`} className={`fo-line${v.contract.late ? ' fo-bad' : ''}`}>
          <KeyRound size={16} aria-hidden="true" />
          <span>
            {v.contract.customer ? t('fo.with', { name: v.contract.customer }) : `C-${String(v.contract.number).padStart(5, '0')}`}
            {' · '}
            {t('fo.returnAt', { time: formatDateTime(v.contract.plannedEndAt) })}
            {v.contract.late && <span className="badge badge-failure fo-badge">{t('fo.late')}</span>}
          </span>
        </Link>
      ) : null}

      {v.nextReservation ? (
        <Link to={`/reservations/${v.nextReservation.id}`} className="fo-line">
          <CalendarClock size={16} aria-hidden="true" />
          <span>
            {t('fo.next', { time: formatDateTime(v.nextReservation.startAt) })}
            {v.nextReservation.customer && ` · ${v.nextReservation.customer}`}
          </span>
        </Link>
      ) : (
        !v.contract && (
          <div className="fo-line muted">
            <CalendarClock size={16} aria-hidden="true" />
            <span>{t('fo.free')}</span>
          </div>
        )
      )}

      {v.documents && (
        <Link to={`/vehicles/${v.id}`} className={`fo-line ${v.documents.alert === 'expired' ? 'fo-bad' : 'fo-warn'}`}>
          <FileWarning size={16} aria-hidden="true" />
          <span>
            {v.documents.nextExpiry
              ? t(v.documents.alert === 'expired' ? 'fo.docExpired' : 'fo.docExpiring', { doc: docName, date: formatDate(v.documents.nextExpiry) })
              : docName}
          </span>
        </Link>
      )}

      {v.maintenance && (
        <Link to="/maintenance" className={`fo-line ${v.maintenance.status === 'due' ? 'fo-bad' : 'fo-warn'}`}>
          <Wrench size={16} aria-hidden="true" />
          <span>
            {t(v.maintenance.status === 'due' ? 'fo.mtDue' : 'fo.mtSoon', { item: mtName })}
            {v.maintenance.next?.kmLeft != null && v.maintenance.next.kmLeft > 0 && ` · ${t('vehicles.km', { km: formatKm(v.maintenance.next.kmLeft) })}`}
          </span>
        </Link>
      )}

      {v.status === 'out_of_service' && (
        <div className="fo-line fo-bad">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{t('status.out_of_service.hint')}</span>
        </div>
      )}

      <div className="fo-foot small muted">
        <span>
          <Gauge size={14} aria-hidden="true" /> {t('vehicles.km', { km: formatKm(v.mileageKm) })}
        </span>
        <FuelGauge eighths={v.fuelEighths} />
        {showBranch && <span>{v.branch.name}</span>}
      </div>
    </article>
  );
}
