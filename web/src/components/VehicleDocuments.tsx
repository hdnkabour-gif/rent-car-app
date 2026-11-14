import { useRef, useState, type FormEvent } from 'react';
import { Archive, FilePlus2, FileText, Paperclip, Pencil, X } from 'lucide-react';
import { api, ApiError, uploadFile } from '../api';
import { useAuth } from '../auth';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from './States';
import { DOC_TYPES, type DocType, type VehicleDocument } from '../vehicles';
import { DocumentOcrReview } from './DocumentOcrReview';

export const DOC_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

/** Maps upload errors (wrong type, too big) to a clear message; anything else uses the common keys. */
export function uploadErrorKey(err: unknown): MessageKey {
  if (err instanceof ApiError) {
    if (err.status === 415) return 'files.unsupported';
    if (err.status === 413) return 'files.tooLarge';
  }
  return errorKey(err);
}

const STATUS_BADGE: Record<VehicleDocument['status'], string> = {
  valid: 'badge-success',
  expiring: 'badge-warning',
  expired: 'badge-failure',
  no_expiry: 'badge-neutral',
  archived: 'badge-neutral',
};

export const fileUrl = (vehicleId: string, fileId: string) => `/api/vehicles/${vehicleId}/files/${fileId}`;

export function docTitle(d: Pick<VehicleDocument, 'docType' | 'label'>, t: (k: MessageKey) => string) {
  return d.docType === 'other' && d.label ? d.label : t(`docs.type.${d.docType}` as MessageKey);
}

/** Vehicle documents (registration card, insurance, inspection...) with expiry status and scan. */
export function VehicleDocuments({ vehicleId, readOnly, onChanged }: { vehicleId: string; readOnly: boolean; onChanged?: () => void }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, reload } = useApi<{ items: VehicleDocument[] }>(
    `/vehicles/${vehicleId}/documents${showArchived ? '?includeArchived=true' : ''}`,
  );
  const [editing, setEditing] = useState<VehicleDocument | 'new' | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn?: boolean } | null>(null);
  const canEdit = can('vehicles.documents') && !readOnly;

  const changed = (text: string, warn = false) => {
    setEditing(null);
    setNotice({ text, warn });
    reload();
    onChanged?.();
  };

  return (
    <div className="card" id="documents">
      <div className="card-head">
        <div>
          <h2>{t('docs.title')}</h2>
          <p className="muted small">{t('docs.hint')}</p>
        </div>
        {canEdit && editing === null && (
          <button type="button" className="btn btn-small" onClick={() => (setNotice(null), setEditing('new'))}>
            <FilePlus2 size={16} aria-hidden="true" /> {t('docs.add')}
          </button>
        )}
      </div>
      {notice && (
        <div className={`alert ${notice.warn ? 'alert-error' : 'alert-ok'}`} role={notice.warn ? 'alert' : 'status'}>
          {notice.text}
        </div>
      )}
      {editing === 'new' && <DocForm vehicleId={vehicleId} onCancel={() => setEditing(null)} onSaved={changed} />}
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <p className="muted">{t('docs.none')}</p>
      ) : (
        <ul className="doc-list">
          {data.items.map((d) =>
            editing !== null && editing !== 'new' && editing.id === d.id ? (
              <li key={d.id}>
                <DocForm vehicleId={vehicleId} doc={d} onCancel={() => setEditing(null)} onSaved={changed} />
              </li>
            ) : (
              <DocItem key={d.id} vehicleId={vehicleId} doc={d} canEdit={canEdit && d.status !== 'archived'} onEdit={() => (setNotice(null), setEditing(d))} onChanged={changed} />
            ),
          )}
        </ul>
      )}
      <label className="check small">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        {t('docs.showArchived')}
      </label>
    </div>
  );
}

function DocItem({
  vehicleId,
  doc: d,
  canEdit,
  onEdit,
  onChanged,
}: {
  vehicleId: string;
  doc: VehicleDocument;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: (msg: string) => void;
}) {
  const { t, formatDate } = useI18n();
  const { me } = useAuth();
  const [showVerification,setShowVerification] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState('');

  const attach = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadFile(`/vehicles/${vehicleId}/documents/${d.id}/file`, file, { method: 'PUT' });
      onChanged(t('common.saved'));
    } catch (err) {
      setError(t(uploadErrorKey(err)));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const archive = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/vehicles/${vehicleId}/documents/${d.id}/archive`, { method: 'POST', body: { reason: reason.trim() } });
      onChanged(t('docs.archived'));
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };

  const when =
    d.expiryDate &&
    (d.daysLeft !== null && d.status !== 'archived'
      ? `${t('docs.expires', { date: formatDate(d.expiryDate) })} · ${
          d.daysLeft >= 0 ? t('docs.daysLeft', { n: String(d.daysLeft) }) : t('docs.daysAgo', { n: String(-d.daysLeft) })
        }`
      : t('docs.expires', { date: formatDate(d.expiryDate) }));

  return (
    <li className={`doc-item doc-${d.status}`}>
      <span className="doc-icon" aria-hidden="true">
        <FileText size={20} />
      </span>
      <div className="doc-body">
        <div className="doc-head">
          <strong>{docTitle(d, t)}</strong>
          <span className={`badge ${STATUS_BADGE[d.status]}`}>{t(`docs.status.${d.status}` as MessageKey)}</span>
        </div>
        {when && <div className="small">{when}</div>}
        <div className="muted small doc-meta">
          {d.number && (
            <span>
              {t('docs.number')} : <bdi dir="ltr">{d.number}</bdi>
            </span>
          )}
          {d.issuer && <span>{d.issuer}</span>}
          {d.issueDate && <span>{`${t('docs.issueDate')} : ${formatDate(d.issueDate)}`}</span>}
        </div>
        {d.notes && <div className="small muted">{d.notes}</div>}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        {archiving ? (
          <form className="transition-form" onSubmit={archive}>
            <label className="field">
              <span>{t('docs.archiveReason')}</span>
              <input required value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setArchiving(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-danger" disabled={busy || !reason.trim()}>
                {t('docs.archive')}
              </button>
            </div>
          </form>
        ) : (
          <div className="doc-actions">
            {d.file && (
              <a className="btn btn-small" href={fileUrl(vehicleId, d.file.id)} target="_blank" rel="noopener noreferrer">
                <FileText size={16} aria-hidden="true" /> {t('docs.open')}
              </a>
            )}
            {canEdit && (
              <>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
                  <Paperclip size={16} aria-hidden="true" /> {busy ? t('common.saving') : d.file ? t('docs.replaceFile') : t('docs.attach')}
                </button>
                <input
                  ref={input}
                  type="file"
                  accept={DOC_FILE_ACCEPT}
                  hidden
                  aria-label={t('docs.file')}
                  onChange={(e) => void attach(e.target.files?.[0])}
                />
                <button type="button" className="btn btn-small" onClick={onEdit}>
                  <Pencil size={16} aria-hidden="true" /> {t('docs.edit')}
                </button>
                <button type="button" className="btn btn-small" onClick={() => setArchiving(true)}>
                  <Archive size={16} aria-hidden="true" /> {t('docs.archive')}
                </button>
              </>
            )}
          </div>
        )}
        {canEdit && me?.user.role === 'manager' && d.file && (
          <div className="detail-section">
            <button type="button" className="btn btn-small"
              onClick={()=>setShowVerification(v=>!v)}>
              {showVerification ? 'Masquer la vérification OCR' : 'Vérifier ce document (OCR)'}
            </button>
            {showVerification && <DocumentOcrReview key={d.file.id}
              scanUrl={fileUrl(vehicleId,d.file.id)} mimeType={d.file.mimeType}
              analyzeUrl={`/vehicles/${vehicleId}/documents/${d.id}/analyze`}
              reviewUrl={`/vehicles/${vehicleId}/documents/${d.id}/review`}
              review={d.review} title={docTitle(d,t)}
              onSaved={()=>onChanged(t('common.saved'))}/>}
          </div>
        )}
      </div>
    </li>
  );
}

interface DocFormState {
  docType: DocType;
  label: string;
  number: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  notes: string;
}

function DocForm({ vehicleId, doc, onCancel, onSaved }: { vehicleId: string; doc?: VehicleDocument; onCancel: () => void; onSaved: (text: string, warn?: boolean) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState<DocFormState>({
    docType: doc?.docType ?? 'insurance',
    label: doc?.label ?? '',
    number: doc?.number ?? '',
    issuer: doc?.issuer ?? '',
    issueDate: doc?.issueDate ?? '',
    expiryDate: doc?.expiryDate ?? '',
    notes: doc?.notes ?? '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof DocFormState>(k: K, v: DocFormState[K]) => setF((x) => ({ ...x, [k]: v }));

  const badDates = Boolean(f.issueDate && f.expiryDate && f.expiryDate < f.issueDate);
  const missing = f.docType === 'other' && !f.label.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      docType: f.docType,
      label: f.label.trim() || null,
      number: f.number.trim() || null,
      issuer: f.issuer.trim() || null,
      issueDate: f.issueDate || null,
      expiryDate: f.expiryDate || null,
      notes: f.notes.trim() || null,
    };
    let saved: VehicleDocument;
    try {
      saved = await api<VehicleDocument>(doc ? `/vehicles/${vehicleId}/documents/${doc.id}` : `/vehicles/${vehicleId}/documents`, {
        method: doc ? 'PUT' : 'POST',
        body,
      });
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
      return;
    }
    if (file) {
      try {
        await uploadFile(`/vehicles/${vehicleId}/documents/${saved.id}/file`, file, { method: 'PUT' });
      } catch (err) {
        // The document itself is saved; only the scan failed. Close the form (no duplicate on a
        // second click) and say so: the scan can be attached again from the list.
        onSaved(`${t('docs.savedWithoutFile')} ${t(uploadErrorKey(err))}`, true);
        return;
      }
    }
    onSaved(t('common.saved'));
  };

  return (
    <form className="doc-form" onSubmit={submit} noValidate>
      <div className="card-head">
        <h3>{doc ? t('docs.edit') : t('docs.add')}</h3>
        <button type="button" className="icon-btn" aria-label={t('common.cancel')} onClick={onCancel}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="grid">
        <label className="field">
          <span>{t('docs.type')}</span>
          <select value={f.docType} onChange={(e) => set('docType', e.target.value as DocType)}>
            {DOC_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`docs.type.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {f.docType === 'other' && (
          <label className="field">
            <span>{t('docs.label')}</span>
            <input required value={f.label} maxLength={120} onChange={(e) => set('label', e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>{t('docs.number')}</span>
          <input dir="ltr" value={f.number} maxLength={80} onChange={(e) => set('number', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('docs.issuer')}</span>
          <input value={f.issuer} maxLength={120} onChange={(e) => set('issuer', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('docs.issueDate')}</span>
          <input type="date" dir="ltr" value={f.issueDate} onChange={(e) => set('issueDate', e.target.value)} />
        </label>
        <label className="field">
          <span>{t('docs.expiryDate')}</span>
          <input type="date" dir="ltr" value={f.expiryDate} aria-invalid={badDates || undefined} onChange={(e) => set('expiryDate', e.target.value)} />
          {badDates && <small className="field-error">{t('docs.badDates')}</small>}
        </label>
        {!doc && (
          <label className="field">
            <span>{t('docs.file')}</span>
            <input type="file" accept={DOC_FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        <label className="field field-wide">
          <span>{t('docs.notes')}</span>
          <textarea rows={2} value={f.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || badDates || missing}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  );
}
