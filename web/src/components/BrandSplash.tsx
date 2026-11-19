import { useEffect, useState, type CSSProperties } from 'react';
import { useBranding, isJmrBrand } from '../branding';
import { useI18n } from '../i18n';
import './BrandSplash.css';

export type SplashPhase = 'name' | 'car' | 'tagline' | 'sceptre' | 'crown' | 'loading';
interface Props {
  phase?: SplashPhase;
  progress?: number;
  onAssetReady?: (src: string | null) => void;
}

/**
 * Every element occupies an independent layout layer: the letters, car, motto,
 * sceptre and crown never use one complete logo overlay on the wordmark.
 * The official raster is still used for company-supplied branding, and the
 * JMR fragments remain raster-based rather than an inaccurate vector redraw.
 */
export function BrandSplash({ phase = 'loading', progress = 0, onAssetReady }: Props) {
  const brand = useBranding();
  const { t } = useI18n();
  const jmr = isJmrBrand(brand.name) || !brand.name;
  const custom = Boolean(brand.logo);
  const cinematic = jmr && !custom;
  const logo = brand.logo ?? (jmr ? '/branding/jmr-logo.png' : null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = Boolean(logo && brokenSrc === logo);
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  useEffect(() => { if (!logo) onAssetReady?.(null); }, [logo, onAssetReady]);

  return (
    <div className={`jmr-splash jmr-splash--${phase}${cinematic ? ' jmr-splash--cinematic' : ''}`}
      role="status" aria-live="polite" aria-label={t('common.loading')}>
      <div className="jmr-splash__ambient" aria-hidden="true" />
      <div className="jmr-splash__content">
        {cinematic ? (
          <>
            <div className="jmr-splash__wordmark" aria-label="JMR LUX CAR">
              <span className="jmr-splash__jmr">JMR</span>
              <span className="jmr-splash__lux">LUX CAR</span>
            </div>
            <div className="jmr-splash__stage" aria-hidden="true">
              <div className="jmr-splash__sceptre" />
              <div className="jmr-splash__car">
                <span className="jmr-splash__car-roof" />
                <span className="jmr-splash__car-body" />
                <span className="jmr-splash__wheel jmr-splash__wheel--front" />
                <span className="jmr-splash__wheel jmr-splash__wheel--rear" />
                <span className="jmr-splash__shine" />
              </div>
              <div className="jmr-splash__crown">♛</div>
            </div>
            <div className="jmr-splash__tagline">LOCATION DE VOITURES</div>
          </>
        ) : (
          <div className="jmr-splash__other-brand">
            {logo && !broken
              ? <img className="jmr-splash__other-logo" src={logo} alt="" decoding="async"
                  onLoad={() => onAssetReady?.(logo)}
                  onError={() => { setBrokenSrc(logo); onAssetReady?.(logo); }} />
              : <div className="jmr-splash__fallback">{brand.name ?? 'JMR LUX CAR'}</div>}
            <div className="jmr-splash__caption">{brand.name ?? ''}</div>
          </div>
        )}
        {cinematic && (
          <img className="jmr-splash__asset-preload" src="/branding/jmr-logo.png" alt=""
            onLoad={() => onAssetReady?.('/branding/jmr-logo.png')}
            onError={() => onAssetReady?.('/branding/jmr-logo.png')} />
        )}
        <div className="jmr-splash__progress" role="progressbar" aria-valuenow={value}
          aria-valuemin={0} aria-valuemax={100} aria-label={t('common.loading')}
          style={{ '--splash-progress': `${value}%` } as CSSProperties}>
          <span className="jmr-splash__ring" aria-hidden="true" />
          <strong>{value}%</strong>
        </div>
        <p className="jmr-splash__label">{t('common.loading')}</p>
      </div>
    </div>
  );
}
