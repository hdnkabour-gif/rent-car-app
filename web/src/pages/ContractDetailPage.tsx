import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, ImagePlus, Printer, Upload } from 'lucide-react';
import { api, uploadFile } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading } from '../components/States';
import { FuelGauge, FuelPicker } from '../components/Fuel';
import { Plate } from '../components/Plate';
import { DOC_FILE_ACCEPT, uploadErrorKey } from '../components/VehicleDocuments';
import { contractErrorText } from './CheckoutPage';
import { formatKm } from '../vehicles';
import { formatMoney, parseMoney } from '../reservations';
import { contractFileUrl, type ContractDetail, type PaymentKind, type PaymentMethod } from '../contracts';

type Panel = 'pay' | 'deposit_in' | 'deposit_out' | 'deposit_kept' | 'extend' | 'return' | null;

export function ContractDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { can } = useAuth();
  const { t, lang, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<ContractDetail>(`/contracts/${id}`);
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice ?? null);
  const [now] = useState(() => Date.now());
  const scanInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const { contract: k, balances: b } = data;
  const open = k.status === 'open';
  const late = open && new Date(k.plannedEndAt).getTime() < now;
  const manage = can('contracts.manage');
  const done = (msg: string) => {
    setPanel(null);
    setNotice(msg);
    reload();
  };

  const uploadScan = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    try {
      await uploadFile(`/contracts/${k.id}/signed-scan`, file, { method: 'PUT' });
      done(t('common.saved'));
    } catch (err) {
      setFileError(t(uploadErrorKey(err)));
    }
  };
  const uploadPhotos = async (files: File[], phase: 'out' | 'in') => {
    setFileError(null);
    let failed = 0;
    for (const f of files) {
      try {
        await uploadFile(`/contracts/${k.id}/photos?phase=${phase}`, f);
      } catch {
        failed += 1;
      }
    }
    if (failed) setFileError(t('photos.failed', { n: String(failed) }));
    reload();
  };

  return (
    <section>
      <Link to="/contracts" className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('k.back')}
      </Link>
      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}

      <div className="vehicle-hero card">
        <div>
          <h1>
            <bdi dir="ltr">{k.reference}</bdi>
            {k.paperNumber && (
              <span className="muted small">
                {' '}
                · {t('k.paperNumber')} <bdi dir="ltr">{k.paperNumber}</bdi>
              </span>
            )}
          </h1>
          <p>
            <Link to={`/customers/${k.customer.id}`}>{k.customer.fullName}</Link> ·{' '}
            <Link to={`/vehicles/${k.vehicle.id}`}>
              {k.vehicle.make} {k.vehicle.model}
            </Link>{' '}
            <Plate value={k.vehicle.plate} />
          </p>
        </div>
        <div className="vehicle-hero-side">
          <span className={`badge ${open ? (late ? 'badge-failure' : 'badge-info') : 'badge-neutral'}`}>{late ? t('k.late') : t(`k.status.${k.status}` as MessageKey)}</span>
          <Link to={`/contracts/${k.id}/print`} className="btn btn-small btn-primary">
            <Printer size={16} aria-hidden="true" /> {t('k.print')}
          </Link>
        </div>
        <div className="hero-stats">
          <div>
            <span className="muted small">{t('k.out')}</span>
            <strong>{formatDateTime(k.outAt)}</strong>
            <span className="small">
              {t('vehicles.km', { km: formatKm(k.kmOut) })} · <FuelGauge eighths={k.fuelOut} />
            </span>
          </div>
          <div>
            <span className="muted small">{k.inAt ? t('k.inAt') : t('k.plannedEnd')}</span>
            <strong>{formatDateTime(k.inAt ?? k.plannedEndAt)}</strong>
            {k.kmIn !== null && (
              <span className="small">
                {t('vehicles.km', { km: formatKm(k.kmIn) })} · <FuelGauge eighths={k.fuelIn} /> · {t('k.kmDriven', { km: formatKm(k.kmDriven ?? 0) })}
              </span>
            )}
          </div>
          <div>
            <span className="muted small">{t('k.total')}</span>
            <strong>{formatMoney(k.totalCents, lang)}</strong>
            <span className="small">
              {t('k.days', { n: String(k.days) })} × {formatMoney(k.dailyCents, lang)}
              {k.late.feeCents > 0 && ` + ${t('late.feeShort', { fee: formatMoney(k.late.feeCents, lang) })}`}
            </span>
          </div>
        </div>
      </div>
      <p className="muted small">{t('k.printHint')}</p>

      <div className="card">
        <div className="card-head">
          <h2>{t('k.money')}</h2>
        </div>
        <dl className="detail-grid money-grid">
          <div>
            <dt>{t('k.total')}</dt>
            <dd>{formatMoney(b.totalCents, lang)}</dd>
          </div>
          <div>
            <dt>{t('k.paid')}</dt>
            <dd>{formatMoney(b.paidCents, lang)}</dd>
          </div>
          <div>
            <dt>{t('k.rest')}</dt>
            <dd className={b.restCents > 0 ? 'text-danger' : ''}>{formatMoney(b.restCents, lang)}</dd>
          </div>
          <div>
            <dt>{t('k.depositHeld')}</dt>
            <dd>{formatMoney(b.depositHeldCents, lang)}</dd>
          </div>
          {b.depositReturnedCents > 0 && (
            <div>
              <dt>{t('k.depositReturned')}</dt>
              <dd>{formatMoney(b.depositReturnedCents, lang)}</dd>
            </div>
          )}
          {b.depositKeptCents > 0 && (
            <div>
              <dt>{t('k.depositKept')}</dt>
              <dd>{formatMoney(b.depositKeptCents, lang)}</dd>
            </div>
          )}
        </dl>
        <p className="muted small">{t('k.depositNotRevenue')}</p>
        {!panel && (
          <div className="doc-actions">
            {can('payments.record') && b.restCents > 0 && (
              <button type="button" className="btn btn-small btn-primary" onClick={() => setPanel('pay')}>
                {t('k.addPayment')}
              </button>
            )}
            {can('payments.record') && (
              <button type="button" className="btn btn-small" onClick={() => setPanel('deposit_in')}>
                {t('k.addDeposit')}
              </button>
            )}
            {can('deposits.refund') && b.depositHeldCents > 0 && (
              <button type="button" className="btn btn-small" onClick={() => setPanel('deposit_out')}>
                {t('k.refundDeposit')}
              </button>
            )}
            {can('deposits.retain') && b.depositHeldCents > 0 && (
              <button type="button" className="btn btn-small btn-danger-outline" onClick={() => setPanel('deposit_kept')}>
                {t('k.keepDeposit')}
              </button>
            )}
          </div>
        )}
        {(panel === 'pay' || panel === 'deposit_in' || panel === 'deposit_out' || panel === 'deposit_kept') && (
          <PaymentForm
            contractId={k.id}
            kind={panel === 'pay' ? 'rental' : panel}
            max={panel === 'pay' ? b.restCents : panel === 'deposit_in' ? null : b.depositHeldCents}
            defaultMethod={panel === 'deposit_out' || panel === 'deposit_kept' ? data.payments.filter((p) => p.kind === 'deposit_in' && !p.reversedBy).at(-1)?.method : undefined}
            onClose={() => setPanel(null)}
            onDone={() => done(t('common.saved'))}
          />
        )}
        <PaymentList data={data} onChanged={() => done(t('common.saved'))} />
      </div>

      <LateFeePanel data={data} onDone={() => done(t('common.saved'))} />

      {open && manage && (
        <div className="card">
          <div className="doc-actions">
            {!panel && (
              <>
                <button type="button" className="btn btn-primary" onClick={() => setPanel('return')}>
                  {t('k.return')}
                </button>
                {can('contracts.extend') && (
                  <button type="button" className="btn" onClick={() => setPanel('extend')}>
                    {t('k.extend')}
                  </button>
                )}
              </>
            )}
          </div>
          {panel === 'extend' && <ExtendForm contractId={k.id} onClose={() => setPanel(null)} onDone={() => done(t('common.saved'))} />}
          {panel === 'return' && <ReturnForm data={data} onClose={() => setPanel(null)} onDone={() => done(t('k.returned'))} />}
        </div>
      )}

      <div className="card">
        <h2>{t('k.signedScan')}</h2>
        {k.signedScanFileId ? (
          <a className="btn btn-small" href={contractFileUrl(k.id, k.signedScanFileId)} target="_blank" rel="noopener noreferrer">
            <FileText size={16} aria-hidden="true" /> {t('k.openSigned')}
          </a>
        ) : (
          <p className="muted">{t('k.noSigned')}</p>
        )}{' '}
        {manage && (
          <>
            <button type="button" className="btn btn-small" onClick={() => scanInput.current?.click()}>
              <Upload size={16} aria-hidden="true" /> {k.signedScanFileId ? t('k.replaceSigned') : t('k.attachSigned')}
            </button>
            <input ref={scanInput} type="file" accept={DOC_FILE_ACCEPT} hidden aria-label={t('k.attachSigned')} onChange={(e) => void uploadScan(e.target.files?.[0])} />
          </>
        )}
        {fileError && (
          <div className="alert alert-error" role="alert">
            {fileError}
          </div>
        )}
        {(['out', 'in'] as const).map((phase) => {
          const list = data.photos.filter((p) => p.phase === phase);
          return (
            <div key={phase} className="detail-section">
              <h3>{phase === 'out' ? t('k.photosOut') : t('k.photosIn')}</h3>
              {list.length > 0 && (
                <ul className="photo-grid">
                  {list.map((p) => (
                    <li key={p.id}>
                      <a href={contractFileUrl(k.id, p.fileId)} target="_blank" rel="noopener noreferrer">
                        <img src={contractFileUrl(k.id, p.fileId)} alt="" loading="lazy" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {manage && (
                <label className="btn btn-small file-btn">
                  <ImagePlus size={16} aria-hidden="true" /> {t('photos.add')}
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void uploadPhotos(Array.from(e.target.files ?? []), phase)} />
                </label>
              )}
            </div>
          );
        })}
      </div>

      {(data.drivers.length > 0 || k.notesOut || k.notesIn || k.documentsOut.length > 0) && (
        <div className="card">
          <dl className="detail-grid">
            {k.documentsOut.length > 0 && (
              <div>
                <dt>{t('k.documentsOut')}</dt>
                <dd>{k.documentsOut.join(', ')}</dd>
              </div>
            )}
            {k.washedOut !== null && (
              <div>
                <dt>{t('k.washed')}</dt>
                <dd>{k.washedOut ? t('k.yes') : t('k.no')}</dd>
              </div>
            )}
            {k.notesOut && (
              <div>
                <dt>{t('k.observations')}</dt>
                <dd className="pre-wrap">{k.notesOut}</dd>
              </div>
            )}
            {k.notesIn && (
              <div>
                <dt>{t('k.returnTitle')}</dt>
                <dd className="pre-wrap">{k.notesIn}</dd>
              </div>
            )}
            {data.drivers.map((d) => (
              <div key={d.id}>
                <dt>{t('k.otherDriver')}</dt>
                <dd>
                  {d.fullName}
                  {d.licenceNumber && (
                    <>
                      {' '}
                      · <bdi dir="ltr">{d.licenceNumber}</bdi>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="card">
        <h2>{t('k.history')}</h2>
        <ol className="timeline">
          {data.events.map((e) => (
            <li key={e.id}>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-body">
                <div className="timeline-title">
                  <strong>{t(`k.event.${e.event}` as MessageKey)}</strong>
                </div>
                <div className="muted small">
                  {formatDateTime(e.at)}
                  {e.by && ` · ${t('res.by', { name: e.by })}`}
                </div>
                {e.event === 'payment' && typeof e.details.amountCents === 'number' && (
                  <div className="small">
                    {e.details.kind ? t(`k.kind.${String(e.details.kind)}` as MessageKey) : ''} · {formatMoney(e.details.amountCents, lang)}
                    {e.details.reversal ? ` · ${t('k.kind.reversal')}` : ''}
                  </div>
                )}
                {e.reason && <div className="small">« {e.reason} »</div>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function PaymentList({ data, onChanged }: { data: ContractDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const { t, lang, formatDateTime } = useI18n();
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!data.payments.length) return null;
  const reverse = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/contracts/${data.contract.id}/payments/${reversing}/reverse`, { method: 'POST', body: { reason: reason.trim() } });
      setReversing(null);
      setReason('');
      onChanged();
    } catch (err) {
      setError(contractErrorText(err, t));
    }
  };
  return (
    <div className="detail-section">
      <h3>{t('k.payments')}</h3>
      <ul className="pay-list">
        {data.payments.map((p) => (
          <li key={p.id} className={p.reversedBy ? 'reversed' : ''}>
            <span>
              <strong>{t(`k.kind.${p.kind}` as MessageKey)}</strong> · {t(`k.method.${p.method}` as MessageKey)}
              {p.reference && (
                <>
                  {' '}
                  · <bdi dir="ltr">{p.reference}</bdi>
                </>
              )}
              <span className="muted small">
                {' '}
                · {formatDateTime(p.createdAt)}
                {p.by && ` · ${p.by}`}
              </span>
              {p.reason && <span className="small"> « {p.reason} »</span>}
              {p.reversedBy && <span className="badge badge-neutral">{t('k.reversed')}</span>}
            </span>
            <strong className={p.kind === 'reversal' || p.kind === 'deposit_out' ? 'text-danger' : ''}>
              {p.kind === 'reversal' || p.kind === 'deposit_out' ? '− ' : ''}
              {formatMoney(p.amountCents, lang)}
            </strong>
            {can('payments.reverse') && p.kind !== 'reversal' && !p.reversedBy && reversing !== p.id && (
              <button type="button" className="btn btn-small" onClick={() => setReversing(p.id)}>
                {t('k.reverse')}
              </button>
            )}
            {reversing === p.id && (
              <form className="transition-form" onSubmit={reverse}>
                <label className="field">
                  <span>{t('k.reasonRequired')}</span>
                  <input required value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                {error && <div className="alert alert-error">{error}</div>}
                <div className="actions">
                  <button type="button" className="btn" onClick={() => setReversing(null)}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="btn btn-danger" disabled={reason.trim().length < 3}>
                    {t('k.reverse')}
                  </button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PaymentForm({
  contractId,
  kind,
  max,
  defaultMethod,
  onClose,
  onDone,
}: {
  contractId: string;
  kind: Exclude<PaymentKind, 'reversal'>;
  max: number | null;
  defaultMethod?: PaymentMethod;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const [amount, setAmount] = useState(max !== null && max > 0 ? String(max / 100) : '');
  const methods: PaymentMethod[] = kind === 'rental' ? ['cash', 'transfer'] : ['cash', 'cheque', 'card', 'transfer'];
  // Giving back or keeping a deposit uses the same instrument as received (cheque stays cheque).
  const [method, setMethod] = useState<PaymentMethod>(defaultMethod ?? 'cash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoney(amount);
  const invalid = cents === null || Number.isNaN(cents) || cents <= 0 || (max !== null && cents > max) || (kind === 'deposit_kept' && !reason.trim());
  const title = kind === 'rental' ? t('k.addPayment') : kind === 'deposit_in' ? t('k.addDeposit') : kind === 'deposit_out' ? t('k.refundDeposit') : t('k.keepDeposit');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/contracts/${contractId}/payments`, { method: 'POST', body: { kind, method, amountCents: cents, reference: reference || null, reason: reason || null } });
      onDone();
    } catch (err) {
      setError(contractErrorText(err, t));
      setBusy(false);
    }
  };
  return (
    <form className="transition-form" onSubmit={submit} aria-label={title}>
      <h3>{title}</h3>
      <div className="grid">
        <label className="field">
          <span>{t('k.amount')}</span>
          <input inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {max !== null && <small className="hint">≤ {formatMoney(max, lang)}</small>}
        </label>
        <label className="field">
          <span>{t('k.paymentMethod')}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {t(`k.method.${m}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('k.reference')}</span>
          <input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="field">
          <span>{kind === 'deposit_kept' ? t('k.reasonRequired') : t('k.reason')}</span>
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
          {t('k.save')}
        </button>
      </div>
    </form>
  );
}

function ExtendForm({ contractId, onClose, onDone }: { contractId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/contracts/${contractId}/extend`, { method: 'POST', body: { newEnd: end, reason: reason || null } });
      onDone();
    } catch (err) {
      setError(contractErrorText(err, t));
    }
  };
  return (
    <form className="transition-form" onSubmit={submit}>
      <div className="grid">
        <label className="field">
          <span>{t('k.newEnd')}</span>
          <input type="datetime-local" dir="ltr" required value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('k.reason')}</span>
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!end}>
          {t('k.extend')}
        </button>
      </div>
    </form>
  );
}

interface LatePreview {
  lateMinutes: number;
  graceMinutes: number;
  isLate: boolean;
  suggestions: Record<LateUnit, number>;
  unitPrices: Record<LateUnit, number>;
}
type LateUnit = 'day' | 'half_day' | 'hour';
const LATE_UNITS: LateUnit[] = ['day', 'half_day', 'hour'];

/** The manager's choice for a late return: whole days, half days or hours at a price, or nothing (with reason). */
function LateDecisionFields({
  preview,
  value,
  onChange,
}: {
  preview: Pick<LatePreview, 'suggestions' | 'unitPrices'>;
  value: LateChoice;
  onChange: (v: LateChoice) => void;
}) {
  const { t, lang } = useI18n();
  const cents = parseMoney(value.unitPrice);
  const fee = value.decision === 'charge' && cents !== null && !Number.isNaN(cents) && Number(value.quantity) > 0 ? cents * Number(value.quantity) : 0;
  const pick = (unit: LateUnit) => onChange({ ...value, decision: 'charge', unit, quantity: String(preview.suggestions[unit]), unitPrice: String(preview.unitPrices[unit] / 100) });
  return (
    <div className="late-box">
      <div className="segmented segmented-wide segmented-wrap" role="group" aria-label={t('late.choose')}>
        {LATE_UNITS.map((u) => (
          <button key={u} type="button" aria-pressed={value.decision === 'charge' && value.unit === u} className={value.decision === 'charge' && value.unit === u ? 'active' : ''} onClick={() => pick(u)}>
            {t(`late.unit.${u}` as MessageKey)}
          </button>
        ))}
        <button type="button" aria-pressed={value.decision === 'waive'} className={value.decision === 'waive' ? 'active' : ''} onClick={() => onChange({ ...value, decision: 'waive' })}>
          {t('late.waive')}
        </button>
      </div>
      {value.decision === 'charge' && (
        <div className="grid">
          <label className="field">
            <span>{t(`late.quantity.${value.unit}` as MessageKey)}</span>
            <input type="number" inputMode="numeric" dir="ltr" min={1} value={value.quantity} onChange={(e) => onChange({ ...value, quantity: e.target.value })} />
          </label>
          <label className="field">
            <span>{t(`late.price.${value.unit}` as MessageKey)}</span>
            <input inputMode="decimal" dir="ltr" value={value.unitPrice} onChange={(e) => onChange({ ...value, unitPrice: e.target.value })} />
          </label>
          <div className="field">
            <span>{t('late.fee')}</span>
            <strong>{formatMoney(fee, lang)}</strong>
          </div>
        </div>
      )}
      {value.decision && (
        <label className="field">
          <span>{value.decision === 'waive' ? t('k.reasonRequired') : t('k.reason')}</span>
          <input value={value.reason} maxLength={500} onChange={(e) => onChange({ ...value, reason: e.target.value })} />
        </label>
      )}
    </div>
  );
}

interface LateChoice {
  decision: 'charge' | 'waive' | null;
  unit: LateUnit;
  quantity: string;
  unitPrice: string;
  reason: string;
}
const noChoice: LateChoice = { decision: null, unit: 'day', quantity: '', unitPrice: '', reason: '' };

function lateBody(v: LateChoice) {
  if (!v.decision) return null;
  if (v.decision === 'waive') return { decision: 'waive', reason: v.reason.trim() || null };
  return { decision: 'charge', unit: v.unit, quantity: Number(v.quantity), unitCents: parseMoney(v.unitPrice), reason: v.reason.trim() || null };
}
function lateValid(v: LateChoice, needReason = false) {
  if (!v.decision) return true;
  if (v.decision === 'waive') return v.reason.trim().length > 0;
  const c = parseMoney(v.unitPrice);
  return Number(v.quantity) >= 1 && c !== null && !Number.isNaN(c) && (!needReason || v.reason.trim().length > 0);
}

const lateText = (m: number, t: ReturnType<typeof useI18n>['t']) => t('k.lateBy2', { h: String(Math.floor(m / 60)), m: String(m % 60) });

/** After the return: the manager decides or changes the late charge. */
function LateFeePanel({ data, onDone }: { data: ContractDetail; onDone: () => void }) {
  const { can } = useAuth();
  const { t, lang } = useI18n();
  const k = data.contract;
  const l = k.late;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<LateChoice>(noChoice);
  const [error, setError] = useState<string | null>(null);
  if (l.status === 'none') return null;
  const decided = l.status !== 'pending';
  const suggestions = {
    day: Math.max(1, Math.ceil((l.minutes ?? 0) / 1440)),
    half_day: Math.max(1, Math.ceil((l.minutes ?? 0) / 720)),
    hour: Math.max(1, Math.ceil((l.minutes ?? 0) / 60)),
  };
  const unitPrices = { day: k.dailyCents, half_day: Math.round(k.dailyCents / 2), hour: Math.round(k.dailyCents / 2400) * 100 };
  const save = async () => {
    setError(null);
    try {
      await api(`/contracts/${k.id}/late-fee`, { method: 'POST', body: lateBody(choice) });
      setOpen(false);
      setChoice(noChoice);
      onDone();
    } catch (err) {
      setError(contractErrorText(err, t));
    }
  };
  return (
    <div className={`card late-card late-${l.status}`}>
      <h2>{t('late.title')}</h2>
      <p>
        {lateText(l.minutes ?? 0, t)} ·{' '}
        <strong>
          {l.status === 'pending'
            ? t('late.pending')
            : l.status === 'waived'
              ? t('late.waived')
              : t('late.charged', { q: String(l.quantity), unit: t(`late.unit.${l.unit}` as MessageKey), fee: formatMoney(l.feeCents, lang) })}
        </strong>
        {l.reason && <span className="small"> « {l.reason} »</span>}
      </p>
      {!can('pricing.change') && l.status === 'pending' && <p className="muted small">{t('late.managerDecides')}</p>}
      {can('pricing.change') && !open && (
        <button type="button" className="btn btn-primary btn-small" onClick={() => setOpen(true)}>
          {decided ? t('late.change') : t('late.decide')}
        </button>
      )}
      {open && (
        <>
          <LateDecisionFields preview={{ suggestions, unitPrices }} value={choice} onChange={setChoice} />
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" disabled={!choice.decision || !lateValid(choice, decided)} onClick={() => void save()}>
              {t('k.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ReturnForm({ data, onClose, onDone }: { data: ContractDetail; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const k = data.contract;
  const preview = useApi<LatePreview>(`/contracts/${k.id}/return-preview`);
  const [km, setKm] = useState('');
  const [fuel, setFuel] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [cleaned, setCleaned] = useState(false);
  const [choice, setChoice] = useState<LateChoice>(noChoice);
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (preview.error) return <ErrorState error={preview.error} onRetry={preview.reload} />;
  if (!preview.data) return <Loading />;
  const p = preview.data;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const late = p.isLate ? lateBody(choice) : null;
    try {
      await api(`/contracts/${k.id}/checkin`, { method: 'POST', body: { kmIn: Number(km), fuelIn: fuel, notesIn: notes || null, cleaned, ...(late ? { late } : {}) } });
    } catch (err) {
      setError(contractErrorText(err, t));
      setBusy(false);
      return;
    }
    for (const f of photos) await uploadFile(`/contracts/${k.id}/photos?phase=in`, f).catch(() => undefined);
    onDone();
  };

  return (
    <form className="transition-form" onSubmit={(e) => void submit(e)}>
      <h3>{t('k.returnTitle')}</h3>
      <p className={p.isLate ? 'alert alert-error' : 'muted'}>{p.lateMinutes > 0 ? `${lateText(p.lateMinutes, t)} (${t('late.grace', { g: String(p.graceMinutes) })})` : t('k.onTime')}</p>
      {p.isLate &&
        (can('pricing.change') ? (
          <>
            <p className="small">{t('late.decideNowOrLater')}</p>
            <LateDecisionFields preview={p} value={choice} onChange={setChoice} />
          </>
        ) : (
          <p className="muted small">{t('late.managerDecides')}</p>
        ))}
      <div className="grid">
        <label className="field">
          <span>{t('k.kmIn')}</span>
          <input type="number" inputMode="numeric" dir="ltr" min={k.kmOut} required value={km} placeholder={String(k.kmOut)} onChange={(e) => setKm(e.target.value)} />
        </label>
        <div className="field field-wide">
          <span>{t('k.fuelIn')}</span>
          <FuelPicker value={fuel} onChange={setFuel} />
        </div>
        <label className="check">
          <input type="checkbox" checked={cleaned} onChange={(e) => setCleaned(e.target.checked)} /> {t('k.cleanedAtReturn')}
        </label>
        <label className="field field-wide">
          <span>{t('k.observations')}</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="btn btn-small file-btn">
          <ImagePlus size={16} aria-hidden="true" /> {t('k.photosIn')}
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => setPhotos((x) => [...x, ...Array.from(e.target.files ?? [])])} />
        </label>
        {photos.length > 0 && <small>{photos.map((f) => f.name).join(', ')}</small>}
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || km === '' || fuel === null || !lateValid(choice)}>
          {busy ? t('common.saving') : t('k.confirmReturn')}
        </button>
      </div>
    </form>
  );
}
