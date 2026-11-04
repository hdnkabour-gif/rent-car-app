import { useState, type FormEvent } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { PageHeader } from '../components/PageHeader';
import { errorKey } from '../components/States';

const MIN_PASSWORD = 10;

/** Every account (manager or employee): own password and sign-out from all devices. */
export function AccountPage() {
  const { me, refresh } = useAuth();
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!me) return null;
  const mismatch = confirm !== '' && confirm !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(t('account.mismatch'));
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setConfirm('');
      setNotice(t('account.changed'));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_current_password' ? t('account.wrongCurrent') : t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const logoutAll = async () => {
    setError(null);
    try {
      await api('/auth/logout-all', { method: 'POST' });
    } catch (err) {
      setError(t(errorKey(err)));
      return;
    }
    await refresh();
  };

  const pw = (id: string, label: string, value: string, set: (v: string) => void, auto: string, invalid = false) => (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="password"
        dir="ltr"
        autoComplete={auto}
        required
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );

  return (
    <section>
      <PageHeader title={t('account.title')} subtitle={`${me.user.fullName} · ${t(me.user.role === 'manager' ? 'role.manager' : 'role.employee')}`} />
      <p className="muted small" dir="ltr">
        {me.user.email}
      </p>
      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <form className="card form-card" onSubmit={submit} noValidate>
        <h2>
          <KeyRound size={20} aria-hidden="true" /> {t('account.changePassword')}
        </h2>
        <div className="grid">
          {pw('current-password', t('account.currentPassword'), current, setCurrent, 'current-password')}
          {pw('new-password', t('account.newPassword'), next, setNext, 'new-password')}
          {pw('confirm-password', t('account.confirmPassword'), confirm, setConfirm, 'new-password', mismatch)}
        </div>
        {mismatch && <small className="field-error">{t('account.mismatch')}</small>}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !current || next.length < MIN_PASSWORD || next !== confirm}>
            {busy ? t('common.saving') : t('account.changePassword')}
          </button>
        </div>
      </form>
      <div className="card">
        <button type="button" className="btn" onClick={() => void logoutAll()}>
          <LogOut size={18} aria-hidden="true" className="flip-rtl" /> {t('account.logoutAll')}
        </button>
      </div>
    </section>
  );
}
