import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Phone, Plus, Search, UserRound } from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { Empty, ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import type { Customer } from '../customers';

const FILTERS = ['pending_documents', 'expired_documents', 'blocked'] as const;

/** Status chips shared by the list and the customer card. */
export function CustomerBadges({ c }: { c: Customer }) {
  const { t } = useI18n();
  return (
    <>
      {c.blocked && <span className="badge badge-failure">{t('customers.blocked')}</span>}
      {c.idDocStatus === 'expired' || c.idDocStatus === 'expiring' ? (
        <span className={`badge ${c.idDocStatus === 'expired' ? 'badge-failure' : 'badge-warning'}`}>{t(`customers.idStatus.${c.idDocStatus}` as MessageKey)}</span>
      ) : null}
      {c.licenceStatus === 'expired' || c.licenceStatus === 'expiring' ? (
        <span className={`badge ${c.licenceStatus === 'expired' ? 'badge-failure' : 'badge-warning'}`}>
          {t(`customers.licenceStatus.${c.licenceStatus}` as MessageKey)}
        </span>
      ) : null}
      {c.pendingDocuments > 0 && <span className="badge badge-info">{t('customers.pendingDocs', { n: String(c.pendingDocuments) })}</span>}
    </>
  );
}

export function CustomersPage() {
  const { can, me } = useAuth();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const filter = params.get('filter') ?? '';
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (filter) query.set('filter', filter);
  const list = useApi<{ items: Customer[] }>(`/customers?${query.toString()}`);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <section>
      <PageHeader
        title={t('customers.title')}
        subtitle={t('customers.subtitle')}
        actions={
          <>
            {can('customers.manage') && <Link to="/customers/new" className="btn btn-primary">
              <Plus size={18} aria-hidden="true" /> {t('customers.add')}
            </Link>}
            {me?.user.role === 'manager' && <Link to="/customer-merges" className="btn">
              {t('merge.title')}
            </Link>}
          </>
        }
      />
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
          placeholder={t('customers.search')}
          aria-label={t('customers.search')}
          onChange={(e) => {
            setTyped(e.target.value);
            if (e.target.value === '') set('q', '');
          }}
        />
      </form>
      <div className="filter-row">
        <div className="chips" role="group" aria-label={t('customers.title')}>
          <button type="button" aria-pressed={filter === ''} className={`chip-btn${filter === '' ? ' active' : ''}`} onClick={() => set('filter', '')}>
            {t('customers.filter.all')}
          </button>
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} className={`chip-btn${filter === f ? ' active' : ''}`} onClick={() => set('filter', filter === f ? '' : f)}>
              {t(`customers.filter.${f}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>
      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.items.length === 0 ? (
        <Empty messageKey="customers.none" />
      ) : (
        <ul className="vehicle-grid">
          {list.data.items.map((c) => (
            <li key={c.id}>
              <Link to={`/customers/${c.id}`} className="vehicle-card">
                <div className="vehicle-card-top">
                  <span className="vehicle-icon" aria-hidden="true">
                    <UserRound size={22} />
                  </span>
                  <div className="vehicle-names">
                    <strong>{c.fullName}</strong>
                    <span className="muted small">
                      <Phone size={14} aria-hidden="true" /> <bdi dir="ltr">{c.phone}</bdi>
                    </span>
                  </div>
                </div>
                <div className="vehicle-card-meta muted small">
                  <span>{t(`customers.residence.${c.residence}` as MessageKey)}</span>
                  {c.idDocType && (
                    <span>
                      {t(`customers.idDocType.${c.idDocType}` as MessageKey)}
                      {c.idDocNumber && (
                        <>
                          {' '}
                          <bdi dir="ltr">{c.idDocNumber}</bdi>
                        </>
                      )}
                    </span>
                  )}
                  {c.city && <span>{c.city}</span>}
                </div>
                <div className="person-tags">
                  <CustomerBadges c={c} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
