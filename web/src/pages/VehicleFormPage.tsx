import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import type { Branch, Vehicle } from '../vehicles';

interface FormState {
  branchId: string;
  plate: string;
  internalCode: string;
  make: string;
  model: string;
  version: string;
  modelYear: string;
  firstRegistrationDate: string;
  color: string;
  fuelType: Vehicle['fuelType'];
  transmission: Vehicle['transmission'];
  seats: string;
  category: string;
  vin: string;
  notes: string;
  mileageKm: string;
}

const empty: FormState = {
  branchId: '',
  plate: '',
  internalCode: '',
  make: '',
  model: '',
  version: '',
  modelYear: '',
  firstRegistrationDate: '',
  color: '',
  fuelType: 'diesel',
  transmission: 'manual',
  seats: '5',
  category: '',
  vin: '',
  notes: '',
  mileageKm: '0',
};

const fromVehicle = (v: Vehicle): FormState => ({
  branchId: v.branch.id,
  plate: v.plate,
  internalCode: v.internalCode ?? '',
  make: v.make,
  model: v.model,
  version: v.version ?? '',
  modelYear: v.modelYear ? String(v.modelYear) : '',
  firstRegistrationDate: v.firstRegistrationDate ?? '',
  color: v.color ?? '',
  fuelType: v.fuelType,
  transmission: v.transmission,
  seats: v.seats ? String(v.seats) : '',
  category: v.category ?? '',
  vin: v.vin ?? '',
  notes: v.notes ?? '',
  mileageKm: String(v.mileageKm),
});

export function VehicleFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const branches = useApi<{ items: Branch[] }>('/branches');
  const existing = useApi<{ vehicle: Vehicle }>(editing ? `/vehicles/${id}` : null);
  if (branches.error) return <ErrorState error={branches.error} onRetry={branches.reload} />;
  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;
  if (!branches.data || (editing && !existing.data)) return <Loading />;
  return <VehicleForm id={id} branches={branches.data.items.filter((b) => b.isActive)} initial={existing.data ? fromVehicle(existing.data.vehicle) : null} />;
}

function VehicleForm({ id, branches, initial }: { id?: string; branches: Branch[]; initial: FormState | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [f, setF] = useState<FormState>(initial ?? { ...empty, branchId: branches.length === 1 ? branches[0]!.id : '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const body = {
      branchId: f.branchId,
      plate: f.plate,
      internalCode: f.internalCode || null,
      make: f.make,
      model: f.model,
      version: f.version || null,
      modelYear: f.modelYear ? Number(f.modelYear) : null,
      firstRegistrationDate: f.firstRegistrationDate || null,
      color: f.color || null,
      fuelType: f.fuelType,
      transmission: f.transmission,
      seats: f.seats ? Number(f.seats) : null,
      category: f.category || null,
      vin: f.vin || null,
      notes: f.notes || null,
      ...(id ? {} : { mileageKm: Number(f.mileageKm || 0) }),
    };
    try {
      const saved = await api<{ id: string }>(id ? `/vehicles/${id}` : '/vehicles', { method: id ? 'PUT' : 'POST', body });
      navigate(`/vehicles/${saved.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.details) setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
      setError(
        err instanceof ApiError && err.status === 409
          ? t(/plate/i.test(err.message) ? 'vehicles.duplicatePlate' : /internal code/i.test(err.message) ? 'vehicles.duplicateCode' : 'vehicles.cannotEdit')
          : t(errorKey(err)),
      );
    } finally {
      setBusy(false);
    }
  };

  const text = (k: keyof FormState, label: MessageKey, opts: { ltr?: boolean; required?: boolean; type?: string; hint?: MessageKey } = {}) => (
    <label className="field" key={k}>
      <span>{t(label)}</span>
      <input
        type={opts.type ?? 'text'}
        inputMode={opts.type === 'number' ? 'numeric' : undefined}
        dir={opts.ltr ? 'ltr' : undefined}
        required={opts.required}
        value={f[k]}
        aria-invalid={fieldErrors[k] ? true : undefined}
        onChange={(e) => set(k, e.target.value as never)}
      />
      {opts.hint && <small className="hint">{t(opts.hint)}</small>}
      {fieldErrors[k] && <small className="field-error">{fieldErrors[k]}</small>}
    </label>
  );

  return (
    <section>
      <Link to={id ? `/vehicles/${id}` : '/vehicles'} className="back-link">
        <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t('vehicles.back')}
      </Link>
      <PageHeader title={id ? t('vehicles.edit') : t('vehicles.add')} subtitle={id ? undefined : t('vehicles.initialHint')} />
      <form className="card" onSubmit={submit} noValidate>
        <div className="grid">
          <label className="field">
            <span>{t('vehicles.branch')}</span>
            <select required value={f.branchId} onChange={(e) => set('branchId', e.target.value)}>
              <option value="" disabled>
                —
              </option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {text('plate', 'vehicles.plate', { required: true, ltr: true, hint: 'vehicles.plateHint' })}
          {text('make', 'vehicles.make', { required: true })}
          {text('model', 'vehicles.model', { required: true })}
          <label className="field">
            <span>{t('vehicles.fuelType')}</span>
            <select value={f.fuelType} onChange={(e) => set('fuelType', e.target.value as FormState['fuelType'])}>
              {(['diesel', 'petrol', 'hybrid', 'electric', 'lpg'] as const).map((x) => (
                <option key={x} value={x}>
                  {t(`fuel.${x}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>{t('vehicles.transmission')}</span>
            <div className="segmented segmented-wide" role="group" aria-label={t('vehicles.transmission')}>
              {(['manual', 'automatic'] as const).map((x) => (
                <button key={x} type="button" aria-pressed={f.transmission === x} className={f.transmission === x ? 'active' : ''} onClick={() => set('transmission', x)}>
                  {t(`gearbox.${x}` as MessageKey)}
                </button>
              ))}
            </div>
          </div>
          {!id && text('mileageKm', 'vehicles.initialMileage', { type: 'number', ltr: true })}
          {text('modelYear', 'vehicles.modelYear', { type: 'number', ltr: true })}
          {text('firstRegistrationDate', 'vehicles.firstRegistrationDate', { type: 'date', ltr: true })}
          {text('version', 'vehicles.version')}
          {text('color', 'vehicles.color')}
          {text('seats', 'vehicles.seats', { type: 'number', ltr: true })}
          {text('category', 'vehicles.category')}
          {text('internalCode', 'vehicles.internalCode', { ltr: true })}
          {text('vin', 'vehicles.vin', { ltr: true })}
          <label className="field field-wide">
            <span>{t('vehicles.notes')}</span>
            <textarea rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </div>
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !f.branchId || !f.plate || !f.make || !f.model}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
