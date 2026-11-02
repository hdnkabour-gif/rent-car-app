import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { StatusBadge } from '../components/StatusBadge';
import { FuelGauge, FuelPicker, fuelLabel } from '../components/Fuel';
import { Plate } from '../components/Plate';
import { formatKm, type AllowedTransition, type HistoryEntry, type Vehicle, type VehicleStatus } from '../vehicles';

interface Detail {
  vehicle: Vehicle;
  allowedTransitions: AllowedTransition[];
  history: HistoryEntry[];
}

function actionLabel(from: VehicleStatus, to: VehicleStatus): MessageKey {
  if (to === 'inspection_pending' && from === 'maintenance') return 'action.inspection_pending.fromMaintenance';
  if (to === 'inspection_pending' && from === 'out_of_service') return 'action.inspection_pending.fromBlocked';
  return `action.${to}` as MessageKey;
}

export function VehicleDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { t, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<Detail>(`/vehicles/${id}`);
  const [open, setOpen] = useState<AllowedTransition | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const v = data.vehicle;

  const rows: Array<[MessageKey, string | null]> = [
    ['vehicles.branch', v.branch.name],
    ['vehicles.mileage', t('vehicles.km', { km: formatKm(v.mileageKm) })],
    ['vehicles.fuelType', t(`fuel.${v.fuelType}` as MessageKey)],
    ['vehicles.transmission', t(`gearbox.${v.transmission}` as MessageKey)],
    ['vehicles.modelYear', v.modelYear ? String(v.modelYear) : null],
    ['vehicles.version', v.version],
    ['vehicles.color', v.color],
    ['vehicles.seats', v.seats ? String(v.seats) : null],
    ['vehicles.category', v.category],
    ['vehicles.internalCode', v.internalCode],
    ['vehicles.vin', v.vin],
    ['vehicles.notes', v.notes],
  ];

  return (
    <section>
      <Link to="/vehicles" className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('vehicles.back')}
      </Link>

      <div className="vehicle-hero card">
        <div>
          <h1>
            {v.make} {v.model}
          </h1>
          <p>
            <Plate value={v.plate} large />
          </p>
        </div>
        <div className="vehicle-hero-side">
          <StatusBadge status={v.status} large />
          <span className="muted small">
            {t(`status.${v.status}.hint` as MessageKey)} · {t('vehicles.since', { time: formatDateTime(v.statusChangedAt) })}
          </span>
        </div>
        <div className="hero-stats">
          <div>
            <span className="muted small">{t('vehicles.mileage')}</span>
            <strong>{t('vehicles.km', { km: formatKm(v.mileageKm) })}</strong>
          </div>
          <div>
            <span className="muted small">{t('vehicles.fuel')}</span>
            <FuelGauge eighths={v.fuelEighths} />
          </div>
          <div>
            <span className="muted small">{t('vehicles.branch')}</span>
            <strong>{v.branch.name}</strong>
          </div>
        </div>
      </div>

      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}

      <div className="card">
        <h2>{t('vehicles.actions')}</h2>
        {data.allowedTransitions.length === 0 ? (
          <p className="muted">{t('vehicles.noActions')}</p>
        ) : (
          <div className="action-buttons">
            {data.allowedTransitions.map((a) => (
              <button
                key={a.to}
                type="button"
                className={`btn ${a.to === 'available' ? 'btn-primary' : ''} ${open?.to === a.to ? 'active' : ''}`}
                aria-expanded={open?.to === a.to}
                onClick={() => {
                  setNotice(null);
                  setOpen(open?.to === a.to ? null : a);
                }}
              >
                {t(actionLabel(v.status, a.to))}
              </button>
            ))}
          </div>
        )}
        {open && (
          <TransitionForm
            key={`${open.to}-${v.status}`}
            vehicle={v}
            action={open}
            onDone={(msg) => {
              setOpen(null);
              setNotice(msg);
              reload();
            }}
            onStale={() => {
              setOpen(null);
              setNotice(t('action.stale'));
              reload();
            }}
          />
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('vehicles.details')}</h2>
          {can('vehicles.manage') && v.status !== 'retired' && (
            <Link to={`/vehicles/${v.id}/edit`} className="btn btn-small">
              <Pencil size={16} aria-hidden="true" /> {t('vehicles.edit')}
            </Link>
          )}
        </div>
        <dl className="detail-grid">
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{t(label)}</dt>
                <dd dir={label === 'vehicles.vin' || label === 'vehicles.internalCode' ? 'ltr' : undefined}>{value}</dd>
              </div>
            ))}
        </dl>
      </div>

      <div className="card">
        <h2>{t('vehicles.history')}</h2>
        <ol className="timeline">
          {data.history.map((h) => (
            <li key={h.id}>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-body">
                <div className="timeline-title">
                  {h.from && (
                    <>
                      <StatusBadge status={h.from} />
                      <span className="arrow flip-rtl" aria-hidden="true">
                        →
                      </span>
                    </>
                  )}
                  <StatusBadge status={h.to} />
                  {!h.from && <span className="small">{t('vehicles.addedToFleet')}</span>}
                </div>
                <div className="muted small">
                  {formatDateTime(h.at)}
                  {h.by && ` · ${t('vehicles.byWho', { name: h.by })}`}
                </div>
                {(h.mileageKm !== null || h.fuelEighths !== null || h.cleaned !== null) && (
                  <div className="small">
                    {h.mileageKm !== null && <span>{t('vehicles.km', { km: formatKm(h.mileageKm) })}</span>}
                    {h.fuelEighths !== null && <span> · {t('vehicles.fuel')} {fuelLabel(h.fuelEighths, t)}</span>}
                    {h.cleaned !== null && <span> · {h.cleaned ? t('vehicles.cleanedYes') : t('vehicles.cleanedNo')}</span>}
                  </div>
                )}
                {h.reason && <div className="small">« {h.reason} »</div>}
                {h.notes && <div className="small muted">{h.notes}</div>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function TransitionForm({
  vehicle,
  action,
  onDone,
  onStale,
}: {
  vehicle: Vehicle;
  action: AllowedTransition;
  onDone: (message: string) => void;
  onStale: () => void;
}) {
  const { t } = useI18n();
  const [mileage, setMileage] = useState(String(vehicle.mileageKm));
  const [fuel, setFuel] = useState<number | null>(action.inspection ? null : vehicle.fuelEighths);
  const [cleaned, setCleaned] = useState(false);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/vehicles/${vehicle.id}/transitions`, {
        method: 'POST',
        body: {
          to: action.to,
          expectedStatus: vehicle.status,
          ...(action.inspection ? { mileageKm: Number(mileage), fuelEighths: fuel ?? undefined, cleaned } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      onDone(t('common.saved'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale_status') return onStale();
      if (err instanceof ApiError && err.code === 'mileage_decrease') {
        setError(t('action.mileageError', { km: formatKm(vehicle.mileageKm) }));
      } else {
        setError(t(errorKey(err)));
      }
    } finally {
      setBusy(false);
    }
  };

  const missing = (action.inspection && (mileage === '' || fuel === null)) || (action.reasonRequired && !reason.trim());

  return (
    <form className="transition-form" onSubmit={submit}>
      {action.inspection && (
        <>
          <label className="field">
            <span>{t('vehicles.mileage')}</span>
            <input type="number" inputMode="numeric" min={0} dir="ltr" required value={mileage} onChange={(e) => setMileage(e.target.value)} />
          </label>
          <div className="field">
            <span>{t('vehicles.fuel')}</span>
            <FuelPicker value={fuel} onChange={setFuel} />
          </div>
          <label className="check">
            <input type="checkbox" checked={cleaned} onChange={(e) => setCleaned(e.target.checked)} />
            {t('action.cleaned')}
          </label>
        </>
      )}
      {(action.reasonRequired || !action.inspection) && (
        <label className="field">
          <span>{action.reasonRequired ? t('action.reasonRequired') : t('action.reason')}</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required={action.reasonRequired} />
        </label>
      )}
      {action.inspection && (
        <label className="field">
          <span>{t('action.notes')}</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || missing}>
          {busy ? t('common.saving') : t('action.confirm')}
        </button>
      </div>
    </form>
  );
}
