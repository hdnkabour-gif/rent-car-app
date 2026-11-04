import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { COMMON_COUNTRIES, type Customer, type DuplicateMatch } from '../customers';

type F = {
  customerType: Customer['customerType'];
  fullName: string;
  companyIce: string;
  contactPerson: string;
  birthDate: string;
  nationality: string;
  residence: Customer['residence'];
  phone: string;
  phone2: string;
  whatsappSamePhone: boolean;
  email: string;
  address: string;
  city: string;
  country: string;
  preferredLanguage: Customer['preferredLanguage'];
  idDocType: NonNullable<Customer['idDocType']> | '';
  idDocNumber: string;
  idDocCountry: string;
  idDocExpiry: string;
  licenceNumber: string;
  licenceCategory: string;
  licenceCountry: string;
  licenceIssueDate: string;
  licenceExpiry: string;
  notes: string;
  profession: string;
  otherAddress: string;
  idDocIssueDate: string;
};

const EMPTY: F = {
  customerType: 'individual',
  fullName: '',
  companyIce: '',
  contactPerson: '',
  birthDate: '',
  nationality: '',
  residence: 'morocco',
  phone: '',
  phone2: '',
  whatsappSamePhone: true,
  email: '',
  address: '',
  city: '',
  country: '',
  preferredLanguage: 'fr',
  idDocType: 'cin',
  idDocNumber: '',
  idDocCountry: '',
  idDocExpiry: '',
  licenceNumber: '',
  licenceCategory: 'B',
  licenceCountry: '',
  licenceIssueDate: '',
  licenceExpiry: '',
  notes: '',
  profession: '',
  otherAddress: '',
  idDocIssueDate: '',
};

const fromCustomer = (c: Customer): F => {
  const f = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as Array<keyof F>) {
    const v = c[k as keyof Customer];
    (f as Record<string, unknown>)[k] = v === null || v === undefined ? (k === 'idDocType' ? '' : EMPTY[k] === true ? false : '') : v;
  }
  return f;
};

export function CustomerFormPage() {
  const { id } = useParams();
  const existing = useApi<{ customer: Customer }>(id ? `/customers/${id}` : null);
  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;
  if (id && !existing.data) return <Loading />;
  return <CustomerForm id={id} initial={existing.data ? fromCustomer(existing.data.customer) : EMPTY} />;
}

function CustomerForm({ id, initial }: { id?: string; initial: F }) {
  const { t, has } = useI18n();
  const navigate = useNavigate();
  const [f, setF] = useState<F>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<DuplicateMatch[] | null>(null);
  const set = <K extends keyof F>(k: K, v: F[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setMatches(null);
  };

  const submit = async (e: FormEvent | null, acknowledgeDuplicates = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const company = f.customerType === 'company';
    const body = {
      ...f,
      companyIce: company ? f.companyIce.replace(/\s/g, '') || null : null,
      contactPerson: company ? f.contactPerson || null : null,
      idDocType: f.idDocType || null,
      ...(acknowledgeDuplicates ? { acknowledgeDuplicates: true } : {}),
    };
    try {
      const saved = await api<{ customer: Customer }>(id ? `/customers/${id}` : '/customers', { method: id ? 'PUT' : 'POST', body });
      navigate(`/customers/${saved.customer.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') {
        setMatches((err.details as unknown as { matches: DuplicateMatch[] }).matches);
      } else {
        if (err instanceof ApiError && Array.isArray(err.details)) {
          setFieldErrors(
            Object.fromEntries(err.details.map((d) => [d.path, has(`customers.error.${d.path}`) ? t(`customers.error.${d.path}` as MessageKey) : t('customers.fieldInvalid')])),
          );
        }
        setError(t(errorKey(err)));
      }
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof F, label: MessageKey, opts: { ltr?: boolean; type?: string; required?: boolean; hint?: MessageKey; list?: string; max?: number } = {}) => (
    <label className="field">
      <span>
        {t(label)}
        {opts.required && ' *'}
      </span>
      <input
        type={opts.type ?? 'text'}
        dir={opts.ltr ? 'ltr' : undefined}
        inputMode={opts.type === 'tel' ? 'tel' : opts.type === 'email' ? 'email' : undefined}
        autoComplete="off"
        list={opts.list}
        maxLength={opts.max}
        required={opts.required}
        value={f[k] as string}
        aria-invalid={fieldErrors[k] ? true : undefined}
        onChange={(e) => set(k, e.target.value as never)}
      />
      {opts.hint && <small className="hint">{t(opts.hint)}</small>}
      {fieldErrors[k] && <small className="field-error">{fieldErrors[k]}</small>}
    </label>
  );
  const select = <K extends keyof F>(k: K, label: MessageKey, options: readonly string[], prefix: string, allowEmpty = false): ReactNode => (
    <label className="field">
      <span>{t(label)}</span>
      <select value={f[k] as string} aria-invalid={fieldErrors[k] ? true : undefined} onChange={(e) => set(k, e.target.value as F[K])}>
        {allowEmpty && <option value="">—</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {t(`${prefix}.${o}` as MessageKey)}
          </option>
        ))}
      </select>
      {fieldErrors[k] && <small className="field-error">{fieldErrors[k]}</small>}
    </label>
  );
  const company = f.customerType === 'company';

  return (
    <section>
      <Link to={id ? `/customers/${id}` : '/customers'} className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('customers.back')}
      </Link>
      <PageHeader title={id ? t('customers.edit') : t('customers.add')} />
      <datalist id="countries">
        {COMMON_COUNTRIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <fieldset className="card form-section">
          <legend>{t('customers.section.identity')}</legend>
          <div className="field">
            <span>{t('customers.type')}</span>
            <div className="segmented segmented-wide" role="group" aria-label={t('customers.type')}>
              {(['individual', 'company'] as const).map((x) => (
                <button key={x} type="button" aria-pressed={f.customerType === x} className={f.customerType === x ? 'active' : ''} onClick={() => set('customerType', x)}>
                  {t(`customers.type.${x}` as MessageKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid">
            {field('fullName', company ? 'customers.companyName' : 'customers.fullName', { required: true, max: 160 })}
            {company && field('companyIce', 'customers.companyIce', { ltr: true, max: 20 })}
            {company && field('contactPerson', 'customers.contactPerson', { max: 160 })}
            {!company && field('birthDate', 'customers.birthDate', { type: 'date', ltr: true })}
            {!company && field('nationality', 'customers.nationality', { max: 80 })}
            {!company && field('profession', 'customers.profession', { max: 120 })}
            <div className="field field-wide">
              <span>{t('customers.residence')}</span>
              <div className="segmented segmented-wide segmented-wrap" role="group" aria-label={t('customers.residence')}>
                {(['morocco', 'abroad_mre', 'abroad_foreign'] as const).map((x) => (
                  <button key={x} type="button" aria-pressed={f.residence === x} className={f.residence === x ? 'active' : ''} onClick={() => set('residence', x)}>
                    {t(`customers.residence.${x}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('customers.section.contact')}</legend>
          <div className="grid">
            {field('phone', 'customers.phone', { type: 'tel', ltr: true, required: true, hint: 'customers.phoneHint', max: 40 })}
            {field('phone2', 'customers.phone2', { type: 'tel', ltr: true, max: 40 })}
            <label className="check field-wide">
              <input type="checkbox" checked={f.whatsappSamePhone} onChange={(e) => set('whatsappSamePhone', e.target.checked)} />
              {t('customers.whatsappSame')}
            </label>
            {field('email', 'customers.email', { type: 'email', ltr: true, max: 200 })}
            {select('preferredLanguage', 'customers.language', ['fr', 'ar', 'en', 'es'], 'customers.lang')}
            {field('address', 'customers.address', { max: 300 })}
            {field('city', 'customers.city', { max: 100 })}
            {f.residence !== 'morocco' && field('country', 'customers.country', { list: 'countries', max: 80 })}
            {field('otherAddress', 'customers.otherAddress', { max: 300 })}
          </div>
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('customers.section.idDoc')}</legend>
          <div className="grid">
            {select('idDocType', 'customers.idDocType', ['cin', 'passport', 'residence_permit', 'other'], 'customers.idDocType', true)}
            {field('idDocNumber', 'customers.idDocNumber', { ltr: true, max: 40 })}
            {f.idDocType !== 'cin' && field('idDocCountry', 'customers.idDocCountry', { list: 'countries', max: 80 })}
            {field('idDocIssueDate', 'customers.idDocIssueDate', { type: 'date', ltr: true })}
            {field('idDocExpiry', 'customers.idDocExpiry', { type: 'date', ltr: true })}
          </div>
        </fieldset>

        <fieldset className="card form-section">
          <legend>{t('customers.section.licence')}</legend>
          <div className="grid">
            {field('licenceNumber', 'customers.licenceNumber', { ltr: true, max: 40 })}
            {field('licenceCategory', 'customers.licenceCategory', { ltr: true, max: 20 })}
            {field('licenceCountry', 'customers.licenceCountry', { list: 'countries', max: 80 })}
            {field('licenceIssueDate', 'customers.licenceIssueDate', { type: 'date', ltr: true })}
            {field('licenceExpiry', 'customers.licenceExpiry', { type: 'date', ltr: true })}
          </div>
        </fieldset>

        <div className="card form-section">
          <label className="field">
            <span>{t('customers.notes')}</span>
            <textarea rows={3} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </div>

        {matches && (
          <div className="confirm-box" role="alert">
            <p>
              <TriangleAlert size={18} aria-hidden="true" /> <strong>{t('customers.duplicateTitle')}</strong>
            </p>
            <p className="small">{t('customers.duplicateHint')}</p>
            <ul className="dup-list">
              {matches.map((m) => (
                <li key={m.id}>
                  <strong>{m.fullName}</strong> · <bdi dir="ltr">{m.phone}</bdi> · {m.reasons.map((r) => t(`customers.duplicateReason.${r}` as MessageKey)).join(', ')}{' '}
                  <Link to={`/customers/${m.id}`} target="_blank" rel="noopener">
                    {t('customers.duplicateOpen')}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void submit(null, true)}>
                {t('customers.duplicateConfirm')}
              </button>
            </div>
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || f.fullName.trim().length < 2 || !f.phone.trim()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
