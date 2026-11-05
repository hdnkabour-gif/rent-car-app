import { useState, type FormEvent } from 'react';
import { MapPin, Plus, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { useI18n } from '../i18n';
import { useApi } from '../useApi';
import { Empty, ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import type { Branch } from '../vehicles';

type Draft = { code: string; name: string; city: string; address: string; phone: string; isActive: boolean };
const blank: Draft = { code: '', name: '', city: '', address: '', phone: '', isActive: true };

export function BranchesPage() {
  const { t } = useI18n();
  const { data, error, reload } = useApi<{ items: Branch[] }>('/branches');
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    const d = editing.draft;
    try {
      await api(editing.id ? `/branches/${editing.id}` : '/branches', {
        method: editing.id ? 'PUT' : 'POST',
        body: { ...d, address: d.address || null, phone: d.phone || null },
      });
      setEditing(null);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError && err.status === 409 ? t('branches.duplicate') : t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setEditing((x) => (x ? { ...x, draft: { ...x.draft, [k]: v } } : x));

  return (
    <section>
      <PageHeader
        title={t('branches.title')}
        subtitle={t('branches.subtitle')}
        actions={
          !editing && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing({ id: null, draft: blank })}>
              <Plus size={18} aria-hidden="true" /> {t('branches.add')}
            </button>
          )
        }
      />

      {editing && (
        <form className="card form-card" onSubmit={save}>
          <div className="card-head">
            <h2>{editing.id ? editing.draft.name : t('branches.add')}</h2>
            <button type="button" className="icon-btn" aria-label={t('common.cancel')} onClick={() => setEditing(null)}>
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="grid">
            <label className="field">
              <span>{t('branches.code')}</span>
              <input dir="ltr" required maxLength={6} value={editing.draft.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />
            </label>
            <label className="field">
              <span>{t('branches.name')}</span>
              <input required value={editing.draft.name} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label className="field">
              <span>{t('branches.city')}</span>
              <input required value={editing.draft.city} onChange={(e) => set('city', e.target.value)} />
            </label>
            <label className="field">
              <span>{t('branches.address')}</span>
              <input value={editing.draft.address} onChange={(e) => set('address', e.target.value)} />
            </label>
            <label className="field">
              <span>{t('branches.phone')}</span>
              <input type="tel" dir="ltr" value={editing.draft.phone} onChange={(e) => set('phone', e.target.value)} />
            </label>
            <label className="check field">
              <input type="checkbox" checked={editing.draft.isActive} onChange={(e) => set('isActive', e.target.checked)} />
              {t('branches.active')}
            </label>
          </div>
          {formError && (
            <div className="alert alert-error" role="alert">
              {formError}
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !editing.draft.code || !editing.draft.name || !editing.draft.city}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      )}

      {data.items.length === 0 ? (
        <Empty />
      ) : (
        <ul className="people-list">
          {data.items.map((b) => (
            <li key={b.id} className={`person-card card${b.isActive ? '' : ' inactive'}`}>
              <span className="avatar avatar-lg" aria-hidden="true">
                <MapPin size={20} />
              </span>
              <div className="person-body">
                <div className="person-name">
                  <strong>{b.name}</strong>
                  <span className="chip" dir="ltr">
                    {b.code}
                  </span>
                </div>
                <div className="muted small">
                  {b.city}
                  {b.address ? ` · ${b.address}` : ''}
                  {b.phone ? ' · ' : ''}
                  {b.phone && <span dir="ltr">{b.phone}</span>}
                </div>
                <div className="person-tags">
                  <span className={`badge ${b.isActive ? 'badge-success' : 'badge-failure'}`}>
                    {b.isActive ? t('branches.active') : t('branches.inactive')}
                  </span>
                  <span className="muted small">{t('branches.vehicles', { n: String(b.vehicleCount) })}</span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  setEditing({
                    id: b.id,
                    draft: { code: b.code, name: b.name, city: b.city, address: b.address ?? '', phone: b.phone ?? '', isActive: b.isActive },
                  })
                }
              >
                {t('vehicles.edit')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
