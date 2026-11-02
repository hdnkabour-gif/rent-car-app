import { useAuth } from '../auth';
import { api } from '../api';
import { useI18n, type Lang } from '../i18n';

export function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n();
  const { status } = useAuth();
  const change = (l: Lang) => {
    setLang(l);
    if (status === 'authenticated') {
      void api('/auth/me/preferences', { method: 'PATCH', body: { preferredLanguage: l } }).catch(() => undefined);
    }
  };
  return (
    <label className="lang-switch">
      <span className="visually-hidden">{t('lang.label')}</span>
      <select value={lang} onChange={(e) => change(e.target.value as Lang)} aria-label={t('lang.label')}>
        <option value="fr">{t('lang.fr')}</option>
        <option value="ar">{t('lang.ar')}</option>
      </select>
    </label>
  );
}
