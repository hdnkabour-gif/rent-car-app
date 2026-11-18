import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { formatMoney, parseMoney } from '../reservations';
import type { Vehicle } from '../vehicles';

type InfractionStatus = 'new' | 'under_review' | 'contested' | 'paid' | 'closed';
interface Infraction {
  id: string;
  vehicle: { id: string; plate: string; make: string; model: string };
  issuer: string;
  noticeNumber: string;
  occurredLocal: string;
  notifiedOn: string | null;
  location: string | null;
  kind: string | null;
  amountCents: number;
  status: InfractionStatus;
  matchStatus: 'pending' | 'confirmed' | 'no_contract';
  contractId: string | null;
  contractNumber: number | null;
  reviewReason: string | null;
}
interface ContractCandidate {
  id: string;
  number: number;
  outAt: string;
  inAt: string | null;
  plannedEndAt: string;
  provisional: boolean;
}
const STATUSES: InfractionStatus[] = ['new', 'under_review', 'contested', 'paid', 'closed'];

export function InfractionsPage() {
  const { can } = useAuth();
  const { t, lang, formatDateTime } = useI18n();
  const [params, setParams] = useSearchParams();
  const vehicleId = params.get('vehicleId') ?? '';
  const statusFilter = params.get('status') ?? '';
  const list = useApi<{ items: Infraction[] }>(`/infractions?${new URLSearchParams({
    ...(vehicleId ? { vehicleId } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
  }).toString()}`);
  const fleet = useApi<{ items: Vehicle[] }>('/vehicles');
  const [showForm, setShowForm] = useState(false);
  const [vehicle, setVehicle] = useState(vehicleId);
  const [issuer, setIssuer] = useState('NARSA');
  const [noticeNumber, setNoticeNumber] = useState('');
  const [occurredLocal, setOccurredLocal] = useState('');
  const [notifiedOn, setNotifiedOn] = useState('');
  const [location, setLocation] = useState('');
  const [kind, setKind] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contractId, setContractId] = useState('');
  const [reason, setReason] = useState('');
  const [nextStatus, setNextStatus] = useState<InfractionStatus>('under_review');
  const [paymentReference, setPaymentReference] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const candidates = useApi<{ candidates: ContractCandidate[] }>(
    selectedId && can('infractions.manage') ? `/infractions/${selectedId}/candidates` : null,
  );
  const selection = list.data?.items.find((i) => i.id === selectedId);
  const allVehicles = fleet.data?.items ?? [];

  const setFilter = (key: string, value: string) => {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    setParams(p, { replace: true });
  };
  const refresh = (message: string) => {
    list.reload();
    setNotice(message);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = parseMoney(amount);
    if (amountCents === null || !Number.isFinite(amountCents) || amountCents < 0) {
      setNotice(t('infractions.badAmount'));
      return;
    }
    setBusy(true);
    try {
      await api('/infractions', { method: 'POST', body: {
        vehicleId: vehicle, issuer, noticeNumber, occurredLocal,
        notifiedOn: notifiedOn || null, location: location || null, kind: kind || null, amountCents,
      } });
      setShowForm(false);
      setNoticeNumber('');
      setAmount('');
      refresh(t('infractions.saved'));
    } catch {
      setNotice(t('infractions.failed'));
    } finally {
      setBusy(false);
    }
  };
  const review = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/infractions/${selectedId}/match`, { method: 'POST', body: {
        contractId: contractId || null, reason,
      } });
      refresh(t('infractions.reviewSaved'));
      setSelectedId(null);
      setReason('');
    } catch {
      setNotice(t('infractions.failed'));
    } finally { setBusy(false); }
  };
  const changeStatus = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/infractions/${selectedId}/status`, { method: 'POST', body: {
        status: nextStatus, reason, paymentReference: paymentReference || null,
      } });
      refresh(t('infractions.reviewSaved'));
      setSelectedId(null);
      setReason('');
      setPaymentReference('');
    } catch {
      setNotice(t('infractions.failed'));
    } finally { setBusy(false); }
  };

  return (
    <section>
      <PageHeader title={t('infractions.title')} subtitle={t('infractions.subtitle')}
        actions={<a className="btn btn-small" href="https://tasrih-saeq.narsa.gov.ma" target="_blank" rel="noopener noreferrer">
          {t('infractions.officialPortal')}
        </a>} />
      <div className="alert alert-info">{t('infractions.manualOnly')}</div>
      {notice && <div className="alert alert-info" role="status">{notice}</div>}
      <div className="card filter-card">
        <div className="grid">
          <label className="field">
            <span>{t('infractions.vehicle')}</span>
            <select aria-label={t('infractions.vehicle')} value={vehicleId} onChange={(e) => setFilter('vehicleId', e.target.value)}>
              <option value="">{t('infractions.allVehicles')}</option>
              {allVehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {v.make} {v.model}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t('infractions.status')}</span>
            <select value={statusFilter} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">{t('infractions.allStatuses')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`infractions.status.${s}` as MessageKey)}</option>)}
            </select>
          </label>
        </div>
      </div>
      {can('infractions.manage') && (
        <div className="card">
          <button className="btn btn-primary" type="button" onClick={() => { setVehicle(vehicleId); setShowForm((v) => !v); }}>
            {showForm ? t('common.cancel') : t('infractions.add')}
          </button>
          {showForm && (
            <form onSubmit={(e) => { void create(e); }} className="grid" style={{ marginTop: 16 }}>
              <label className="field"><span>{t('infractions.vehicle')}</span>
                <select required value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
                  <option value="">—</option>
                  {allVehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {v.make} {v.model}</option>)}
                </select></label>
              <label className="field"><span>{t('infractions.issuer')}</span>
                <input required maxLength={100} value={issuer} onChange={(e) => setIssuer(e.target.value)} /></label>
              <label className="field"><span>{t('infractions.number')}</span>
                <input required maxLength={100} value={noticeNumber} onChange={(e) => setNoticeNumber(e.target.value)} /></label>
              <label className="field"><span>{t('infractions.occurred')}</span>
                <input required type="datetime-local" value={occurredLocal} onChange={(e) => setOccurredLocal(e.target.value)} /></label>
              <label className="field"><span>{t('infractions.notified')}</span>
                <input type="date" value={notifiedOn} onChange={(e) => setNotifiedOn(e.target.value)} /></label>
              <label className="field"><span>{t('infractions.location')}</span>
                <input maxLength={250} value={location} onChange={(e) => setLocation(e.target.value)} /></label>
              <label className="field"><span>{t('infractions.kind')}</span>
                <input maxLength={120} value={kind} onChange={(e) => setKind(e.target.value)} /></label>
              <label className="field"><span>{t('infractions.amount')}</span>
                <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
              <button className="btn btn-primary" type="submit" disabled={busy}>{t('common.save')}</button>
            </form>
          )}
        </div>
      )}
      {Boolean(list.error) && <ErrorState error={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data && (
        <div className="card">
          <h2>{t('infractions.title')} ({list.data.items.length})</h2>
          {list.data.items.length === 0 && <p className="muted">{t('infractions.empty')}</p>}
          {list.data.items.map((i) => (
            <div className="list-row" key={i.id} style={{ marginBottom: 12 }}>
              <div>
                <strong>{i.noticeNumber}</strong> — {i.issuer}
                <p className="muted small">{i.vehicle.plate} · {i.occurredLocal.replace('T', ' ')} · {i.location || '—'}</p>
                <p className="small">{formatMoney(i.amountCents, lang)} · {t(`infractions.status.${i.status}` as MessageKey)}</p>
                <p className="muted small">{i.matchStatus === 'confirmed' ? t('infractions.linked') : i.matchStatus === 'pending' ? t('infractions.pending') : t('infractions.noMatch')}</p>
                {i.contractId && <Link to={`/contracts/${i.contractId}`}>{t('infractions.contract')} #{i.contractNumber}</Link>}
              </div>
              {can('infractions.manage') && <button className="btn btn-small" type="button" onClick={() => {
                setSelectedId(i.id); setContractId(i.contractId ?? ''); setNextStatus(i.status); setReason(''); setNotice('');
              }}>{t('infractions.review')}</button>}
            </div>
          ))}
        </div>
      )}
      {selection && can('infractions.manage') && (
        <div className="card">
          <h2>{t('infractions.review')} — {selection.noticeNumber}</h2>
          <p>{t('infractions.matchWarning')}</p>
          {Boolean(candidates.error) && <ErrorState error={candidates.error} onRetry={candidates.reload} />}
          <form className="grid" onSubmit={(e) => { void review(e); }}>
            <label className="field"><span>{t('infractions.contract')}</span>
              <select value={contractId} onChange={(e) => setContractId(e.target.value)}>
                <option value="">{t('infractions.noMatch')}</option>
                {(candidates.data?.candidates ?? []).map((c) => <option key={c.id} value={c.id}>
                  #{c.number} · {formatDateTime(c.outAt)} · {c.provisional ? t('infractions.provisional') : ''}
                </option>)}
              </select>
            </label>
            <label className="field"><span>{t('infractions.reason')}</span>
              <textarea required minLength={10} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || !candidates.data}>{t('infractions.confirmMatch')}</button>
          </form>
          <form className="grid" style={{ marginTop: 16 }} onSubmit={(e) => { void changeStatus(e); }}>
            <label className="field"><span>{t('infractions.status')}</span>
              <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value as InfractionStatus)}>
                {STATUSES.map((s) => <option key={s} value={s}>{t(`infractions.status.${s}` as MessageKey)}</option>)}
              </select>
            </label>
            {nextStatus === 'paid' && <label className="field"><span>{t('infractions.paymentReference')}</span>
              <input required maxLength={120} value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} /></label>}
            <button className="btn" type="submit" disabled={busy || nextStatus === selection.status || reason.trim().length < 10}>
              {t('infractions.changeStatus')}
            </button>
          </form>
          <p className="muted small">{t('infractions.noAutomaticCharge')}</p>
          <button className="btn btn-small" type="button" onClick={() => setSelectedId(null)}>{t('common.cancel')}</button>
        </div>
      )}
    </section>
  );
}
