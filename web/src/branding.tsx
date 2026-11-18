import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useApi } from './useApi';

export interface Branding {
  /** Company display name (trade name or legal name); null until the manager fills it in. */
  name: string | null;
  city: string | null;
  color: string;
  /** URL of the company logo, or null. */
  logo: string | null;
  reload: () => void;
}

const DEFAULT_COLOR = '#1F4E79';
const BrandingContext = createContext<Branding>({ name: null, city: null, color: DEFAULT_COLOR, logo: null, reload: () => undefined });

/**
 * Company identity used everywhere (login page included) so the app looks like the company's own
 * app: name, city, colour and logo come from the public /api/branding endpoint.
 */
export function BrandingProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useApi<{ name: string | null; city: string | null; color: string; logo: string | null }>('/branding');
  const value: Branding = {
    name: data?.name ?? null,
    city: data?.city ?? null,
    color: /^#[0-9a-f]{6}$/i.test(data?.color ?? '') ? data!.color : DEFAULT_COLOR,
    logo: data?.logo ?? null,
    reload,
  };

  // Browser tab, phone status bar and favicon show the company, not the product.
  useEffect(() => {
    if (value.name) document.title = value.name;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = value.color;
    if (value.logo) {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = value.logo;
    }
  }, [value.name, value.color, value.logo]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}

/** Only show the JMR-specific fallback assets when this is genuinely JMR's company. */
export const isJmrBrand = (name: string | null): boolean =>
  Boolean(name && /\bJMR\s+LUXE\s+CAR\b/i.test(name));

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** Company logo, or its initials on the brand colour. */
export function BrandMark({ size = 44, className = '' }: { size?: number; className?: string }) {
  const b = useBranding();
  const label = b.name ?? 'Fleetora';
  const fallback = isJmrBrand(b.name) ? '/branding/jmr-emblem.svg' : null;
  const src = b.logo ?? fallback;
  return src ? (
    <img src={src} alt="" className={`brand-logo ${fallback && !b.logo ? 'brand-logo--jmr ' : ''}${className}`} style={{ width: size, height: size }} />
  ) : (
    <span className={`brand-mark ${className}`} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">
      {initialsOf(label)}
    </span>
  );
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
