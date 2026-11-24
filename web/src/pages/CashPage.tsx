import { useState, type FormEvent } from 'react';
import { Receipt } from 'lucide-react';
import { api, ApiError, uploadFile } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { uploadErrorKey } from '../components/VehicleDocuments';
import { formatMoney, parseMoney } from '../reservations';
import type { Branch, Vehicle } from '../vehicles';

const METHODS = ['cash', 'cheque', 'card', 'transfer'] as const;
type Method = (typeof METHODS)[number];
type ByMethod = Record<Method, number>;
const CATEGORIES = ['fuel', 'washing', 'maintenance', 'repair', 'tyres', 'insurance', 'tax', 'parking', 'rent', 'salary', 'office', 'other'] as const;

interface Day {
  date: string;
  totals: { rental: ByMethod; depositIn: ByMethod; depositOut: ByMethod; depositKept: ByMethod; expenses: ByMethod };
  expectedCashCents: number;
  movements: Array<{ at: string; source: string; kind: string; method: Method; amountCents: number; signedCashCents: number; direction: number; label: string | null; by: string | null }>;
  closing: { expectedCashCents: number; countedCashCents: number; differenceCents: number; notes: string | null; at: string; by: string | null; changedSince: boolean } | null;
}
interface Expense {
  id: string;
  kind: 'expense' | 'reversal';
  category: string;
  amountCents: number;
  method: Method;
  spentOn: string;
  supplier: string | null;
  reversedBy: string | null;
  receiptFileId: string | null;
  vehicle: { id: string; plate: string } | null;
  by: string | null;
}

const todayCasa = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());

export function CashPage() {
  const branches = useApi<{ items: Branch[] }>('/branches');
  if (branches.error) return <ErrorState error={branches.error} onRetry={branches.reload} />;
  if (!branches.data) return <Loading />;
  const active = branches.data.items.filter((b) => b.isActive);
  if (!active.length) return <ErrorState error={new ApiError(403, 'forbidden', '')} />;
  return <Cash branches={active} />;
}

function Cash({ branches }: { branches: Branch[] }) {
  const { can } = useAuth();
  const { t, lang, formatDateTime } = useI18n();
  const [branchId, setBranchId] = useState(branches[0]!.id);
  const [date, setDate] = useState(todayCasa());
  const day = useApi<Day>(`/cash/day?branchId=${branchId}&date=${date}`);
  const expenses = useApi<{ items: Expense[] }>(`/cash/expenses?branchId=${branchId}&from=${date}&to=${date}`);
  const closings = useApi<{ items: Array<{ id: string; date: string; expectedCashCents: number; countedCashCents: number; differenceCents: number; by: string | null }> }>(`/cash/closings?branchId=${branchId}`);
  const [notice, setNotice] = useState<string | null>(null);
  const reloadAll = (msg?: string) => {
    day.reload();
    expenses.reload();
    closings.reload();
    if (msg) setNotice(msg);
  };
  const m = (c: number) => formatMoney(c, lang);

  const rows: Array<[MessageKey, keyof Day['totals']]> = [
    ['cash.rental', 'rental'],
    ['cash.depositIn', 'depositIn'],
    ['cash.depositOut', 'depositOut'],
    ['cash.depositKept', 'depositKept'],
    ['cash.expenses', 'expenses'],
  ];

  return (
    <section>
      <PageHeader title={t('cash.title')} subtitle={t('cash.subtitle')} />
      <div className="card filter-card">
        <div className="grid">
          {branches.length > 1 && (
            <label className="field">
              <span>{t('cash.branch')}</span>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{t('cash.date')}</span>
            <input type="date" dir="ltr" max={todayCasa()} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        </div>
      </div>
      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}
      {day.error ? (
        <ErrorState error={day.error} onRetry={day.reload} />
      ) : !day.data ? (
        <Loading />
      ) : (
        <>
          <div className="card cash-hero">
            <span className="muted small">{t('cash.expected')}</span>
            <strong className="cash-big">{m(day.data.expectedCashCents)}</strong>
            <span className="small muted">{t('cash.expectedHint')}</span>
          </div>
          <div className="card">
            <h2>{t('cash.byMethod')}</h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th />
                    {METHODS.map((x) => (
                      <th key={x}>{t(`k.method.${x}` as MessageKey)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, key]) => (
                    <tr key={key}>
                      <th scope="row">{t(label)}</th>
                      {METHODS.map((x) => (
                        <td key={x} dir="ltr">
                          {day.data!.totals[key][x] ? m(day.data!.totals[key][x]) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h2>{t('cash.movements')}</h2>
            {day.data.movements.length === 0 ? (
              <p className="muted">{t('cash.noMovements')}</p>
            ) : (
              <ul className="pay-list">
                {day.data.movements.map((x, i) => {
                  const [base, cat] = x.kind.split(':');
                  const label = base === 'reversal' ? t('mv.reversal') : base === 'expense' ? `${t('mv.expense')} · ${t(`exp.cat.${cat}` as MessageKey)}` : t(`mv.${base}` as MessageKey);
                  return (
                    <li key={i}>
                      <span>
                        <strong>{label}</strong> · {t(`k.method.${x.method}` as MessageKey)}
                        {x.label && (
                          <>
                            {' '}
                            · <bdi>{x.label}</bdi>
                          </>
                        )}
                        <span className="muted small">
                          {' '}
                          · {formatDateTime(x.at)}
                          {x.by && ` · ${x.by}`}
                        </span>
                      </span>
                      <strong className={x.direction < 0 ? 'text-danger' : ''}>
                        {x.direction < 0 ? '−\u00a0' : ''}
                        {m(x.amountCents)}
                      </strong>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <ClosingCard day={day.data} branchId={branchId} canClose={can('cash.close')} onDone={() => reloadAll(t('common.saved'))} />
        </>
      )}
      {can('expenses.record') && <ExpenseForm branchId={branchId} date={date} onDone={() => reloadAll(t('exp.saved'))} />}
      {expenses.data && expenses.data.items.length > 0 && <ExpenseList items={expenses.data.items} onChanged={() => reloadAll(t('common.saved'))} />}
      {closings.data && closings.data.items.length > 0 && (
        <div className="card">
          <h2>{t('cash.closings')}</h2>
          <ul className="plain-list">
            {closings.data.items.map((c) => (
              <li key={c.id}>
                <bdi dir="ltr">{c.date}</bdi> — {m(c.countedCashCents)} / {m(c.expectedCashCents)} ·{' '}
                <span className={c.differenceCents ? 'text-danger' : 'text-ok'}>{m(c.differenceCents)}</span>
                {c.by && <span className="muted small"> · {c.by}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ClosingCard({ day, branchId, canClose, onDone }: { day: Day; branchId: string; canClose: boolean; onDone: () => void }) {
  const { t, lang, formatDateTime } = useI18n();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = (c: number) => formatMoney(c, lang);
  if (day.closing) {
    return (
      <div className="card">
        <h2>{t('cash.close')}</h2>
        <p>{t('cash.closed', { time: formatDateTime(day.closing.at), name: day.closing.by ?? '—', counted: m(day.closing.countedCashCents), expected: m(day.closing.expectedCashCents), diff: m(day.closing.differenceCents) })}</p>
        {day.closing.notes && <p className="small">« {day.closing.notes} »</p>}
        {day.closing.changedSince && <p className="alert alert-error">{t('cash.changedSince')}</p>}
      </div>
    );
  }
  if (!canClose) return <p className="muted small">{t('cash.closeOnlyManager')}</p>;
  const c = parseMoney(counted);
  const diff = c === null || Number.isNaN(c) ? null : c - day.expectedCashCents;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/cash/close', { method: 'POST', body: { branchId, date: day.date, countedCashCents: c, notes: notes.trim() || null } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'already_closed' ? t('cash.already_closed') : t(errorKey(err)));
    }
  };
  return (
    <form className="card" onSubmit={(e) => void submit(e)} aria-label={t('cash.close')}>
      <h2>{t('cash.close')}</h2>
      <div className="grid">
        <label className="field">
          <span>{t('cash.counted')}</span>
          <input inputMode="decimal" dir="ltr" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </label>
        {diff !== null && (
          <div className="field">
            <span>{t('cash.difference')}</span>
            <strong className={diff ? 'text-danger' : 'text-ok'}>{m(diff)}</strong>
          </div>
        )}
        <label className="field field-wide">
          <span>{t('cash.notes')}</span>
          <input value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={diff === null || (diff !== 0 && !notes.trim())}>
          {t('cash.close')}
        </button>
      </div>
    </form>
  );
}

function ExpenseForm({ branchId, date, onDone }: { branchId: string; date: string; onDone: () => void }) {
  const { t } = useI18n();
  const vehicles = useApi<{ items: Vehicle[] }>(`/vehicles?branchId=${branchId}`);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('fuel');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const [vehicleId, setVehicleId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoney(amount);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const receipt = file ? await uploadFile<{ fileId: string }>('/cash/expenses/receipt', file) : null;
      await api('/cash/expenses', {
        method: 'POST',
        body: { branchId, vehicleId: vehicleId || null, category, amountCents: cents, method, spentOn: date, supplier: supplier || null, reference: reference || null, receiptFileId: receipt?.fileId ?? null },
      });
      setAmount('');
      setSupplier('');
      setReference('');
      setFile(null);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 413 || err.status === 415) ? t(uploadErrorKey(err)) : t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={(e) => void submit(e)} aria-label={t('exp.add')}>
      <h2>{t('exp.add')}</h2>
      <div className="grid">
        <label className="field">
          <span>{t('exp.category')}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`exp.cat.${c}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('exp.amount')}</span>
          <input inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('exp.method')}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {METHODS.map((x) => (
              <option key={x} value={x}>
                {t(`k.method.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('exp.vehicle')}</span>
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">—</option>
            {(vehicles.data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model} · {v.plate}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('exp.supplier')}</span>
          <input value={supplier} maxLength={120} onChange={(e) => setSupplier(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('exp.reference')}</span>
          <input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('exp.receipt')}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy || cents === null || Number.isNaN(cents) || cents <= 0}>
          {busy ? t('common.saving') : t('exp.add')}
        </button>
      </div>
    </form>
  );
}

function ExpenseList({ items, onChanged }: { items: Expense[]; onChanged: () => void }) {
  const { can } = useAuth();
  const { t, lang } = useI18n();
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reverse = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/cash/expenses/${reversing}/reverse`, { method: 'POST', body: { reason: reason.trim() } });
      setReversing(null);
      setReason('');
      onChanged();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };
  return (
    <div className="card">
      <h2>{t('cash.expenses')}</h2>
      <ul className="pay-list">
        {items.map((x) => (
          <li key={x.id} className={x.reversedBy ? 'reversed' : ''}>
            <span>
              <strong>{x.kind === 'reversal' ? t('mv.reversal') : t(`exp.cat.${x.category}` as MessageKey)}</strong> · {t(`k.method.${x.method}` as MessageKey)}
              {x.vehicle && (
                <>
                  {' '}
                  · <bdi dir="ltr">{x.vehicle.plate}</bdi>
                </>
              )}
              {x.supplier && ` · ${x.supplier}`}
              {x.by && <span className="muted small"> · {x.by}</span>}
              {x.reversedBy && <span className="badge badge-neutral">{t('exp.reversed')}</span>}
              {x.receiptFileId && (
                <a className="btn btn-small" href={`/api/cash/expenses/${x.id}/receipt`} target="_blank" rel="noopener noreferrer">
                  <Receipt size={14} aria-hidden="true" /> {t('exp.openReceipt')}
                </a>
              )}
            </span>
            <strong className={x.kind === 'reversal' ? '' : 'text-danger'}>
              {x.kind === 'reversal' ? '+ ' : '− '}
              {formatMoney(x.amountCents, lang)}
            </strong>
            {can('payments.reverse') && x.kind === 'expense' && !x.reversedBy && reversing !== x.id && (
              <button type="button" className="btn btn-small" onClick={() => setReversing(x.id)}>
                {t('exp.reverse')}
              </button>
            )}
            {reversing === x.id && (
              <form className="transition-form" onSubmit={(e) => void reverse(e)}>
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
                    {t('exp.reverse')}
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
