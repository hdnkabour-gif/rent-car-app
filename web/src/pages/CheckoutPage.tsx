import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ImagePlus, UserPlus, X } from 'lucide-react';
import { api, ApiError, uploadFile } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { FuelPicker } from '../components/Fuel';
import { Plate } from '../components/Plate';
import { formatKm, type Vehicle } from '../vehicles';
import { centsToInput, formatMoney, parseMoney, type Reservation } from '../reservations';
import type { Contract, ContractTemplate, Driver, PaymentMethod } from '../contracts';

const emptyDriver = (): Driver => ({ fullName: '', birthDate: '', licenceNumber: '', licenceIssueDate: '', licenceIssuePlace: '', idNumber: '', idIssueDate: '', phone: '' });

/** Maps contract API errors to plain words (shared with the contract page). */
export function contractErrorText(err: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (err instanceof ApiError) {
    const known = ['vehicle_not_ready', 'paper_number_used', 'overpayment', 'deposit_exceeded', 'vehicle_unavailable', 'reservation_past'];
    if (known.includes(err.code)) return t(`k.error.${err.code}` as MessageKey);
    if (err.code === 'customer_blocked') return t('res.error.customer_blocked');
    if (err.code === 'driver_too_young') return t('res.error.driver_too_young');
    if (err.code === 'mileage_decrease') return t('k.error.mileage', { km: formatKm(Number((err.details as unknown as { lastMileageKm?: number; kmOut?: number })?.lastMileageKm ?? (err.details as unknown as { kmOut?: number })?.kmOut ?? 0)) });
  }
  return t(errorKey(err));
}

export function CheckoutPage() {
  const [params] = useSearchParams();
  const reservationId = params.get('reservationId') ?? '';
  const res = useApi<{ reservation: Reservation }>(reservationId ? `/reservations/${reservationId}` : null);
  const vehicle = useApi<{ vehicle: Vehicle }>(res.data ? `/vehicles/${res.data.reservation.vehicle.id}` : null);
  const tpl = useApi<{ template: ContractTemplate }>('/contract-templates/current');
  const error = res.error ?? vehicle.error ?? tpl.error;
  if (error) return <ErrorState error={error} onRetry={() => (res.reload(), vehicle.reload(), tpl.reload())} />;
  if (!res.data || !vehicle.data || !tpl.data) return <Loading />;
  return <CheckoutForm reservation={res.data.reservation} vehicle={vehicle.data.vehicle} template={tpl.data.template} />;
}

function CheckoutForm({ reservation: r, vehicle: v, template }: { reservation: Reservation; vehicle: Vehicle; template: ContractTemplate }) {
  const { t, lang, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const [paperNumber, setPaperNumber] = useState('');
  const [km, setKm] = useState(String(v.mileageKm));
  const [fuel, setFuel] = useState<number | null>(v.fuelEighths);
  const [washed, setWashed] = useState<boolean | null>(null);
  const [docs, setDocs] = useState<string[]>(template.handedDocuments);
  const [notes, setNotes] = useState('');
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [pay, setPay] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('cash');
  const [payRef, setPayRef] = useState('');
  const [deposit, setDeposit] = useState(centsToInput(r.depositCents));
  const [depositMethod, setDepositMethod] = useState<PaymentMethod>('cash');
  const [depositRef, setDepositRef] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payCents = parseMoney(pay);
  const depositCents = parseMoney(deposit);
  const moneyBad = Number.isNaN(payCents) || Number.isNaN(depositCents);
  const notReady = v.status !== 'available';
  // Every other driver needs name, birth date (age check) and licence number.
  const driversIncomplete = drivers.some((d) => d.fullName.trim() && (!d.birthDate || !d.licenceNumber?.trim()));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payments = [
      ...(payCents ? [{ kind: 'rental', method: payMethod, amountCents: payCents, reference: payRef || null }] : []),
      ...(depositCents ? [{ kind: 'deposit_in', method: depositMethod, amountCents: depositCents, reference: depositRef || null }] : []),
    ];
    let contract: Contract;
    try {
      contract = (
        await api<{ contract: Contract }>('/contracts/checkout', {
          method: 'POST',
          body: {
            reservationId: r.id,
            paperNumber: paperNumber || null,
            kmOut: Number(km),
            fuelOut: fuel,
            washedOut: washed,
            documentsOut: docs,
            notesOut: notes || null,
            drivers: drivers.filter((d) => d.fullName.trim()).map((d) => Object.fromEntries(Object.entries(d).map(([k, x]) => [k, x || null]))),
            payments,
          },
        })
      ).contract;
    } catch (err) {
      setError(contractErrorText(err, t));
      setBusy(false);
      return;
    }
    // Photos after the contract exists; a failed photo does not undo the handover.
    let failed = 0;
    for (const p of photos) {
      try {
        await uploadFile(`/contracts/${contract.id}/photos?phase=out`, p);
      } catch {
        failed += 1;
      }
    }
    navigate(`/contracts/${contract.id}`, { replace: true, state: { notice: failed ? `${t('k.checkedOut')} ${t('photos.failed', { n: String(failed) })}` : t('k.checkedOut') } });
  };

  const setDriver = (i: number, k: keyof Driver, value: string) => setDrivers((ds) => ds.map((d, j) => (j === i ? { ...d, [k]: value } : d)));

  return (
    <section>
      <Link to={`/reservations/${r.id}`} className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('res.back')}
      </Link>
      <PageHeader title={t('k.checkoutTitle')} subtitle={`${r.reference} · ${r.customer.fullName}`} />
      <div className="card">
        <p>
          <strong>
            {r.vehicle.make} {r.vehicle.model}
          </strong>{' '}
          <Plate value={r.vehicle.plate} /> · {formatDateTime(r.startAt)} → {formatDateTime(r.endAt)} · {t('res.days', { n: String(r.days) })} ·{' '}
          <strong>{formatMoney(r.totalCents, lang)}</strong>
        </p>
        {notReady && (
          <div className="alert alert-error" role="alert">
            {t('k.error.vehicle_not_ready')}{' '}
            <Link to={`/vehicles/${v.id}`}>{t('vehicles.title')}</Link>
          </div>
        )}
      </div>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <fieldset className="card form-section">
          <legend>{t('k.out')}</legend>
          <div className="grid">
            <label className="field">
              <span>{t('k.paperNumber')}</span>
              <input dir="ltr" value={paperNumber} maxLength={30} onChange={(e) => setPaperNumber(e.target.value)} />
              <small className="hint">{t('k.paperNumberHint')}</small>
            </label>
            <label className="field">
              <span>{t('k.kmOut')}</span>
              <input type="number" inputMode="numeric" dir="ltr" min={v.mileageKm} value={km} onChange={(e) => setKm(e.target.value)} />
            </label>
            <div className="field field-wide">
              <span>{t('k.fuelOut')}</span>
              <FuelPicker value={fuel} onChange={setFuel} />
            </div>
            <div className="field">
              <span>{t('k.washed')}</span>
              <div className="segmented segmented-wide" role="group" aria-label={t('k.washed')}>
                {([true, false] as const).map((x) => (
                  <button key={String(x)} type="button" aria-pressed={washed === x} className={washed === x ? 'active' : ''} onClick={() => setWashed(x)}>
                    {x ? t('k.yes') : t('k.no')}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <fieldset className="field">
            <legend>{t('k.documentsOut')}</legend>
            <div className="checks">
              {template.handedDocuments.map((d) => (
                <label key={d} className="check">
                  <input type="checkbox" checked={docs.includes(d)} onChange={() => setDocs((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))} />
                  {d}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>{t('k.observations')}</span>
            <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div className="field">
            <span>{t('k.photosOut')}</span>
            <small className="hint">{t('k.photosHint')}</small>
            <label className="btn btn-small file-btn">
              <ImagePlus size={16} aria-hidden="true" /> {t('photos.add')}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => setPhotos((p) => [...p, ...Array.from(e.target.files ?? [])])} />
            </label>
            {photos.length > 0 && <small>{photos.map((p) => p.name).join(', ')}</small>}
          </div>
        </fieldset>

        {template.secondDriverSection && (
          <fieldset className="card form-section">
            <legend>{t('k.otherDriver')}</legend>
            {drivers.map((d, i) => (
              <div key={i} className="grid driver-grid">
                {(['fullName', 'birthDate', 'licenceNumber', 'licenceIssueDate', 'licenceIssuePlace', 'idNumber', 'idIssueDate', 'phone'] as const).map((k) => (
                  <label key={k} className="field">
                    <span>
                      {t(`k.driver.${k}` as MessageKey)}
                      {(k === 'fullName' || k === 'birthDate' || k === 'licenceNumber') && ' *'}
                    </span>
                    <input
                      type={k.endsWith('Date') ? 'date' : k === 'phone' ? 'tel' : 'text'}
                      dir={k === 'fullName' || k === 'licenceIssuePlace' ? undefined : 'ltr'}
                      value={d[k] ?? ''}
                      onChange={(e) => setDriver(i, k, e.target.value)}
                    />
                  </label>
                ))}
                <button type="button" className="icon-btn" aria-label={t('common.cancel')} onClick={() => setDrivers((ds) => ds.filter((_, j) => j !== i))}>
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            ))}
            {drivers.length < 3 && (
              <button type="button" className="btn btn-small" onClick={() => setDrivers((ds) => [...ds, emptyDriver()])}>
                <UserPlus size={16} aria-hidden="true" /> {t('k.addOtherDriver')}
              </button>
            )}
          </fieldset>
        )}

        <fieldset className="card form-section">
          <legend>{t('k.money')}</legend>
          <div className="grid">
            <label className="field">
              <span>{t('k.paymentNow')}</span>
              <input inputMode="decimal" dir="ltr" value={pay} placeholder={centsToInput(r.totalCents)} aria-invalid={Number.isNaN(payCents) || undefined} onChange={(e) => setPay(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('k.paymentMethod')}</span>
              <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}>
                {(['cash', 'transfer'] as const).map((m) => (
                  <option key={m} value={m}>
                    {t(`k.method.${m}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            {payMethod === 'transfer' && (
              <label className="field">
                <span>{t('k.reference')}</span>
                <input value={payRef} maxLength={80} onChange={(e) => setPayRef(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span>{t('k.depositNow')}</span>
              <input inputMode="decimal" dir="ltr" value={deposit} aria-invalid={Number.isNaN(depositCents) || undefined} onChange={(e) => setDeposit(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('k.depositMethod')}</span>
              <select value={depositMethod} onChange={(e) => setDepositMethod(e.target.value as PaymentMethod)}>
                {(['cash', 'cheque', 'card', 'transfer'] as const).map((m) => (
                  <option key={m} value={m}>
                    {t(`k.method.${m}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            {depositMethod !== 'cash' && (
              <label className="field">
                <span>{t('k.reference')}</span>
                <input value={depositRef} maxLength={80} onChange={(e) => setDepositRef(e.target.value)} />
              </label>
            )}
          </div>
          {moneyBad && <small className="field-error">{t('error.moneyInvalid')}</small>}
          <p className="muted small">{t('k.depositNotRevenue')}</p>
        </fieldset>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || notReady || fuel === null || km === '' || moneyBad || driversIncomplete}>
            {busy ? t('common.saving') : t('k.confirmCheckout')}
          </button>
        </div>
        {!notReady && (fuel === null || km === '') && <p className="muted small">{t('k.missingFuelKm')}</p>}
        {driversIncomplete && <p className="muted small">{t('k.driverIncomplete')}</p>}
      </form>
    </section>
  );
}
