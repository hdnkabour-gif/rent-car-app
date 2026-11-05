import { useAuth } from '../auth';
import { api } from '../api';
import { useI18n, type Lang } from '../i18n';

/** Two-button FR | ع switch: one tap, always visible, no hidden dropdown. */
export function LanguageSwitcher({ full = false }: { full?: boolean }) {
  const { lang, setLang, t } = useI18n();
  const { status } = useAuth();
  const change = (l: Lang) => {
    if (l === lang) return;
    setLang(l);
    if (status === 'authenticated') {
      void api('/auth/me/preferences', { method: 'PATCH', body: { preferredLanguage: l } }).catch(() => undefined);
    }
  };
  const options: Array<{ value: Lang; short: string; long: string }> = [
    { value: 'fr', short: t('lang.frShort'), long: t('lang.fr') },
    { value: 'ar', short: t('lang.arShort'), long: t('lang.ar') },
  ];
  return (
    <div className="segmented" role="group" aria-label={t('lang.label')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          aria-pressed={lang === o.value}
          aria-label={o.long}
          className={lang === o.value ? 'active' : ''}
          onClick={() => change(o.value)}
        >
          {full ? o.long : o.short}
        </button>
      ))}
    </div>
  );
}
