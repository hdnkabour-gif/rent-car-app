import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApi } from '../useApi';
import { useI18n } from '../i18n';
import { Empty, ErrorState, Loading, errorKey } from '../components/States';

interface UserDto {
  id: string;
  email: string;
  fullName: string;
  role: 'manager' | 'employee';
  isActive: boolean;
  lastLoginAt: string | null;
}

export function UsersPage() {
  const { me, can } = useAuth();
  const { t, formatDateTime } = useI18n();
  const canManage = can('users.manage');
  const { data, error, reload } = useApi<{ items: UserDto[] }>('/users');
  const users = data?.items ?? null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: '', email: '', role: 'employee' as 'manager' | 'employee', password: '' });
  const [creating, setCreating] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setActionError(null);
    setNotice(null);
    try {
      await api('/users', { method: 'POST', body: form });
      setForm({ fullName: '', email: '', role: 'employee', password: '' });
      setNotice(t('users.created'));
      reload();
    } catch (err) {
      setActionError(t(errorKey(err)));
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (u: UserDto) => {
    setActionError(null);
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body: { isActive: !u.isActive } });
      reload();
    } catch (err) {
      setActionError(t(errorKey(err)));
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!users) return <Loading />;

  return (
    <section>
      <h1>{t('users.title')}</h1>
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
      {users.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>{t('users.fullName')}</th>
                <th>{t('users.email')}</th>
                <th>{t('users.role')}</th>
                <th>{t('users.status')}</th>
                <th>{t('users.lastLogin')}</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'inactive'}>
                  <td>
                    {u.fullName} {u.id === me?.user.id && <span className="muted">{t('users.you')}</span>}
                  </td>
                  <td dir="ltr">{u.email}</td>
                  <td>{t(u.role === 'manager' ? 'role.manager' : 'role.employee')}</td>
                  <td>{u.isActive ? t('users.active') : t('users.inactive')}</td>
                  <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.never')}</td>
                  {canManage && (
                    <td>
                      {u.id !== me?.user.id && (
                        <button type="button" className="btn btn-small" onClick={() => void toggleActive(u)}>
                          {u.isActive ? t('users.deactivate') : t('users.activate')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <form className="card" onSubmit={create}>
          <h2>{t('users.create')}</h2>
          <div className="grid">
            <label className="field">
              <span>{t('users.fullName')}</span>
              <input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('users.email')}</span>
              <input type="email" dir="ltr" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('users.role')}</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'manager' | 'employee' })}>
                <option value="employee">{t('role.employee')}</option>
                <option value="manager">{t('role.manager')}</option>
              </select>
            </label>
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
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? t('common.saving') : t('users.create')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
