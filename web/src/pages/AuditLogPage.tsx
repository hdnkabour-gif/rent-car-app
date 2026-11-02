import { useState } from 'react';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { Empty, ErrorState, Loading } from '../components/States';
import { useApi } from '../useApi';

interface AuditItem {
  id: number;
  occurredAt: string;
  actor: { id: string; fullName: string | null } | null;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  targetType: string | null;
  targetId: string | null;
}

interface AuditPage {
  items: AuditItem[];
  nextBefore: number | null;
}

export function AuditLogPage() {
  const { t, formatDateTime } = useI18n();
  const first = useApi<AuditPage>('/audit-logs?limit=50');
  const [more, setMore] = useState<{ base: AuditPage; items: AuditItem[]; nextBefore: number | null } | null>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  if (first.error && !first.data) return <ErrorState error={first.error} onRetry={first.reload} />;
  if (!first.data) return <Loading />;

  // Extra pages belong to the first page they were loaded from; a reload discards them.
  const extra = more && more.base === first.data ? more : null;
  const items = [...first.data.items, ...(extra?.items ?? [])];
  const nextBefore = extra ? extra.nextBefore : first.data.nextBefore;
  const error = moreError;

  const loadMore = async () => {
    if (!nextBefore || !first.data) return;
    setLoadingMore(true);
    try {
      const res = await api<AuditPage>(`/audit-logs?limit=50&before=${nextBefore}`);
      setMore({ base: first.data, items: [...(extra?.items ?? []), ...res.items], nextBefore: res.nextBefore });
      setMoreError(null);
    } catch (err) {
      setMoreError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section>
      <h1>{t('audit.title')}</h1>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>{t('audit.when')}</th>
                <th>{t('audit.actor')}</th>
                <th>{t('audit.action')}</th>
                <th>{t('audit.outcome')}</th>
                <th>{t('audit.target')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{formatDateTime(i.occurredAt)}</td>
                  <td>{i.actor?.fullName ?? t('audit.system')}</td>
                  <td dir="ltr">
                    <code>{i.action}</code>
                  </td>
                  <td>
                    <span className={`badge badge-${i.outcome}`}>{t(`audit.outcome.${i.outcome}` as MessageKey)}</span>
                  </td>
                  <td dir="ltr">{i.targetType ? `${i.targetType}${i.targetId ? ` · ${i.targetId.slice(0, 8)}` : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error !== null && <ErrorState error={error} />}
      {nextBefore && (
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {t('audit.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}
