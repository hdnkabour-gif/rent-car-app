import { createContext, useContext, type ReactNode } from 'react';
import { useApi } from './useApi';

export interface Branding {
  name: string | null;
  color: string;
  reload: () => void;
}

const DEFAULT_COLOR = '#1F4E79';
const BrandingContext = createContext<Branding>({ name: null, color: DEFAULT_COLOR, reload: () => undefined });

interface SettingsLite {
  settings: { tradeName: string; legalName: string; brandPrimaryColor: string };
}

/** Company identity (trade name + colour) shown in the app header, from company settings. */
export function BrandingProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { data, reload } = useApi<SettingsLite>(enabled ? '/company-settings' : null);
  const s = data?.settings;
  const value: Branding = {
    name: s ? s.tradeName || s.legalName || null : null,
    color: s?.brandPrimaryColor ?? DEFAULT_COLOR,
    reload,
  };
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}

/** Picks white or near-black text so any company colour stays readable (WCAG contrast). */
export function readableOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#14202e' : '#ffffff';
}
