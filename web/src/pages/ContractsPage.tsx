import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileText, Search } from 'lucide-react';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { Empty, ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { Plate } from '../components/Plate';
import { formatMoney } from '../reservations';
import type { Contract } from '../contracts';

const VIEWS = ['open', 'late', 'late_fee', 'closed'] as const;

export function ContractList({ query }: { query: string }) {
  const { t, lang, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<{ items: Contract[] }>(`/contracts?${query}`);
  const [now] = useState(() => Date.now());
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (!data.items.length) return <Empty messageKey="k.none" />;
  return (
    <ul className="vehicle-grid">
      {data.items.map((k) => {
        const late = k.status === 'open' && new Date(k.plannedEndAt).getTime() < now;
        return (
          <li key={k.id}>
            <Link to={`/contracts/${k.id}`} className="vehicle-card">
              <div className="vehicle-card-top">
                <span className="vehicle-icon" aria-hidden="true">
                  <FileText size={22} />
                </span>
                <div className="vehicle-names">
                  <strong>
                    <bdi dir="ltr">{k.reference}</bdi>
                    {k.paperNumber && (
                      <span className="muted">
                        {' '}
                        (<bdi dir="ltr">{k.paperNumber}</bdi>)
                      </span>
                    )}{' '}
                    · {k.customer.fullName}
                  </strong>
                  <span className="small">
                    {k.vehicle.make} {k.vehicle.model} <Plate value={k.vehicle.plate} />
                  </span>
                </div>
                <span className={`badge ${late ? 'badge-failure' : k.status === 'open' ? 'badge-info' : 'badge-neutral'}`}>
                  {late ? t('k.late') : t(`k.status.${k.status}` as MessageKey)}
                </span>
              </div>
              <div className="vehicle-card-meta muted small">
                <span>
                  {formatDateTime(k.outAt)} → {formatDateTime(k.inAt ?? k.plannedEndAt)}
                </span>
                <strong>{formatMoney(k.totalCents, lang)}</strong>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ContractsPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(params.get('q') ?? '');
  const view = (VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as (typeof VIEWS)[number]) : 'open';
  const q = params.get('q') ?? '';
  const query = new URLSearchParams({ status: q ? 'all' : view });
  if (q) query.set('q', q);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <section>
      <PageHeader title={t('k.title')} subtitle={t('k.subtitle')} />
      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', typed.trim());
        }}
      >
        <Search size={20} aria-hidden="true" />
        <input
          type="search"
          value={typed}
          placeholder={t('k.search')}
          aria-label={t('k.search')}
          onChange={(e) => {
            setTyped(e.target.value);
            if (e.target.value === '') set('q', '');
          }}
        />
      </form>
      {!q && (
        <div className="filter-row">
          <div className="chips" role="group" aria-label={t('k.title')}>
            {VIEWS.map((v) => (
              <button key={v} type="button" aria-pressed={view === v} className={`chip-btn${view === v ? ' active' : ''}`} onClick={() => set('view', v === 'open' ? '' : v)}>
                {t(`k.view.${v}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
      )}
      <ContractList query={query.toString()} />
    </section>
  );
}
