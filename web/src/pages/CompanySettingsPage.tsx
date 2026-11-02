import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { BadgeCheck, Building2, FileText, Globe, MapPin, type LucideIcon } from 'lucide-react';
import { useAuth } from '../auth';
import { useBranding } from '../branding';
import { PageHeader } from '../components/PageHeader';
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

type TextField = {
  key: keyof CompanySettings;
  label: MessageKey;
  hint?: MessageKey;
  ltr?: boolean;
  type?: string;
  inputMode?: 'numeric' | 'tel' | 'email' | 'url' | 'text';
  placeholder?: string;
  multiline?: boolean;
};

const SECTIONS: Array<{ title: MessageKey; icon: LucideIcon; fields: TextField[] }> = [
  {
    title: 'company.section.identity',
    icon: Building2,
    fields: [
      { key: 'tradeName', label: 'company.tradeName', hint: 'company.tradeNameHint' },
      { key: 'legalName', label: 'company.legalName', hint: 'company.legalNameHint' },
    ],
  },
  {
    title: 'company.section.legal',
    icon: BadgeCheck,
    fields: [
      { key: 'ice', label: 'company.ice', hint: 'company.iceHint', ltr: true, inputMode: 'numeric', placeholder: '000000000000000' },
      { key: 'ifNumber', label: 'company.ifNumber', ltr: true, inputMode: 'numeric' },
      { key: 'rcNumber', label: 'company.rcNumber', ltr: true },
      { key: 'rcCity', label: 'company.rcCity' },
      { key: 'patente', label: 'company.patente', ltr: true, inputMode: 'numeric' },
    ],
  },
  {
    title: 'company.section.contact',
    icon: MapPin,
    fields: [
      { key: 'addressLine', label: 'company.addressLine' },
      { key: 'city', label: 'company.city' },
      { key: 'postalCode', label: 'company.postalCode', ltr: true, inputMode: 'numeric' },
      { key: 'phone', label: 'company.phone', ltr: true, type: 'tel', inputMode: 'tel', placeholder: '05 22 00 00 00' },
      { key: 'email', label: 'company.email', ltr: true, type: 'email', inputMode: 'email' },
      { key: 'website', label: 'company.website', ltr: true, type: 'url', inputMode: 'url', placeholder: 'https://' },
    ],
  },
  { title: 'company.section.regional', icon: Globe, fields: [] },
  {
    title: 'company.section.documents',
    icon: FileText,
    fields: [
      { key: 'documentHeaderText', label: 'company.documentHeaderText', multiline: true },
      { key: 'documentFooterText', label: 'company.documentFooterText', multiline: true },
      { key: 'signatoryName', label: 'company.signatoryName' },
      { key: 'signatoryTitle', label: 'company.signatoryTitle' },
    ],
  },
];

/** Known options shown with friendly names; an unexpected stored value is still listed. */
function withCurrent(options: Array<{ value: string; label: string }>, current: string) {
  return options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }];
}

export function CompanySettingsPage() {
  const { can } = useAuth();
  const { t, has, formatDateTime } = useI18n();
  const branding = useBranding();
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

  const set = <K extends keyof CompanySettings>(key: K, value: CompanySettings[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setMessage(null);
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const res = await api<SettingsResponse>('/company-settings', { method: 'PUT', body: form });
      setData(res);
      branding.reload();
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

  const select = (
    key: 'countryCode' | 'currency' | 'timezone' | 'defaultLanguage',
    label: MessageKey,
    options: Array<{ value: string; label: string }>,
  ) => (
    <label className="field" htmlFor={`cs-${key}`}>
      <span>{t(label)}</span>
      <select id={`cs-${key}`} value={form[key]} onChange={(e) => set(key, e.target.value as never)}>
        {withCurrent(options, form[key]).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="has-savebar">
      <PageHeader title={t('company.title')} subtitle={t('company.subtitle')} />
      {!editable && <div className="alert alert-info">{t('common.readOnly')}</div>}
      <form onSubmit={onSubmit} className="settings-form" noValidate>
        <fieldset disabled={!editable || saving}>
          {SECTIONS.map((section) => {
            const SectionIcon = section.icon;
            return (
              <div className="card" key={section.title}>
                <h2 className="card-title">
                  <SectionIcon size={20} aria-hidden="true" /> {t(section.title)}
                </h2>
                <div className="grid">
                  {section.fields.map((f) => {
                    const value = (form[f.key] as string | null) ?? '';
                    const err = fieldErrors[f.key];
                    const describedBy = [f.hint ? `cs-${f.key}-hint` : '', err ? `cs-${f.key}-err` : ''].filter(Boolean).join(' ');
                    const common = {
                      id: `cs-${f.key}`,
                      name: f.key,
                      dir: f.ltr ? 'ltr' : undefined,
                      value,
                      placeholder: f.placeholder,
                      'aria-invalid': err ? true : undefined,
                      'aria-describedby': describedBy || undefined,
                      onChange: (e: { target: { value: string } }) => set(f.key, e.target.value as never),
                    };
                    return (
                      <div className={`field${f.multiline ? ' field-wide' : ''}`} key={f.key}>
                        <label htmlFor={common.id}>{t(f.label)}</label>
                        {f.multiline ? (
                          <textarea rows={3} {...common} />
                        ) : (
                          <input type={f.type ?? 'text'} inputMode={f.inputMode} {...common} />
                        )}
                        {f.hint && (
                          <small className="hint" id={`cs-${f.key}-hint`}>
                            {t(f.hint)}
                          </small>
                        )}
                        {err && (
                          <small className="field-error" id={`cs-${f.key}-err`}>
                            {has(`company.${f.key}Error`) ? t(`company.${f.key}Error` as MessageKey) : t('validation.invalidField')}
                          </small>
                        )}
                      </div>
                    );
                  })}
                  {section.title === 'company.section.contact' &&
                    select('countryCode', 'company.countryCode', [{ value: 'MA', label: t('company.country.MA') }])}
                  {section.title === 'company.section.regional' && (
                    <>
                      {select('currency', 'company.currency', [{ value: 'MAD', label: t('company.currency.MAD') }])}
                      {select('timezone', 'company.timezone', [{ value: 'Africa/Casablanca', label: t('company.timezone.casablanca') }])}
                      {select('defaultLanguage', 'company.defaultLanguage', [
                        { value: 'fr', label: t('lang.fr') },
                        { value: 'ar', label: t('lang.ar') },
                      ])}
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
                      <div className="field">
                        <label htmlFor="cs-color">{t('company.brandPrimaryColor')}</label>
                        <div className="color-row">
                          <input
                            id="cs-color"
                            type="color"
                            value={form.brandPrimaryColor}
                            onChange={(e) => set('brandPrimaryColor', e.target.value.toUpperCase())}
                          />
                          <code dir="ltr">{form.brandPrimaryColor}</code>
                        </div>
                        <small className="hint">{t('company.brandPrimaryColorHint')}</small>
                      </div>
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
                        <small className="hint">{t('company.logoPending')}</small>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </fieldset>
        <p className="muted small">{t('company.lastUpdated', { time: formatDateTime(data.updatedAt) })}</p>
        {editable && (
          <div className="savebar">
            <div className="savebar-msg" aria-live="polite">
              {message && (
                <span className={message.kind === 'ok' ? 'text-ok' : 'text-error'} role={message.kind === 'error' ? 'alert' : 'status'}>
                  {message.text}
                </span>
              )}
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
