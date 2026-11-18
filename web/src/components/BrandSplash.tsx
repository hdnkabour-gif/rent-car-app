import { useBranding, isJmrBrand } from '../branding';
import { useI18n } from '../i18n';
import './BrandSplash.css';

/** First boot / session refresh only. Stays visible until /auth/me resolves.
 * Not a forced 2-second delay, and never blocks the guest intake flow.
 */
export function BrandSplash() {
  const brand = useBranding();
  const { t } = useI18n();
  const jmr = isJmrBrand(brand.name) || !brand.name;
  const logo = brand.logo ?? (jmr ? '/branding/jmr-lockup.svg' : null);
  return (
    <div className="jmr-splash" role="status" aria-live="polite" aria-label={t('common.loading')}>
      <div className="jmr-splash__ribbon jmr-splash__ribbon--upper" aria-hidden="true" />
      <div className="jmr-splash__ribbon jmr-splash__ribbon--lower" aria-hidden="true" />
      <div className="jmr-splash__content">
        <div className="jmr-splash__logo-frame">
          {logo ? (
            <img className="jmr-splash__logo" src={logo} alt="" draggable={false} />
          ) : (
            <div className="jmr-splash__fallback">{brand.name}</div>
          )}
          <div className="jmr-splash__shimmer" aria-hidden="true" />
        </div>
        <span className="jmr-splash__subline" aria-hidden="true">
          {jmr ? 'EXCELLENCE · MOBILITÉ · CONFIANCE' : brand.city}
        </span>
        <div className="jmr-splash__progress" aria-hidden="true">
          <span className="jmr-splash__ring" />
        </div>
        <p className="jmr-splash__label">{t('common.loading')}</p>
      </div>
    </div>
  );
}
