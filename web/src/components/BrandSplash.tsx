import { useEffect, useState, type CSSProperties } from 'react';
import { isJmrBrand, useBranding } from '../branding';
import { useI18n } from '../i18n';
import './BrandSplash.css';

export type SplashPhase = 'icon' | 'logo' | 'finish' | 'loading';
interface Props {
  phase?: SplashPhase;
  progress?: number;
  onAssetReady?: (src: string | null) => void;
}

/**
 * Authentic assets ONLY. The icon and complete logo are independent screens,
 * never layered together and never rebuilt with CSS letters/car/crown.
 * Uploaded company artwork takes precedence over JMR's packaged assets.
 */
export function BrandSplash({ phase = 'loading', progress = 0, onAssetReady }: Props) {
  const brand = useBranding();
  const { t } = useI18n();
  const jmr = isJmrBrand(brand.name) || !brand.name;
  const logo = brand.logo ?? (jmr ? '/branding/jmr-logo.png' : null);
  const introIcon = !brand.logo && jmr ? '/branding/jmr-icon.png' : null;
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = Boolean(logo && logo === brokenSrc);
  const value = Math.max(0, Math.min(100, Number.isFinite(progress) ? Math.round(progress) : 0));

  useEffect(() => {
    if (!logo) onAssetReady?.(null);
  }, [logo, onAssetReady]);

  return (
    <div className={`jmr-splash jmr-splash--${introIcon ? phase : (phase === 'icon' ? 'logo' : phase)}`} role="status"
      aria-live="polite" aria-label={t('common.loading')}>
      <div className="jmr-splash__ambient" aria-hidden="true" />
      <div className="jmr-splash__content">
        <div className="jmr-splash__artwork">
          {introIcon && (
            <div className="jmr-splash__icon-scene" aria-hidden="true">
              <img className="jmr-splash__icon" src={introIcon} alt="" decoding="async" />
              <span className="jmr-splash__icon-halo" />
            </div>
          )}
          <div className="jmr-splash__logo-scene">
            {logo && !broken ? (
              <img className="jmr-splash__logo" src={logo} alt=""
                decoding="async" fetchPriority="high" draggable={false}
                onLoad={() => onAssetReady?.(logo)}
                onError={() => { setBrokenSrc(logo); onAssetReady?.(logo); }} />
            ) : (
              <div className="jmr-splash__fallback">{brand.name ?? 'JMR LUXE CAR'}</div>
            )}
          </div>
        </div>
        <div className="jmr-splash__footer">
          <div className="jmr-splash__progress" role="progressbar"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}
            aria-label={t('common.loading')}
            style={{ '--splash-progress': `${value}%` } as CSSProperties}>
            <span className="jmr-splash__ring" aria-hidden="true" />
            <span className="jmr-splash__percent" aria-hidden="true">{value}%</span>
          </div>
          <p className="jmr-splash__label">{t('common.loading')}</p>
        </div>
      </div>
    </div>
  );
}
