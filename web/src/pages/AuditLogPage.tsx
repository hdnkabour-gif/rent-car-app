import { useState } from 'react';
import { Building2, KeyRound, LogIn, LogOut, ShieldAlert, UserCog, UserPlus, UserX, Activity, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { Empty, ErrorState, Loading } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { useApi } from '../useApi';

interface AuditItem {
  id: number;
  occurredAt: string;
  actor: { id: string; fullName: string | null } | null;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
}

interface AuditPage {
  items: AuditItem[];
  nextBefore: number | null;
}

const ICONS: Record<string, LucideIcon> = {
  'auth.login': LogIn,
  'auth.logout': LogOut,
  'auth.logout_all': LogOut,
  'auth.password_change': KeyRound,
  'authz.denied': ShieldAlert,
  'user.create': UserPlus,
  'user.update': UserCog,
  'user.deactivate': UserX,
  'user.password_reset': KeyRound,
  'company_settings.update': Building2,
};

export function AuditLogPage() {
  const { t, has, formatDateTime } = useI18n();
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

  const actionLabel = (a: string) => {
    const key = `audit.action.${a}`;
    return has(key) ? t(key) : t('audit.action.other');
  };
  const targetLabel = (i: AuditItem) => {
    if (i.targetType === 'user') return i.targetName ? t('audit.target.user', { name: i.targetName }) : t('audit.target.userUnknown');
    if (i.targetType === 'company_settings') return t('audit.target.company_settings');
    if (['vehicle', 'branch', 'customer', 'reservation', 'contract', 'contract_template'].includes(i.targetType ?? '')) {
      const base = t(`audit.target.${i.targetType}` as MessageKey);
      return i.targetName ? `${base} : ${i.targetName}` : base;
    }
    return null;
  };
  const actorLabel = (i: AuditItem) =>
    i.actor ? (i.actor.fullName ?? t('audit.unknownPerson')) : i.action === 'auth.login' ? t('audit.unknownPerson') : t('audit.system');

  return (
    <section>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      {items.length === 0 ? (
        <Empty />
      ) : (
        <ul className="activity-list card">
          {items.map((i) => {
            const Icon = ICONS[i.action] ?? Activity;
            const target = targetLabel(i);
            return (
              <li key={i.id} className="activity-item">
                <span className={`activity-icon outcome-${i.outcome}`} aria-hidden="true">
                  <Icon size={18} strokeWidth={1.9} />
                </span>
                <div className="activity-body">
                  <div className="activity-title">
                    <strong>{actionLabel(i.action)}</strong>
                    <span className={`badge badge-${i.outcome}`}>{t(`audit.outcome.${i.outcome}` as MessageKey)}</span>
                  </div>
                  <div className="activity-meta muted small">
                    <span>{actorLabel(i)}</span>
                    {target && <span>· {target}</span>}
                  </div>
                </div>
                <time className="activity-time muted small" dateTime={i.occurredAt}>
                  {formatDateTime(i.occurredAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      {moreError !== null && <ErrorState error={moreError} />}
      {nextBefore && (
        <div className="actions center">
          <button type="button" className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
            {t('audit.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}
