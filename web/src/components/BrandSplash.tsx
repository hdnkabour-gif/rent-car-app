import { useEffect, useState } from 'react';
import { useBranding, isJmrBrand } from '../branding';
import { useI18n } from '../i18n';
import './BrandSplash.css';

interface Props {
  phase?: 'emblem' | 'wordmark' | 'loading';
  onAssetReady?: (src: string | null) => void;
}

/** A real loading sequence: the logo fully renders, then the wordmark reveals, then visible
 * first-screen data resolves. There is never a fictional percentage and never an endless wait.
 */
export function BrandSplash({ phase = 'loading', onAssetReady }: Props) {
  const brand = useBranding();
  const { t } = useI18n();
  const jmr = isJmrBrand(brand.name) || !brand.name;
  const logo = brand.logo ?? (jmr ? '/branding/jmr-premium-crest.svg' : null);
  const [brokenLogoSrc, setBrokenLogoSrc] = useState<string | null>(null);
  const broken = Boolean(logo && brokenLogoSrc === logo);
  useEffect(() => {
    if (!logo) onAssetReady?.(null);
  }, [logo, onAssetReady]);
  const showName = phase !== 'emblem';
  return (
    <div className={`jmr-splash jmr-splash--${phase}`} role="status" aria-live="polite" aria-label={t('common.loading')}>
      <div className="jmr-splash__ribbon jmr-splash__ribbon--upper" aria-hidden="true" />
      <div className="jmr-splash__ribbon jmr-splash__ribbon--lower" aria-hidden="true" />
      <div className="jmr-splash__content">
        <div className="jmr-splash__logo-frame">
          {logo && !broken ? (
            <img className="jmr-splash__logo" src={logo} alt="" draggable={false} onLoad={() => onAssetReady?.(logo)}
              onError={() => { setBrokenLogoSrc(logo); onAssetReady?.(logo); }} />
          ) : (
            <div className="jmr-splash__fallback">{brand.name ?? 'JMR LUXE CAR'}</div>
          )}
          <div className="jmr-splash__shimmer" aria-hidden="true" />
        </div>
        <div className={`jmr-splash__wordmark${showName ? ' is-visible' : ''}`}>
          {jmr && !brand.logo ? 'JMR LUXE CAR' : (brand.name ?? '')}
        </div>
        <span className="jmr-splash__subline">
          {jmr ? 'LOCATION DE VOITURES' : (brand.city ?? '')}
        </span>
        <div className="jmr-splash__progress" aria-hidden="true"><span className="jmr-splash__ring" /></div>
        <p className="jmr-splash__label">{phase === 'loading' ? t('agenda.loading') : t('common.loading')}</p>
      </div>
    </div>
  );
}
