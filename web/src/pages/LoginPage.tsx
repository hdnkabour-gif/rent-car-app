import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { errorKey } from '../components/States';

export function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError && err.status === 401 ? t('login.invalid') : t(errorKey(err)));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-head">
          <div>
            <h1>{t('app.name')}</h1>
            <p className="muted">{t('app.tagline')}</p>
          </div>
          <LanguageSwitcher />
        </div>
        <form onSubmit={onSubmit} noValidate>
          <h2>{t('login.title')}</h2>
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
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('login.password')}</span>
            <input
              type="password"
              name="password"
              dir="ltr"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !email || !password}>
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
