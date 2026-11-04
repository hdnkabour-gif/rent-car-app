import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Check, FileText, Pencil, Phone, Upload, X } from 'lucide-react';
import { api, uploadFile } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { DOC_FILE_ACCEPT, uploadErrorKey } from '../components/VehicleDocuments';
import { CustomerBadges } from './CustomersPage';
import { CUSTOMER_DOC_KINDS, type Customer, type CustomerDocKind, type CustomerDocument } from '../customers';

const ageFrom = (birth: string) => {
  const [y, m, d] = birth.split('-').map(Number) as [number, number, number];
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age;
};

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { t, formatDate, formatDateTime } = useI18n();
  const { data, error, reload } = useApi<{ customer: Customer }>(`/customers/${id}`);
  const [blocking, setBlocking] = useState(false);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const c = data.customer;

  const ltr = (v: string | null) => (v ? <bdi dir="ltr">{v}</bdi> : null);
  const date = (v: string | null) => (v ? formatDate(v) : null);
  const sections: Array<[MessageKey, Array<[MessageKey, ReactNode]>]> = [
    [
      'customers.section.identity',
      [
        ['customers.type', t(`customers.type.${c.customerType}` as MessageKey)],
        ['customers.companyIce', ltr(c.companyIce)],
        ['customers.contactPerson', c.contactPerson],
        ['customers.birthDate', c.birthDate ? `${formatDate(c.birthDate)} · ${t('customers.age', { n: String(ageFrom(c.birthDate)) })}` : null],
        ['customers.nationality', c.nationality],
        ['customers.residence', t(`customers.residence.${c.residence}` as MessageKey)],
      ],
    ],
    [
      'customers.section.contact',
      [
        ['customers.phone2', ltr(c.phone2)],
        ['customers.email', ltr(c.email)],
        ['customers.address', c.address],
        ['customers.city', c.city],
        ['customers.country', c.country],
        ['customers.language', t(`customers.lang.${c.preferredLanguage}` as MessageKey)],
      ],
    ],
    [
      'customers.section.idDoc',
      [
        ['customers.idDocType', c.idDocType ? t(`customers.idDocType.${c.idDocType}` as MessageKey) : null],
        ['customers.idDocNumber', ltr(c.idDocNumber)],
        ['customers.idDocCountry', c.idDocCountry],
        ['customers.idDocExpiry', date(c.idDocExpiry)],
      ],
    ],
    [
      'customers.section.licence',
      [
        ['customers.licenceNumber', ltr(c.licenceNumber)],
        ['customers.licenceCategory', c.licenceCategory],
        ['customers.licenceCountry', c.licenceCountry],
        ['customers.licenceIssueDate', date(c.licenceIssueDate)],
        ['customers.licenceExpiry', date(c.licenceExpiry)],
      ],
    ],
  ];

  return (
    <section>
      <Link to="/customers" className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('customers.back')}
      </Link>

      <div className="vehicle-hero card">
        <div>
          <h1>{c.fullName}</h1>
          <p className="customer-phone">
            <a href={`tel:+${c.phoneKey}`} className="btn btn-small">
              <Phone size={16} aria-hidden="true" /> {t('customers.call')}
            </a>{' '}
            <bdi dir="ltr">{c.phone}</bdi>
          </p>
        </div>
        <div className="vehicle-hero-side person-tags">
          <CustomerBadges c={c} />
        </div>
      </div>

      {c.blocked && (
        <div className="alert alert-error" role="alert">
          <strong>{t('customers.blocked')}</strong> — {t('customers.blockedBy', { reason: c.blocked.reason, name: c.blocked.by ?? '—' })} · {formatDateTime(c.blocked.at)}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>{t('customers.card')}</h2>
          <div className="doc-actions">
            {can('customers.manage') && (
              <Link to={`/customers/${c.id}/edit`} className="btn btn-small">
                <Pencil size={16} aria-hidden="true" /> {t('customers.edit')}
              </Link>
            )}
            {can('customers.block') && !blocking && (
              <button type="button" className={`btn btn-small${c.blocked ? '' : ' btn-danger-outline'}`} onClick={() => setBlocking(true)}>
                <Ban size={16} aria-hidden="true" /> {c.blocked ? t('customers.unblock') : t('customers.block')}
              </button>
            )}
          </div>
        </div>
        {blocking && (
          <BlockForm
            customer={c}
            onClose={() => setBlocking(false)}
            onDone={() => {
              setBlocking(false);
              reload();
            }}
          />
        )}
        {sections.map(([title, rows]) => {
          const shown = rows.filter(([, v]) => v);
          if (!shown.length) return null;
          return (
            <div key={title} className="detail-section">
              <h3>{t(title)}</h3>
              <dl className="detail-grid">
                {shown.map(([label, value]) => (
                  <div key={label}>
                    <dt>{t(label)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
        {c.notes && (
          <div className="detail-section">
            <h3>{t('customers.notes')}</h3>
            <p className="pre-wrap">{c.notes}</p>
          </div>
        )}
        <p className="muted small">{t('customers.createdBy', { date: formatDateTime(c.createdAt), name: c.createdBy ?? '—' })}</p>
      </div>

      <CustomerDocuments customerId={c.id} onChanged={reload} />

      <div className="card">
        <p className="muted">{t('customers.rentalsSoon')}</p>
      </div>
    </section>
  );
}

function BlockForm({ customer, onClose, onDone }: { customer: Customer; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/customers/${customer.id}/${customer.blocked ? 'unblock' : 'block'}`, { method: 'POST', body: { reason: reason.trim() } });
      onDone();
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };
  return (
    <form className="transition-form" onSubmit={submit}>
      <label className="field">
        <span>{t('customers.blockReason')}</span>
        <textarea rows={2} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
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
        <button type="submit" className={`btn ${customer.blocked ? 'btn-primary' : 'btn-danger'}`} disabled={busy || reason.trim().length < 3}>
          {customer.blocked ? t('customers.unblock') : t('customers.block')}
        </button>
      </div>
    </form>
  );
}

const REVIEW_BADGE: Record<CustomerDocument['reviewStatus'], string> = { pending: 'badge-warning', verified: 'badge-success', rejected: 'badge-failure' };

/** Scans of identity papers. Every scan starts "to check"; an authorized person verifies or rejects it. */
function CustomerDocuments({ customerId, onChanged }: { customerId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, reload } = useApi<{ items: CustomerDocument[] }>(`/customers/${customerId}/documents${showArchived ? '?includeArchived=true' : ''}`);
  const [kind, setKind] = useState<CustomerDocKind>('id_front');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; warn: boolean } | null>(null);
  const canAdd = can('customers.manage');

  const refresh = () => {
    reload();
    onChanged();
  };

  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await uploadFile<CustomerDocument & { alsoLinkedTo: Array<{ fullName: string }> }>(`/customers/${customerId}/documents?kind=${kind}`, file);
      setMessage(
        res.alsoLinkedTo.length
          ? { text: t('customers.docs.alsoLinked', { names: res.alsoLinkedTo.map((o) => o.fullName).join(', ') }), warn: true }
          : { text: t('common.saved'), warn: false },
      );
      refresh();
    } catch (err) {
      setMessage({ text: t(uploadErrorKey(err)), warn: true });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="card" id="documents">
      <div className="card-head">
        <div>
          <h2>{t('customers.docs.title')}</h2>
          <p className="muted small">{t('customers.docs.hint')}</p>
        </div>
      </div>
      {canAdd && (
        <div className="upload-row">
          <label className="field">
            <span>{t('customers.docs.kind')}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as CustomerDocKind)}>
              {CUSTOMER_DOC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`customers.docs.kind.${k}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
            <Upload size={18} aria-hidden="true" /> {busy ? t('common.saving') : t('customers.docs.add')}
          </button>
          <input ref={input} type="file" accept={DOC_FILE_ACCEPT} hidden aria-label={t('customers.docs.add')} onChange={(e) => void send(e.target.files?.[0])} />
        </div>
      )}
      {message && (
        <div className={`alert ${message.warn ? 'alert-error' : 'alert-ok'}`} role={message.warn ? 'alert' : 'status'}>
          {message.text}
        </div>
      )}
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <p className="muted">{t('customers.docs.none')}</p>
      ) : (
        <ul className="doc-list">
          {data.items.map((d) => (
            <CustomerDocItem key={d.id} customerId={customerId} doc={d} onChanged={refresh} />
          ))}
        </ul>
      )}
      <label className="check small">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        {t('customers.docs.showArchived')}
      </label>
    </div>
  );
}

function CustomerDocItem({ customerId, doc: d, onChanged }: { customerId: string; doc: CustomerDocument; onChanged: () => void }) {
  const { can } = useAuth();
  const { t, formatDateTime } = useI18n();
  const [mode, setMode] = useState<'reject' | 'archive' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/customers/${customerId}/files/${d.file.id}`;
  const archived = Boolean(d.archivedAt);

  const call = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/customers/${customerId}/documents/${d.id}/${path}`, { method: 'POST', body });
      setMode(null);
      setText('');
      onChanged();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const status = t(`customers.docs.status.${d.reviewStatus}` as MessageKey);
  return (
    <li className={`doc-item doc-review-${d.reviewStatus}${archived ? ' doc-archived' : ''}`}>
      <a className="doc-thumb" href={url} target="_blank" rel="noopener noreferrer" aria-label={t('docs.open')}>
        {d.file.mimeType.startsWith('image/') ? <img src={url} alt="" loading="lazy" /> : <FileText size={26} aria-hidden="true" />}
      </a>
      <div className="doc-body">
        <div className="doc-head">
          <strong>{t(`customers.docs.kind.${d.kind}` as MessageKey)}</strong>
          <span className={`badge ${archived ? 'badge-neutral' : REVIEW_BADGE[d.reviewStatus]}`}>{archived ? t('docs.status.archived') : status}</span>
        </div>
        <div className="muted small">{t('customers.docs.uploaded', { date: formatDateTime(d.createdAt), name: d.createdBy ?? '—' })}</div>
        {d.reviewedBy && <div className="small">{t('customers.docs.reviewedBy', { status, name: d.reviewedBy })}</div>}
        {d.reviewNote && <div className="small">« {d.reviewNote} »</div>}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        {mode ? (
          <form
            className="transition-form"
            onSubmit={(e) => {
              e.preventDefault();
              void (mode === 'reject' ? call('review', { status: 'rejected', note: text.trim() }) : call('archive', { reason: text.trim() }));
            }}
          >
            <label className="field">
              <span>{mode === 'reject' ? t('customers.docs.rejectReason') : t('customers.docs.archiveReason')}</span>
              <input required value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setMode(null)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-danger" disabled={busy || !text.trim()}>
                {mode === 'reject' ? t('customers.docs.reject') : t('customers.docs.remove')}
              </button>
            </div>
          </form>
        ) : (
          <div className="doc-actions">
            <a className="btn btn-small" href={url} target="_blank" rel="noopener noreferrer">
              <FileText size={16} aria-hidden="true" /> {t('docs.open')}
            </a>
            {!archived && can('customers.verify') && d.reviewStatus !== 'verified' && (
              <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void call('review', { status: 'verified' })}>
                <Check size={16} aria-hidden="true" /> {t('customers.docs.verify')}
              </button>
            )}
            {!archived && can('customers.verify') && d.reviewStatus !== 'rejected' && (
              <button type="button" className="btn btn-small" onClick={() => setMode('reject')}>
                <X size={16} aria-hidden="true" /> {t('customers.docs.reject')}
              </button>
            )}
            {!archived && can('customers.manage') && (
              <button type="button" className="btn btn-small" onClick={() => setMode('archive')}>
                {t('customers.docs.remove')}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
