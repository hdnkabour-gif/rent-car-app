import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from './States';
import { Plate } from './Plate';
import { formatKm } from '../vehicles';
import { formatMoney, parseMoney } from '../reservations';

export const MT_ITEMS = ['oil_change', 'oil_filter', 'air_filter', 'fuel_filter', 'tyres', 'brakes', 'timing_belt', 'battery', 'air_conditioning', 'general_service', 'other'] as const;
type Item = (typeof MT_ITEMS)[number];

export interface Plan {
  id: string;
  item: Item;
  label: string | null;
  intervalKm: number | null;
  intervalMonths: number | null;
  lastDoneKm: number | null;
  lastDoneOn: string | null;
  nextKm: number | null;
  nextOn: string | null;
  kmLeft: number | null;
  daysLeft: number | null;
  status: 'due' | 'soon' | 'ok' | 'unknown';
  vehicle: { id: string; plate: string; make: string; model: string; mileageKm: number };
}
interface MtRecord {
  id: string;
  item: Item;
  label: string | null;
  doneOn: string;
  km: number;
  garage: string | null;
  costCents: number | null;
  expenseId: string | null;
  notes: string | null;
  by: string | null;
}

const BADGE: Record<Plan['status'], string> = { due: 'badge-failure', soon: 'badge-warning', ok: 'badge-success', unknown: 'badge-neutral' };

export function PlanLine({ p, showVehicle = false }: { p: Plan; showVehicle?: boolean }) {
  const { t, formatDate } = useI18n();
  const name = p.item === 'other' && p.label ? p.label : t(`mt.item.${p.item}` as MessageKey);
  const parts: string[] = [];
  if (p.kmLeft !== null) parts.push(p.kmLeft >= 0 ? t('mt.kmLeft', { km: formatKm(p.kmLeft) }) : t('mt.kmOver', { km: formatKm(-p.kmLeft) }));
  if (p.daysLeft !== null) parts.push(p.daysLeft >= 0 ? t('mt.daysLeft', { n: String(p.daysLeft) }) : t('mt.daysOver', { n: String(-p.daysLeft) }));
  return (
    <div className={`doc-item mt-${p.status}`}>
      <span className="doc-icon" aria-hidden="true">
        <Wrench size={20} />
      </span>
      <div className="doc-body">
        <div className="doc-head">
          <strong>{name}</strong>
          <span className={`badge ${BADGE[p.status]}`}>{t(`mt.status.${p.status}` as MessageKey)}</span>
          {showVehicle && (
            <Link to={`/vehicles/${p.vehicle.id}`} className="small">
              {p.vehicle.make} {p.vehicle.model} <Plate value={p.vehicle.plate} />
            </Link>
          )}
        </div>
        <div className="small">{parts.join(' · ')}</div>
        <div className="muted small">
          {[p.intervalKm && `${t('mt.intervalKm')} ${formatKm(p.intervalKm)}`, p.intervalMonths && `${t('mt.intervalMonths')} ${p.intervalMonths}`, p.nextKm !== null && `→ ${formatKm(p.nextKm)} km`, p.nextOn && `→ ${formatDate(p.nextOn)}`]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </div>
  );
}

/** List of everything due or soon, across the fleet the user can see. */
export function MaintenanceDueList() {
  const { t } = useI18n();
  const { data, error, reload } = useApi<{ items: Plan[] }>('/maintenance/due');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.items.length) return <p className="muted">{t('mt.none')}</p>;
  return (
    <ul className="doc-list">
      {data.items.map((p) => (
        <li key={p.id}>
          <PlanLine p={p} showVehicle />
        </li>
      ))}
    </ul>
  );
}

/** Vehicle page section: plans, record work done by the garage, history. */
export function VehicleMaintenance({ vehicleId, mileageKm, readOnly, onChanged }: { vehicleId: string; mileageKm: number; readOnly: boolean; onChanged?: () => void }) {
  const { can } = useAuth();
  const { t, lang, formatDate } = useI18n();
  const { data, error, reload } = useApi<{ plans: Plan[]; records: MtRecord[] }>(`/maintenance/vehicles/${vehicleId}`);
  const [panel, setPanel] = useState<'plan' | 'record' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manage = can('vehicles.maintenance') && !readOnly;
  const done = () => {
    setPanel(null);
    setNotice(t('mt.saved'));
    reload();
    onChanged?.();
  };
  return (
    <div className="card" id="maintenance">
      <div className="card-head">
        <h2>{t('mt.plans')}</h2>
        {manage && !panel && (
          <div className="doc-actions">
            <button type="button" className="btn btn-small" onClick={() => setPanel('plan')}>
              {t('mt.addPlan')}
            </button>
            <button type="button" className="btn btn-small btn-primary" onClick={() => setPanel('record')}>
              {t('mt.record')}
            </button>
          </div>
        )}
      </div>
      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}
      {panel === 'plan' && <PlanForm vehicleId={vehicleId} mileageKm={mileageKm} onClose={() => setPanel(null)} onDone={done} />}
      {panel === 'record' && data && <RecordForm vehicleId={vehicleId} mileageKm={mileageKm} plans={data.plans} onClose={() => setPanel(null)} onDone={done} />}
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {data.plans.length === 0 ? (
            <p className="muted">{t('mt.none')}</p>
          ) : (
            <ul className="doc-list">
              {data.plans.map((p) => (
                <li key={p.id}>
                  <PlanLine p={p} />
                </li>
              ))}
            </ul>
          )}
          {data.records.length > 0 && (
            <div className="detail-section">
              <h3>{t('mt.history')}</h3>
              <ul className="plain-list">
                {data.records.map((r) => (
                  <li key={r.id}>
                    <strong>{r.item === 'other' && r.label ? r.label : t(`mt.item.${r.item}` as MessageKey)}</strong> · {formatDate(r.doneOn)} · {t('vehicles.km', { km: formatKm(r.km) })}
                    {r.garage && ` · ${r.garage}`}
                    {r.costCents !== null && ` · ${formatMoney(r.costCents, lang)}`}
                    {r.by && <span className="muted small"> · {r.by}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PlanForm({ vehicleId, mileageKm, onClose, onDone }: { vehicleId: string; mileageKm: number; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [item, setItem] = useState<Item>('oil_change');
  const [label, setLabel] = useState('');
  const [km, setKm] = useState('10000');
  const [months, setMonths] = useState('');
  const [lastKm, setLastKm] = useState(String(mileageKm));
  const [lastOn, setLastOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/maintenance/vehicles/${vehicleId}/plans`, {
        method: 'POST',
        body: { item, label: label || null, intervalKm: km ? Number(km) : null, intervalMonths: months ? Number(months) : null, lastDoneKm: lastKm ? Number(lastKm) : null, lastDoneOn: lastOn || null },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'plan_exists' ? t('mt.plan_exists') : t(errorKey(err)));
    }
  };
  return (
    <form className="transition-form" onSubmit={(e) => void submit(e)} aria-label={t('mt.addPlan')}>
      <div className="grid">
        <label className="field">
          <span>{t('mt.item')}</span>
          <select value={item} onChange={(e) => setItem(e.target.value as Item)}>
            {MT_ITEMS.map((i) => (
              <option key={i} value={i}>
                {t(`mt.item.${i}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {item === 'other' && (
          <label className="field">
            <span>{t('mt.label')}</span>
            <input required value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>{t('mt.intervalKm')}</span>
          <input type="number" inputMode="numeric" dir="ltr" min={100} value={km} onChange={(e) => setKm(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.intervalMonths')}</span>
          <input type="number" inputMode="numeric" dir="ltr" min={1} max={120} value={months} onChange={(e) => setMonths(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.lastKm')}</span>
          <input type="number" inputMode="numeric" dir="ltr" min={0} value={lastKm} onChange={(e) => setLastKm(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.lastOn')}</span>
          <input type="date" dir="ltr" value={lastOn} onChange={(e) => setLastOn(e.target.value)} />
        </label>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!km && !months}>
          {t('k.save')}
        </button>
      </div>
    </form>
  );
}

function RecordForm({ vehicleId, mileageKm, plans, onClose, onDone }: { vehicleId: string; mileageKm: number; plans: Plan[]; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [item, setItem] = useState<Item>(plans[0]?.item ?? 'oil_change');
  const [doneOn, setDoneOn] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date()));
  const [km, setKm] = useState(String(mileageKm));
  const [garage, setGarage] = useState('');
  const [cost, setCost] = useState('');
  const [paidWith, setPaidWith] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoney(cost);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/maintenance/vehicles/${vehicleId}/records`, {
        method: 'POST',
        body: { planId: planId || null, item, doneOn, km: Number(km), garage: garage || null, costCents: cents, paidWith: paidWith || null, notes: notes || null },
      });
      onDone();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };
  return (
    <form className="transition-form" onSubmit={(e) => void submit(e)} aria-label={t('mt.record')}>
      <div className="grid">
        <label className="field">
          <span>{t('mt.item')}</span>
          <select
            value={planId || `item:${item}`}
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith('item:')) {
                setPlanId('');
                setItem(v.slice(5) as Item);
              } else {
                setPlanId(v);
                setItem(plans.find((p) => p.id === v)!.item);
              }
            }}
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.item === 'other' && p.label ? p.label : t(`mt.item.${p.item}` as MessageKey)}
              </option>
            ))}
            {MT_ITEMS.filter((i) => !plans.some((p) => p.item === i)).map((i) => (
              <option key={i} value={`item:${i}`}>
                {t(`mt.item.${i}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('mt.doneOn')}</span>
          <input type="date" dir="ltr" required value={doneOn} onChange={(e) => setDoneOn(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.km')}</span>
          <input type="number" inputMode="numeric" dir="ltr" min={0} required value={km} onChange={(e) => setKm(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.garage')}</span>
          <input value={garage} maxLength={120} onChange={(e) => setGarage(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.cost')}</span>
          <input inputMode="decimal" dir="ltr" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('mt.paidWith')}</span>
          <select value={paidWith} onChange={(e) => setPaidWith(e.target.value)}>
            <option value="">{t('mt.notPaid')}</option>
            {(['cash', 'transfer', 'cheque', 'card'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`k.method.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-wide">
          <span>{t('exp.notes')}</span>
          <input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!km || Number.isNaN(cents) || (Boolean(paidWith) && !cents)}>
          {t('k.save')}
        </button>
      </div>
    </form>
  );
}
