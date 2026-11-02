import { useState, type FormEvent } from 'react';
import { UserPlus, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { Empty, ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import { useApi } from '../useApi';

interface UserDto {
  id: string;
  email: string;
  fullName: string;
  role: 'manager' | 'employee';
  isActive: boolean;
  lastLoginAt: string | null;
}

const EMPTY_FORM = { fullName: '', email: '', role: 'employee' as 'manager' | 'employee', password: '' };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export function UsersPage() {
  const { me, can } = useAuth();
  const { t, formatDateTime } = useI18n();
  const canManage = can('users.manage');
  const { data, error, reload } = useApi<{ items: UserDto[] }>('/users');
  const users = data?.items ?? null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setActionError(null);
    setNotice(null);
    try {
      await api('/users', { method: 'POST', body: form });
      setForm(EMPTY_FORM);
      setShowForm(false);
      setNotice(t('users.created'));
      reload();
    } catch (err) {
      setActionError(t(errorKey(err)));
    } finally {
      setCreating(false);
    }
  };

  const setActive = async (u: UserDto, isActive: boolean) => {
    setActionError(null);
    setConfirmId(null);
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body: { isActive } });
      reload();
    } catch (err) {
      setActionError(t(errorKey(err)));
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!users) return <Loading />;

  return (
    <section>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          canManage &&
          !showForm && (
            <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
              <UserPlus size={18} aria-hidden="true" /> {t('users.create')}
            </button>
          )
        }
      />
      {actionError && (
        <div className="alert alert-error" role="alert">
          {actionError}
        </div>
      )}
      {notice && (
        <div className="alert alert-ok" role="status">
          {notice}
        </div>
      )}

      {canManage && showForm && (
        <form className="card form-card" onSubmit={create}>
          <div className="card-head">
            <h2>{t('users.createTitle')}</h2>
            <button type="button" className="icon-btn" aria-label={t('common.cancel')} onClick={() => setShowForm(false)}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="grid">
            <label className="field">
              <span>{t('users.fullName')}</span>
              <input required autoComplete="off" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('users.email')}</span>
              <input
                type="email"
                dir="ltr"
                inputMode="email"
                autoCapitalize="none"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <div className="field">
              <span>{t('users.role')}</span>
              <div className="segmented segmented-wide" role="group" aria-label={t('users.role')}>
                {(['employee', 'manager'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={form.role === r}
                    className={form.role === r ? 'active' : ''}
                    onClick={() => setForm({ ...form, role: r })}
                  >
                    {t(r === 'manager' ? 'role.manager' : 'role.employee')}
                  </button>
                ))}
              </div>
              <small className="hint">{t('users.roleHint')}</small>
            </div>
            <label className="field">
              <span>{t('users.initialPassword')}</span>
              <input
                type="password"
                dir="ltr"
                autoComplete="new-password"
                minLength={10}
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <small className="hint">{t('users.initialPasswordHint')}</small>
            </label>
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setShowForm(false)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? t('common.saving') : t('users.create')}
            </button>
          </div>
        </form>
      )}

      {users.length === 0 ? (
        <Empty />
      ) : (
        <ul className="people-list">
          {users.map((u) => (
            <li key={u.id} className={`person-card card${u.isActive ? '' : ' inactive'}`}>
              <span className="avatar avatar-lg" aria-hidden="true">
                {initials(u.fullName)}
              </span>
              <div className="person-body">
                <div className="person-name">
                  <strong>{u.fullName}</strong>
                  {u.id === me?.user.id && <span className="chip">{t('users.you')}</span>}
                </div>
                <div className="muted small" dir="ltr">
                  {u.email}
                </div>
                <div className="person-tags">
                  <span className={`badge ${u.role === 'manager' ? 'badge-info' : 'badge-neutral'}`}>
                    {t(u.role === 'manager' ? 'role.manager' : 'role.employee')}
                  </span>
                  <span className={`badge ${u.isActive ? 'badge-success' : 'badge-failure'}`}>
                    {u.isActive ? t('users.active') : t('users.inactive')}
                  </span>
                  <span className="muted small">
                    {t('users.lastLogin')} : {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.never')}
                  </span>
                </div>
                {confirmId === u.id && (
                  <div className="confirm-box" role="alert">
                    <p>{t('users.confirmDeactivate', { name: u.fullName })}</p>
                    <div className="actions">
                      <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                        {t('common.cancel')}
                      </button>
                      <button type="button" className="btn btn-danger" onClick={() => void setActive(u, false)}>
                        {t('common.confirm')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {canManage && u.id !== me?.user.id && confirmId !== u.id && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => (u.isActive ? setConfirmId(u.id) : void setActive(u, true))}
                >
                  {u.isActive ? t('users.deactivate') : t('users.activate')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
