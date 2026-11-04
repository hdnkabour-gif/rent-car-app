import { useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { Plate } from '../components/Plate';
import { RES_BADGE } from './ReservationsPage';
import { formatMoney, type Reservation, type ReservationEvent } from '../reservations';

type Action = 'cancel' | 'no-show' | 'reopen';

export function ReservationDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { can } = useAuth();
  const { t, lang, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<{ reservation: Reservation; events: ReservationEvent[] }>(`/reservations/${id}`);
  const [action, setAction] = useState<Action | null>(null);
  // Time at page load: decides which actions are offered (the server re-checks every action).
  const [now] = useState(() => Date.now());
  const notice = (location.state as { notice?: string } | null)?.notice ?? null;

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const r = data.reservation;
  const manage = can('reservations.manage');
  const started = new Date(r.startAt).getTime() <= now;
  const place = (p: Reservation['pickupPlace'], details: string | null) => `${t(`res.place.${p}` as MessageKey)}${details ? ` — ${details}` : ''}`;

  const fieldValue = (k: string, v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (k === 'dailyCents' || k === 'totalCents' || k === 'depositCents') return formatMoney(Number(v), lang);
    if (k === 'pickupPlace' || k === 'returnPlace') return t(`res.place.${String(v)}` as MessageKey);
    if (k === 'start' || k === 'end') return String(v).replace('T', ' ');
    return String(v);
  };

  return (
    <section>
      <Link to="/reservations" className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('res.back')}
      </Link>

      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}

      <div className="vehicle-hero card">
        <div>
          <h1>
            <bdi dir="ltr">{r.reference}</bdi>
          </h1>
          <p className="muted">
            {formatDateTime(r.startAt)} → {formatDateTime(r.endAt)} · {t('res.days', { n: String(r.days) })}
          </p>
        </div>
        <div className="vehicle-hero-side">
          <span className={`badge ${RES_BADGE[r.status]}`}>{t(`res.status.${r.status}` as MessageKey)}</span>
          {r.cancelReason && <span className="small">« {r.cancelReason} »</span>}
        </div>
        <div className="hero-stats">
          <div>
            <span className="muted small">{t('res.total')}</span>
            <strong>{formatMoney(r.totalCents, lang)}</strong>
          </div>
          <div>
            <span className="muted small">{t('res.field.dailyCents')}</span>
            <strong>{formatMoney(r.dailyCents, lang)}</strong>
          </div>
          <div>
            <span className="muted small">{t('res.field.depositCents')}</span>
            <strong>{formatMoney(r.depositCents, lang)}</strong>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('res.details')}</h2>
          {manage && r.status === 'confirmed' && (
            <Link to={`/reservations/${r.id}/edit`} className="btn btn-small">
              <Pencil size={16} aria-hidden="true" /> {t('res.edit')}
            </Link>
          )}
        </div>
        <dl className="detail-grid">
          <div>
            <dt>{t('res.field.customer')}</dt>
            <dd>
              <Link to={`/customers/${r.customer.id}`}>{r.customer.fullName}</Link> · <bdi dir="ltr">{r.customer.phone}</bdi>
              {r.customer.blocked && <span className="badge badge-failure">{t('customers.blocked')}</span>}
            </dd>
          </div>
          <div>
            <dt>{t('res.field.vehicle')}</dt>
            <dd>
              <Link to={`/vehicles/${r.vehicle.id}`}>
                {r.vehicle.make} {r.vehicle.model}
              </Link>{' '}
              <Plate value={r.vehicle.plate} />
            </dd>
          </div>
          <div>
            <dt>{t('res.pickupPlace')}</dt>
            <dd>
              {place(r.pickupPlace, r.pickupDetails)} · {r.branch.name}
            </dd>
          </div>
          <div>
            <dt>{t('res.returnPlace')}</dt>
            <dd>
              {place(r.returnPlace, r.returnDetails)} · {r.returnBranch.name}
            </dd>
          </div>
          {r.dailyCents !== r.listDailyCents && (
            <div>
              <dt>{t('res.listPrice')}</dt>
              <dd>
                {formatMoney(r.listDailyCents, lang)} → {formatMoney(r.dailyCents, lang)}
                {r.priceReason && <div className="small">« {r.priceReason} »</div>}
              </dd>
            </div>
          )}
          {r.notes && (
            <div>
              <dt>{t('res.notes')}</dt>
              <dd className="pre-wrap">{r.notes}</dd>
            </div>
          )}
        </dl>
        <p className="muted small">{t('res.createdBy', { date: formatDateTime(r.createdAt), name: r.createdBy ?? '—' })}</p>

        {manage && !action && (
          <div className="doc-actions">
            {r.status === 'confirmed' && (
              <button type="button" className="btn btn-small btn-danger-outline" onClick={() => setAction('cancel')}>
                {t('res.cancel')}
              </button>
            )}
            {r.status === 'confirmed' && started && (
              <button type="button" className="btn btn-small" onClick={() => setAction('no-show')}>
                {t('res.noShow')}
              </button>
            )}
            {(r.status === 'cancelled' || r.status === 'no_show') && new Date(r.endAt).getTime() > now && (
              <button type="button" className="btn btn-small" onClick={() => setAction('reopen')}>
                {t('res.reopen')}
              </button>
            )}
          </div>
        )}
        {action && (
          <ReasonForm
            reservationId={r.id}
            action={action}
            onClose={() => setAction(null)}
            onDone={() => {
              setAction(null);
              reload();
            }}
          />
        )}
        {r.status === 'confirmed' && <p className="muted small">{t('res.contractSoon')}</p>}
      </div>

      <div className="card">
        <h2>{t('res.history')}</h2>
        <ol className="timeline">
          {data.events.map((e) => (
            <li key={e.id}>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-body">
                <div className="timeline-title">
                  <strong>{t(`res.event.${e.event}` as MessageKey)}</strong>
                </div>
                <div className="muted small">
                  {formatDateTime(e.at)}
                  {e.by && ` · ${t('res.by', { name: e.by })}`}
                </div>
                {e.event === 'changed' && (
                  <ul className="small change-list">
                    {Object.entries(e.changes).map(([k, v]) => {
                      const c = v as { from: unknown; to: unknown };
                      return (
                        <li key={k}>
                          {t(`res.field.${k}` as MessageKey)} : <bdi>{fieldValue(k, c.from)}</bdi> → <bdi>{fieldValue(k, c.to)}</bdi>
                        </li>
                      );
                    })}
                  </ul>
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

function ReasonForm({ reservationId, action, onClose, onDone }: { reservationId: string; action: Action; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = action === 'cancel' ? t('res.cancel') : action === 'no-show' ? t('res.noShow') : t('res.reopen');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/reservations/${reservationId}/${action}`, { method: 'POST', body: { reason: reason.trim() } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'vehicle_unavailable' ? t('res.unavailable') : t(errorKey(err)));
      setBusy(false);
    }
  };

  return (
    <form className="transition-form" onSubmit={submit}>
      <label className="field">
        <span>{t('res.reason')}</span>
        <textarea rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="submit" className={`btn ${action === 'cancel' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || reason.trim().length < 3}>
          {label}
        </button>
      </div>
    </form>
  );
}
