import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';

interface Reminder {
  kind: 'pickup' | 'return' | 'customer_document';
  refId: string;
  reference: string;
  at: string;
  late?: boolean;
  customer: { id: string; fullName: string; phone: string; language: string };
  text: string;
  link: string;
  lastSentAt: string | null;
}

/** D-016: the message is prepared; the employee checks it, opens WhatsApp and sends it himself. */
export function RemindersPage() {
  const { t, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<{ items: Reminder[] }>('/reminders');
  const [failure, setFailure] = useState<string | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const confirm = async (r: Reminder) => {
    setFailure(null);
    try {
      await api('/reminders/sent', { method: 'POST', body: { kind: r.kind, refId: r.refId } });
      reload();
    } catch (err) {
      setFailure(t(errorKey(err)));
    }
  };
  return (
    <section>
      <PageHeader title={t('rm.title')} subtitle={t('rm.subtitle')} />
      {failure && <div className="alert alert-error">{failure}</div>}
      {data.items.length === 0 ? (
        <p className="muted">{t('rm.none')}</p>
      ) : (
        <ul className="doc-list">
          {data.items.map((r) => (
            <li key={`${r.kind}-${r.refId}`} className="card reminder-card">
              <div className="doc-head">
                <span className="badge badge-info">{t(`rm.kind.${r.kind}` as MessageKey)}</span>
                <strong>{r.customer.fullName}</strong> <bdi dir="ltr">{r.customer.phone}</bdi>
                <span className="muted small">
                  <bdi dir="ltr">{r.reference}</bdi> · {formatDateTime(r.at)}
                </span>
                {r.late && <span className="badge badge-failure">{t('rm.late')}</span>}
              </div>
              <p className="reminder-text" dir={r.customer.language === 'ar' ? 'rtl' : 'ltr'} lang={r.customer.language}>
                {r.text}
              </p>
              <div className="doc-actions">
                <a className="btn btn-primary btn-small" href={r.link} target="_blank" rel="noopener noreferrer">
                  <MessageCircle size={16} aria-hidden="true" /> {t('rm.open')}
                </a>
                <button type="button" className="btn btn-small" onClick={() => void confirm(r)}>
                  {t('rm.confirm')}
                </button>
                {r.lastSentAt && <span className="small text-ok">{t('rm.sentAt', { time: formatDateTime(r.lastSentAt) })}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
