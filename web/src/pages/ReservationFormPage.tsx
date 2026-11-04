import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Search, TriangleAlert, UserPlus } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { Plate } from '../components/Plate';
import type { Customer } from '../customers';
import type { Branch } from '../vehicles';
import {
  PLACES,
  addDaysLocal,
  centsToInput,
  formatMoney,
  localInput,
  parseMoney,
  type AvailableVehicle,
  type Place,
  type Quote,
  type Reservation,
} from '../reservations';

interface FormState {
  start: string;
  end: string;
  customer: Pick<Customer, 'id' | 'fullName' | 'phone'> & { blocked: boolean } | null;
  vehicleId: string;
  pickupPlace: Place;
  pickupDetails: string;
  returnPlace: Place;
  returnDetails: string;
  returnBranchId: string;
  daily: string;
  priceReason: string;
  deposit: string;
  notes: string;
}

export function ReservationFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const existing = useApi<{ reservation: Reservation }>(id ? `/reservations/${id}` : null);
  const presetCustomer = useApi<{ customer: Customer }>(!id && params.get('customerId') ? `/customers/${params.get('customerId')}` : null);
  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;
  if (id && !existing.data) return <Loading />;
  if (!id && params.get('customerId') && !presetCustomer.data && !presetCustomer.error) return <Loading />;

  const r = existing.data?.reservation;
  const c = presetCustomer.data?.customer;
  const initial: FormState = r
    ? {
        start: r.startLocal,
        end: r.endLocal,
        customer: { id: r.customer.id, fullName: r.customer.fullName, phone: r.customer.phone, blocked: r.customer.blocked },
        vehicleId: r.vehicle.id,
        pickupPlace: r.pickupPlace,
        pickupDetails: r.pickupDetails ?? '',
        returnPlace: r.returnPlace,
        returnDetails: r.returnDetails ?? '',
        returnBranchId: r.returnBranch.id,
        daily: r.dailyCents !== r.listDailyCents ? centsToInput(r.dailyCents) : '',
        priceReason: r.priceReason ?? '',
        deposit: centsToInput(r.depositCents),
        notes: r.notes ?? '',
      }
    : {
        start: localInput(0, 10),
        end: localInput(3, 10),
        customer: c ? { id: c.id, fullName: c.fullName, phone: c.phone, blocked: Boolean(c.blocked) } : null,
        vehicleId: params.get('vehicleId') ?? '',
        pickupPlace: 'agency',
        pickupDetails: '',
        returnPlace: 'agency',
        returnDetails: '',
        returnBranchId: '',
        daily: '',
        priceReason: '',
        deposit: '',
        notes: '',
      };
  return <ReservationForm id={id} initial={initial} />;
}

function ReservationForm({ id, initial }: { id?: string; initial: FormState }) {
  const { can } = useAuth();
  const { t, lang, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const [f, setF] = useState<FormState>(initial);
  const [search, setSearch] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));

  const datesOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.start) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.end) && f.end > f.start;
  const customers = useApi<{ items: Customer[] }>(!f.customer && search.trim().length >= 2 ? `/customers?q=${encodeURIComponent(search.trim())}` : null);
  const availability = useApi<{ items: AvailableVehicle[] }>(
    datesOk ? `/reservations/availability?start=${f.start}&end=${f.end}${id ? `&excludeReservationId=${id}` : ''}` : null,
  );
  const branches = useApi<{ items: Branch[] }>('/branches');
  const vehicle = availability.data?.items.find((v) => v.id === f.vehicleId) ?? null;
  const canPrice = can('pricing.change') || (vehicle !== null && vehicle.dailyRateCents === null);

  const dailyCents = parseMoney(f.daily);
  const depositCents = parseMoney(f.deposit);
  const moneyBad = Number.isNaN(dailyCents) || Number.isNaN(depositCents);

  const body = useMemo(
    () =>
      f.customer && f.vehicleId && datesOk && !moneyBad
        ? {
            customerId: f.customer.id,
            vehicleId: f.vehicleId,
            start: f.start,
            end: f.end,
            pickupPlace: f.pickupPlace,
            pickupDetails: f.pickupDetails || null,
            returnPlace: f.returnPlace,
            returnDetails: f.returnDetails || null,
            returnBranchId: f.returnBranchId || null,
            ...(dailyCents !== null ? { dailyCents } : {}),
            priceReason: f.priceReason || null,
            ...(depositCents !== null ? { depositCents } : {}),
            notes: f.notes || null,
          }
        : null,
    [f, datesOk, moneyBad, dailyCents, depositCents],
  );

  // Live preview (days, price, warnings, conflicts). State is only set from the async result.
  useEffect(() => {
    if (!body) return;
    const timer = setTimeout(() => {
      api<Quote>(`/reservations/quote${id ? `?excludeReservationId=${id}` : ''}`, { method: 'POST', body }).then(
        (q) => {
          setQuote(q);
          setQuoteError(null);
        },
        (err: unknown) => {
          setQuote(null);
          setQuoteError(err instanceof ApiError && err.code === 'customer_blocked' ? t('res.error.customer_blocked') : t(errorKey(err)));
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [body, id, t]);

  const shownQuote = body ? quote : null;
  const priceDiffers = shownQuote?.priceChanged ?? false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<{ reservation: Reservation }>(id ? `/reservations/${id}` : '/reservations', { method: id ? 'PUT' : 'POST', body });
      navigate(`/reservations/${saved.reservation.id}`, { replace: true, state: { notice: t('res.saved') } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'vehicle_unavailable') setError(t('res.unavailable'));
      else if (err instanceof ApiError && err.code === 'customer_blocked') setError(t('res.error.customer_blocked'));
      else if (err instanceof ApiError && err.status === 403) setError(t('res.error.priceForbidden'));
      else if (err instanceof ApiError && Array.isArray(err.details) && err.details.some((d) => d.path === 'priceReason')) setError(t('res.error.priceReason'));
      else setError(t(errorKey(err)));
      availability.reload();
    } finally {
      setBusy(false);
    }
  };

  const placeFields = (which: 'pickup' | 'return') => {
    const placeKey = which === 'pickup' ? 'pickupPlace' : 'returnPlace';
    const detailKey = which === 'pickup' ? 'pickupDetails' : 'returnDetails';
    return (
      <>
        <div className="field">
          <span>{t(which === 'pickup' ? 'res.pickupPlace' : 'res.returnPlace')}</span>
          <div className="segmented segmented-wide segmented-wrap" role="group" aria-label={t(which === 'pickup' ? 'res.pickupPlace' : 'res.returnPlace')}>
            {PLACES.map((p) => (
              <button key={p} type="button" aria-pressed={f[placeKey] === p} className={f[placeKey] === p ? 'active' : ''} onClick={() => set(placeKey, p)}>
                {t(`res.place.${p}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
        {f[placeKey] !== 'agency' && (
          <label className="field">
            <span>{t('res.placeDetails')}</span>
            <input value={f[detailKey]} maxLength={200} onChange={(e) => set(detailKey, e.target.value)} />
          </label>
        )}
      </>
    );
  };

  return (
    <section>
      <Link to={id ? `/reservations/${id}` : '/reservations'} className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('res.back')}
      </Link>
      <PageHeader title={id ? t('res.edit') : t('res.add')} />
      <form onSubmit={(e) => void submit(e)} noValidate>
        <fieldset className="card form-section">
          <legend>{t('res.step.dates')}</legend>
          <div className="grid">
            <label className="field">
              <span>{t('res.start')}</span>
              <input type="datetime-local" dir="ltr" required value={f.start} onChange={(e) => set('start', e.target.value)} />
            </label>
            <label className="field">
              <span>{t('res.end')}</span>
              <input type="datetime-local" dir="ltr" required value={f.end} aria-invalid={!datesOk || undefined} onChange={(e) => set('end', e.target.value)} />
            </label>
          </div>
          <div className="chips" role="group" aria-label={t('res.quickDays')}>
            {[1, 2, 3, 7, 14, 30].map((n) => (
              <button key={n} type="button" className="chip-btn" onClick={() => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.start) && set('end', addDaysLocal(f.start, n))}>
                {t('res.nDays', { n: String(n) })}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('res.step.customer')}</legend>
          {f.customer ? (
            <div className="picked">
              <Check size={18} aria-hidden="true" />
              <strong>{f.customer.fullName}</strong> <bdi dir="ltr">{f.customer.phone}</bdi>
              {!id && (
                <button type="button" className="btn btn-small" onClick={() => set('customer', null)}>
                  {t('res.customerChange')}
                </button>
              )}
              {f.customer.blocked && <div className="alert alert-error">{t('res.customerBlocked')}</div>}
            </div>
          ) : (
            <>
              <div className="search-bar">
                <Search size={20} aria-hidden="true" />
                <input type="search" value={search} placeholder={t('res.customerSearch')} aria-label={t('res.customerSearch')} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {customers.data && (
                <ul className="pick-list">
                  {customers.data.items.slice(0, 8).map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => set('customer', { id: c.id, fullName: c.fullName, phone: c.phone, blocked: Boolean(c.blocked) })}>
                        <strong>{c.fullName}</strong> <bdi dir="ltr">{c.phone}</bdi>
                        {c.blocked && <span className="badge badge-failure">{t('customers.blocked')}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {can('customers.manage') && (
                <Link to="/customers/new" className="btn btn-small" target="_blank" rel="noopener">
                  <UserPlus size={16} aria-hidden="true" /> {t('res.customerNew')}
                </Link>
              )}
            </>
          )}
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('res.step.vehicle')}</legend>
          {!datesOk ? (
            <p className="muted">{t('res.pickDatesFirst')}</p>
          ) : availability.error ? (
            <ErrorState error={availability.error} onRetry={availability.reload} />
          ) : !availability.data ? (
            <Loading />
          ) : (
            <ul className="pick-list vehicle-pick" role="radiogroup" aria-label={t('res.step.vehicle')}>
              {availability.data.items.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={f.vehicleId === v.id}
                    disabled={!v.available}
                    className={f.vehicleId === v.id ? 'active' : ''}
                    onClick={() => set('vehicleId', v.id)}
                  >
                    <span>
                      <strong>
                        {v.make} {v.model}
                      </strong>{' '}
                      <Plate value={v.plate} />
                    </span>
                    <span className="small muted">
                      {v.branch.name} · {t(`gearbox.${v.transmission}` as MessageKey)} ·{' '}
                      {v.dailyRateCents !== null ? t('res.perDay', { price: formatMoney(v.dailyRateCents, lang) }) : t('res.noPrice')}
                    </span>
                    <span className={`badge ${v.available ? 'badge-success' : 'badge-neutral'}`}>
                      {v.available ? t('res.vehicleFree') : t('res.vehicleTaken', { ref: v.conflictReference ?? '' })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('res.step.places')}</legend>
          <div className="grid">
            {placeFields('pickup')}
            {placeFields('return')}
            {branches.data && branches.data.items.filter((b) => b.isActive).length > 1 && (
              <label className="field">
                <span>{t('res.returnBranch')}</span>
                <select value={f.returnBranchId} onChange={(e) => set('returnBranchId', e.target.value)}>
                  <option value="">{vehicle ? vehicle.branch.name : '—'}</option>
                  {branches.data.items
                    .filter((b) => b.isActive && b.id !== vehicle?.branch.id)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('res.step.price')}</legend>
          <div className="grid">
            {vehicle?.dailyRateCents !== null && vehicle !== null && (
              <div className="field">
                <span>{t('res.listPrice')}</span>
                <strong>{t('res.perDay', { price: formatMoney(vehicle.dailyRateCents, lang) })}</strong>
              </div>
            )}
            {canPrice ? (
              <label className="field">
                <span>{t('res.agreedPrice')}</span>
                <input inputMode="decimal" dir="ltr" value={f.daily} placeholder={centsToInput(vehicle?.dailyRateCents)} aria-invalid={Number.isNaN(dailyCents) || undefined} onChange={(e) => set('daily', e.target.value)} />
                {Number.isNaN(dailyCents) && <small className="field-error">{t('error.moneyInvalid')}</small>}
              </label>
            ) : (
              <p className="muted small">{t('res.priceLocked')}</p>
            )}
            {priceDiffers && (
              <label className="field">
                <span>{t('res.priceReason')}</span>
                <input required value={f.priceReason} maxLength={500} onChange={(e) => set('priceReason', e.target.value)} />
              </label>
            )}
            <label className="field">
              <span>{t('res.deposit')}</span>
              <input inputMode="decimal" dir="ltr" value={f.deposit} placeholder={centsToInput(vehicle?.depositCents)} aria-invalid={Number.isNaN(depositCents) || undefined} onChange={(e) => set('deposit', e.target.value)} />
              <small className="hint">{t('res.depositHint')}</small>
              {Number.isNaN(depositCents) && <small className="field-error">{t('error.moneyInvalid')}</small>}
            </label>
          </div>
          {shownQuote && (
            <div className="quote-box" role="status">
              <div className="quote-line">
                <span>{t('res.days', { n: String(shownQuote.days) })}</span>
                <span dir="ltr">
                  {shownQuote.days} × {formatMoney(shownQuote.dailyCents, lang)}
                </span>
              </div>
              <div className="quote-total">
                <span>{t('res.total')}</span>
                <strong>{formatMoney(shownQuote.totalCents, lang)}</strong>
              </div>
              <div className="small muted">
                {t('res.field.depositCents')} : {formatMoney(shownQuote.depositCents, lang)}
              </div>
            </div>
          )}
          {shownQuote && shownQuote.warnings.length > 0 && (
            <ul className="warning-list" role="alert">
              {shownQuote.warnings.map((w) => (
                <li key={w}>
                  <TriangleAlert size={16} aria-hidden="true" /> {t(`res.warning.${w}` as MessageKey)}
                </li>
              ))}
            </ul>
          )}
          {shownQuote && shownQuote.conflicts.length > 0 && (
            <div className="alert alert-error" role="alert">
              {t('res.unavailable')}
              <ul>
                {shownQuote.conflicts.map((c) => (
                  <li key={c.id}>{t('res.conflictWith', { ref: c.reference, name: c.customerName, from: formatDateTime(c.startAt), to: formatDateTime(c.endAt) })}</li>
                ))}
              </ul>
            </div>
          )}
          {quoteError && body && (
            <div className="alert alert-error" role="alert">
              {quoteError}
            </div>
          )}
        </fieldset>

        <div className="card form-section">
          <label className="field">
            <span>{t('res.notes')}</span>
            <textarea rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={busy || !body || Boolean(f.customer?.blocked) || (shownQuote !== null && !shownQuote.available) || (priceDiffers && !f.priceReason.trim())}
          >
            {busy ? t('common.saving') : t('res.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
