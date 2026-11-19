import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';
import { BrandMark, isJmrBrand, useBranding } from '../branding';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { errorKey } from '../components/States';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const brand = useBranding();
  const company = brand.name ?? t('app.name');
  const showJmrLockup = isJmrBrand(brand.name) && !brand.logo;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError(t('login.invalidEmail'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError && err.status === 401 ? t('login.invalid') : t(errorKey(err)));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-hero" aria-hidden="true">
        {showJmrLockup ? (
          <div className="hero-logo hero-logo--jmr">
            <img src="/branding/jmr-logo.png" alt="" className="jmr-hero-lockup" />
            <strong className="jmr-login-wordmark">JMR LUXE CAR</strong>
            <span className="jmr-login-tagline">LOCATION DE VOITURES</span>
            {brand.city && <div className="hero-city">{brand.city}</div>}
          </div>
        ) : (
          <div className="hero-logo">
            <BrandMark size={72} className="hero-mark" />
            <div>
              <div className="hero-company">{company}</div>
              {brand.city && <div className="hero-city">{brand.city}</div>}
            </div>
          </div>
        )}
        <p className="hero-tagline">{brand.name ? t('login.companyTagline') : t('app.tagline')}</p>
        <ul className="hero-features">
          {(['login.feature1', 'login.feature2', 'login.feature3'] as const).map((k) => (
            <li key={k}>
              <Check size={18} /> {t(k)}
            </li>
          ))}
        </ul>
        <p className="hero-powered">{t('brand.poweredBy')}</p>
      </section>

      <section className="login-panel">
        <div className="login-lang">
          <LanguageSwitcher full />
        </div>
        <form className="login-card" onSubmit={onSubmit} noValidate>
          <div className="login-mobile-logo" aria-hidden="true">
            {showJmrLockup ? <img src="/branding/jmr-icon-192.png" className="jmr-login-mark" alt="" /> : <BrandMark size={52} />}
            <span>{company}</span>
          </div>
          <h1>{t('login.welcome')}</h1>
          <p className="muted">{t('login.subtitle')}</p>
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            <span>{t('login.email')}</span>
            <input
              type="email"
              name="email"
              dir="ltr"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <div className="field">
            <label htmlFor="login-password">{t('login.password')}</label>
            <span className="input-with-button">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                name="password"
                dir="ltr"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                title={showPassword ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
              </button>
            </span>
          </div>
          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting || !email || !password}>
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
          <p className="muted small center">{t('login.help')}</p>
        </form>
      </section>
    </div>
  );
}
