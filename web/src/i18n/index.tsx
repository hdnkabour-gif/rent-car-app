import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fr, type MessageKey } from './fr';
import { ar } from './ar';

export type Lang = 'fr' | 'ar';
const dictionaries: Record<Lang, Record<MessageKey, string>> = { fr, ar };
const STORAGE_KEY = 'fleetora.lang';

export const dirFor = (lang: Lang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr');

interface I18nValue {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  setLang: (l: Lang) => void;
  t: (key: MessageKey, vars?: Record<string, string>) => string;
  formatDateTime: (value: string | Date) => string;
  formatLongDate: (value: string | Date) => string;
  /** True when a (dynamic) key exists, e.g. audit action labels. */
  has: (key: string) => key is MessageKey;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'fr' || stored === 'ar') return stored;
  } catch {
    // storage unavailable (private mode)
  }
  return 'fr';
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial ?? initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = dictionaries[lang];
    // Moroccan locales; Latin digits are standard in Moroccan Arabic business documents.
    const dtf = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Africa/Casablanca',
    });
    const longDate = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Africa/Casablanca',
    });
    return {
      lang,
      dir: dirFor(lang),
      setLang,
      t: (key, vars) => {
        let s = dict[key] ?? fr[key] ?? key;
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
        return s;
      },
      formatDateTime: (v) => dtf.format(typeof v === 'string' ? new Date(v) : v),
      formatLongDate: (v) => longDate.format(typeof v === 'string' ? new Date(v) : v),
      has: (key: string): key is MessageKey => key in dict,
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export type { MessageKey };
