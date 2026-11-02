import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../useApi';
import { useI18n, type MessageKey } from '../i18n';
import { ErrorState, Loading, errorKey } from '../components/States';

export interface CompanySettings {
  legalName: string;
  tradeName: string;
  ice: string | null;
  ifNumber: string | null;
  rcNumber: string | null;
  rcCity: string | null;
  patente: string | null;
  addressLine: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  currency: string;
  timezone: string;
  defaultLanguage: 'fr' | 'ar';
  documentLanguages: Array<'fr' | 'ar'>;
  brandPrimaryColor: string;
  showCompanyBranding: boolean;
  documentHeaderText: string | null;
  documentFooterText: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
}

interface SettingsResponse {
  settings: CompanySettings;
  logo: { configured: boolean };
  updatedAt: string;
}

type TextField = { key: keyof CompanySettings; label: MessageKey; ltr?: boolean; type?: string; multiline?: boolean };

const SECTIONS: Array<{ title: MessageKey; fields: TextField[] }> = [
  {
    title: 'company.section.identity',
    fields: [
      { key: 'legalName', label: 'company.legalName' },
      { key: 'tradeName', label: 'company.tradeName' },
    ],
  },
  {
    title: 'company.section.legal',
    fields: [
      { key: 'ice', label: 'company.ice', ltr: true },
      { key: 'ifNumber', label: 'company.ifNumber', ltr: true },
      { key: 'rcNumber', label: 'company.rcNumber', ltr: true },
      { key: 'rcCity', label: 'company.rcCity' },
      { key: 'patente', label: 'company.patente', ltr: true },
    ],
  },
  {
    title: 'company.section.contact',
    fields: [
      { key: 'addressLine', label: 'company.addressLine' },
      { key: 'city', label: 'company.city' },
      { key: 'postalCode', label: 'company.postalCode', ltr: true },
      { key: 'countryCode', label: 'company.countryCode', ltr: true },
      { key: 'phone', label: 'company.phone', ltr: true, type: 'tel' },
      { key: 'email', label: 'company.email', ltr: true, type: 'email' },
      { key: 'website', label: 'company.website', ltr: true, type: 'url' },
    ],
  },
  {
    title: 'company.section.regional',
    fields: [
      { key: 'currency', label: 'company.currency', ltr: true },
      { key: 'timezone', label: 'company.timezone', ltr: true },
    ],
  },
  {
    title: 'company.section.documents',
    fields: [
      { key: 'documentHeaderText', label: 'company.documentHeaderText', multiline: true },
      { key: 'documentFooterText', label: 'company.documentFooterText', multiline: true },
      { key: 'signatoryName', label: 'company.signatoryName' },
      { key: 'signatoryTitle', label: 'company.signatoryTitle' },
    ],
  },
];

export function CompanySettingsPage() {
  const { can } = useAuth();
  const { t, formatDateTime } = useI18n();
  const editable = can('company_settings.update');
  const { data, error: loadError, reload, setData } = useApi<SettingsResponse>('/company-settings');
  const [form, setForm] = useState<CompanySettings | null>(null);
  const [formSource, setFormSource] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Reset the editable copy whenever fresh data arrives (render-time sync, no effect needed).
  if (data && data !== formSource) {
    setFormSource(data);
    setForm(data.settings);
  }

  if (loadError) return <ErrorState error={loadError} onRetry={reload} />;
  if (!data || !form) return <Loading />;

  const set = <K extends keyof CompanySettings>(key: K, value: CompanySettings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const res = await api<SettingsResponse>('/company-settings', { method: 'PUT', body: form });
      setData(res);
      setMessage({ kind: 'ok', text: t('common.saved') });
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
      }
      setMessage({ kind: 'error', text: t(errorKey(err)) });
    } finally {
      setSaving(false);
    }
  };

  const toggleDocLang = (l: 'fr' | 'ar') => {
    const has = form.documentLanguages.includes(l);
    const next = has ? form.documentLanguages.filter((x) => x !== l) : [...form.documentLanguages, l];
    if (next.length > 0) set('documentLanguages', next);
  };

  return (
    <section>
      <h1>{t('company.title')}</h1>
      {!editable && <div className="alert alert-info">{t('common.readOnly')}</div>}
      <p className="muted small">{t('company.lastUpdated', { time: formatDateTime(data.updatedAt) })}</p>
      <form onSubmit={onSubmit} className="settings-form" noValidate>
        <fieldset disabled={!editable || saving}>
          {SECTIONS.map((section) => (
            <div className="card" key={section.title}>
              <h2>{t(section.title)}</h2>
              <div className="grid">
                {section.fields.map((f) => {
                  const value = (form[f.key] as string | null) ?? '';
                  const err = fieldErrors[f.key];
                  const common = {
                    id: `cs-${f.key}`,
                    name: f.key,
                    dir: f.ltr ? 'ltr' : undefined,
                    value,
                    'aria-invalid': err ? true : undefined,
                    onChange: (e: { target: { value: string } }) => set(f.key, e.target.value as never),
                  };
                  return (
                    <label className={`field${f.multiline ? ' field-wide' : ''}`} key={f.key} htmlFor={common.id}>
                      <span>{t(f.label)}</span>
                      {f.multiline ? <textarea rows={3} {...common} /> : <input type={f.type ?? 'text'} {...common} />}
                      {err && <small className="field-error">{err}</small>}
                    </label>
                  );
                })}
                {section.title === 'company.section.regional' && (
                  <>
                    <label className="field" htmlFor="cs-defaultLanguage">
                      <span>{t('company.defaultLanguage')}</span>
                      <select
                        id="cs-defaultLanguage"
                        value={form.defaultLanguage}
                        onChange={(e) => set('defaultLanguage', e.target.value as 'fr' | 'ar')}
                      >
                        <option value="fr">{t('lang.fr')}</option>
                        <option value="ar">{t('lang.ar')}</option>
                      </select>
                    </label>
                    <div className="field">
                      <span>{t('company.documentLanguages')}</span>
                      <div className="checks">
                        {(['fr', 'ar'] as const).map((l) => (
                          <label key={l} className="check">
                            <input type="checkbox" checked={form.documentLanguages.includes(l)} onChange={() => toggleDocLang(l)} />
                            {t(l === 'fr' ? 'lang.fr' : 'lang.ar')}
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {section.title === 'company.section.documents' && (
                  <>
                    <label className="field" htmlFor="cs-color">
                      <span>{t('company.brandPrimaryColor')}</span>
                      <input
                        id="cs-color"
                        type="color"
                        value={form.brandPrimaryColor}
                        onChange={(e) => set('brandPrimaryColor', e.target.value.toUpperCase())}
                      />
                    </label>
                    <label className="check field">
                      <input
                        type="checkbox"
                        checked={form.showCompanyBranding}
                        onChange={(e) => set('showCompanyBranding', e.target.checked)}
                      />
                      {t('company.showCompanyBranding')}
                    </label>
                    <div className="field field-wide">
                      <span>{t('company.logo')}</span>
                      <small className="muted">{t('company.logoPending')}</small>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </fieldset>
        {message && (
          <div className={`alert ${message.kind === 'ok' ? 'alert-ok' : 'alert-error'}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
            {message.text}
          </div>
        )}
        {editable && (
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
