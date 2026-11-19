import { useEffect, useState } from 'react';
import { useBranding, isJmrBrand } from '../branding';
import { useI18n } from '../i18n';
import './BrandSplash.css';

export type SplashPhase = 'name' | 'car' | 'crest' | 'loading';
interface Props {
  phase?: SplashPhase;
  onAssetReady?: (src: string | null) => void;
}

/** A branded intro with real raster artwork: name → driving silhouette → complete crest.
 * The final loading stage remains visible until session/branding/first-page data resolves.
 * No fake percent, no external images, no endless network stall.
 */
export function BrandSplash({ phase = 'loading', onAssetReady }: Props) {
  const brand = useBranding();
  const { t } = useI18n();
  const jmr = isJmrBrand(brand.name) || !brand.name;
  const logo = brand.logo ?? (jmr ? '/branding/jmr-logo.png' : null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = Boolean(logo && brokenSrc === logo);
  const custom = Boolean(brand.logo);
  useEffect(() => { if (!logo) onAssetReady?.(null); }, [logo, onAssetReady]);

  return (
    <div className={`jmr-splash jmr-splash--${phase}${jmr && !custom ? ' jmr-splash--luxury' : ''}`}
      role="status" aria-live="polite" aria-label={t('common.loading')}>
      <div className="jmr-splash__ambient" aria-hidden="true" />
      <div className="jmr-splash__content">
        <div className="jmr-splash__name" aria-hidden="true">
          {jmr && !custom ? 'JMR LUXE CAR' : (brand.name ?? 'JMR LUXE CAR')}
        </div>
        <div className="jmr-splash__logo-frame">
          {logo && !broken ? (
            <img
              className="jmr-splash__logo"
              src={logo}
              alt=""
              draggable={false}
              decoding="async"
              onLoad={() => onAssetReady?.(logo)}
              onError={() => { setBrokenSrc(logo); onAssetReady?.(logo); }}
            />
          ) : (
            <div className="jmr-splash__fallback">{brand.name ?? 'JMR LUXE CAR'}</div>
          )}
          <span className="jmr-splash__light" aria-hidden="true"/>
        </div>
        <div className="jmr-splash__caption">
          {jmr ? 'LOCATION DE VOITURES' : (brand.city ?? '')}
        </div>
        <div className="jmr-splash__progress" aria-hidden="true">
          <span className="jmr-splash__ring" />
        </div>
        <p className="jmr-splash__label">
          {phase === 'loading' ? t('agenda.loading') : t('common.loading')}
        </p>
      </div>
    </div>
  );
}
