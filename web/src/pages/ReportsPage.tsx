import { useState } from 'react';
import { Download } from 'lucide-react';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { Plate } from '../components/Plate';
import { formatMoney } from '../reservations';
import type { Branch } from '../vehicles';

interface Summary {
  income: { rentalByMethod: Record<string, number>; rentalCents: number; depositKeptCents: number; totalCents: number };
  deposits: { receivedCents: number; returnedCents: number; keptCents: number };
  expenses: { byCategory: Record<string, number>; totalCents: number };
  resultCents: number;
  contracts: { count: number; days: number; billedCents: number; lateFeesCents: number; outstandingCents: number };
  reservations: { created: number; cancelled: number; no_show: number };
  fleet: Array<{ id: string; plate: string; make: string; model: string; utilisation: number; revenueCents: number }>;
}

const casa = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(d);

export function ReportsPage() {
  const { t, lang } = useI18n();
  const now = new Date();
  const [from, setFrom] = useState(`${casa(now).slice(0, 8)}01`);
  const [to, setTo] = useState(casa(now));
  const [branchId, setBranchId] = useState('');
  const branches = useApi<{ items: Branch[] }>('/branches');
  const q = `from=${from}&to=${to}${branchId ? `&branchId=${branchId}` : ''}`;
  const { data, error, reload } = useApi<Summary>(from <= to ? `/reports/summary?${q}` : null);
  const m = (c: number) => formatMoney(c, lang);
  return (
    <section>
      <PageHeader title={t('rp.title')} subtitle={t('rp.subtitle')} />
      <div className="card">
        <div className="grid">
          <label className="field">
            <span>{t('rp.from')}</span>
            <input type="date" dir="ltr" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('rp.to')}</span>
            <input type="date" dir="ltr" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </label>
          {branches.data && branches.data.items.length > 1 && (
            <label className="field">
              <span>{t('cash.branch')}</span>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">{t('vehicles.allBranches')}</option>
                {branches.data.items.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="doc-actions">
          <span className="small muted">{t('rp.export')} :</span>
          <a className="btn btn-small" href={`/api/reports/export.csv?type=payments&${q}`} download>
            <Download size={16} aria-hidden="true" /> {t('rp.exportPayments')}
          </a>
          <a className="btn btn-small" href={`/api/reports/export.csv?type=expenses&${q}`} download>
            <Download size={16} aria-hidden="true" /> {t('rp.exportExpenses')}
          </a>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <ul className="fleet-tiles report-tiles">
            <li className="fleet-tile tile-available">
              <strong>{m(data.income.totalCents)}</strong>
              <span>{t('rp.income')}</span>
            </li>
            <li className="fleet-tile tile-out_of_service">
              <strong>{m(data.expenses.totalCents)}</strong>
              <span>{t('rp.expenses')}</span>
            </li>
            <li className="fleet-tile tile-rented">
              <strong>{m(data.resultCents)}</strong>
              <span>{t('rp.result')}</span>
            </li>
            <li className="fleet-tile tile-inspection_pending">
              <strong>{m(data.contracts.outstandingCents)}</strong>
              <span>{t('rp.outstanding')}</span>
            </li>
          </ul>
          <div className="card">
            <h2>{t('rp.income')}</h2>
            <dl className="detail-grid">
              <div>
                <dt>{t('rp.rental')}</dt>
                <dd>
                  {m(data.income.rentalCents)}
                  <div className="small muted">
                    {Object.entries(data.income.rentalByMethod)
                      .map(([k, v]) => `${t(`k.method.${k}` as MessageKey)} ${m(v)}`)
                      .join(' · ')}
                  </div>
                </dd>
              </div>
              <div>
                <dt>{t('rp.kept')}</dt>
                <dd>{m(data.income.depositKeptCents)}</dd>
              </div>
              <div>
                <dt>{t('rp.contracts')}</dt>
                <dd>
                  {t('rp.contractsCount', { n: String(data.contracts.count), d: String(data.contracts.days) })}
                  <div className="small muted">
                    {t('rp.billed')} {m(data.contracts.billedCents)} · {t('rp.lateFees')} {m(data.contracts.lateFeesCents)}
                  </div>
                </dd>
              </div>
            </dl>
            <p className="small">{t('rp.reservations', { n: String(data.reservations.created), c: String(data.reservations.cancelled), s: String(data.reservations.no_show) })}</p>
          </div>
          <div className="card">
            <h2>{t('rp.deposits')}</h2>
            <dl className="detail-grid">
              <div>
                <dt>{t('rp.received')}</dt>
                <dd>{m(data.deposits.receivedCents)}</dd>
              </div>
              <div>
                <dt>{t('rp.returned')}</dt>
                <dd>{m(data.deposits.returnedCents)}</dd>
              </div>
              <div>
                <dt>{t('rp.kept')}</dt>
                <dd>{m(data.deposits.keptCents)}</dd>
              </div>
            </dl>
          </div>
          {Object.keys(data.expenses.byCategory).length > 0 && (
            <div className="card">
              <h2>{t('rp.expenses')}</h2>
              <dl className="detail-grid">
                {Object.entries(data.expenses.byCategory).map(([k, v]) => (
                  <div key={k}>
                    <dt>{t(`exp.cat.${k}` as MessageKey)}</dt>
                    <dd>{m(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="card">
            <h2>{t('rp.fleet')}</h2>
            <ul className="util-list">
              {data.fleet.map((v) => (
                <li key={v.id}>
                  <span className="util-name">
                    {v.make} {v.model} <Plate value={v.plate} />
                  </span>
                  <span className="util-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(v.utilisation * 100)}%` }} />
                  </span>
                  <span className="util-pct" dir="ltr">
                    {Math.round(v.utilisation * 100)} %
                  </span>
                  <span className="small muted">{m(v.revenueCents)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
