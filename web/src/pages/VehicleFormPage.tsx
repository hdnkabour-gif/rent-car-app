import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../api';
import { useI18n, type MessageKey } from '../i18n';
import { useApi } from '../useApi';
import { ErrorState, Loading, errorKey } from '../components/States';
import { PageHeader } from '../components/PageHeader';
import type { Branch, Vehicle, VehicleCatalog } from '../vehicles';
import { centsToInput, parseMoney } from '../reservations';

interface FormState {
  branchId: string;
  plate: string;
  internalCode: string;
  make: string;
  model: string;
  catalogModelId: string;
  catalogGenerationId: string;
  catalogEngineId: string;
  version: string;
  modelYear: string;
  firstRegistrationDate: string;
  dailyRate: string;
  deposit: string;
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
  catalogModelId: '',
  catalogGenerationId: '',
  catalogEngineId: '',
  version: '',
  modelYear: '',
  firstRegistrationDate: '',
  dailyRate: '',
  deposit: '',
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
  catalogModelId: v.catalogModelId ?? '',
  catalogGenerationId: v.catalogGenerationId ?? '',
  catalogEngineId: v.catalogEngineId ?? '',
  version: v.version ?? '',
  modelYear: v.modelYear ? String(v.modelYear) : '',
  firstRegistrationDate: v.firstRegistrationDate ?? '',
  dailyRate: centsToInput(v.dailyRateCents),
  deposit: centsToInput(v.depositCents),
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
  const catalog = useApi<VehicleCatalog>('/vehicle-catalog');
  if (branches.error) return <ErrorState error={branches.error} onRetry={branches.reload} />;
  if (existing.error) return <ErrorState error={existing.error} onRetry={existing.reload} />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={catalog.reload} />;
  if (!branches.data || !catalog.data || (editing && !existing.data)) return <Loading />;
  return <VehicleForm id={id} branches={branches.data.items.filter((b) => b.isActive)} catalog={catalog.data} initial={existing.data ? fromVehicle(existing.data.vehicle) : null} />;
}

function VehicleForm({ id, branches, catalog, initial }: { id?: string; branches: Branch[]; catalog: VehicleCatalog; initial: FormState | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [f, setF] = useState<FormState>(initial ?? { ...empty, branchId: branches.length === 1 ? branches[0]!.id : '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [brandChoice, setBrandChoice] = useState(() => catalog.brands.find((b) => b.name === initial?.make)?.id ?? (initial?.make ? '__other__' : ''));
  const [modelChoice, setModelChoice] = useState(() => {
    const brand = catalog.brands.find((b) => b.name === initial?.make);
    const model = brand ? catalog.models.find((m) => m.brandId === brand.id && m.name === initial?.model) : undefined;
    return model?.id ?? (initial?.model ? '__other__' : '');
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const selectedBrand = catalog.brands.find((b) => b.id === brandChoice);
  const catalogModels = selectedBrand ? catalog.models.filter((m) => m.brandId === selectedBrand.id) : [];
  const selectedModel = catalogModels.find((m) => m.id === modelChoice);
  const generations = selectedModel ? catalog.generations.filter((g) => g.modelId === selectedModel.id) : [];
  const selectedGeneration = generations.find((g) => g.id === f.catalogGenerationId);
  const engines = selectedGeneration ? catalog.engines.filter((e) => e.generationId === selectedGeneration.id) : [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (Number.isNaN(parseMoney(f.dailyRate)) || Number.isNaN(parseMoney(f.deposit))) {
      setError(t('error.moneyInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const body = {
      branchId: f.branchId,
      plate: f.plate,
      internalCode: f.internalCode || null,
      make: f.make,
      model: f.model,
      catalogModelId: f.catalogModelId || null,
      catalogGenerationId: f.catalogGenerationId || null,
      catalogEngineId: f.catalogEngineId || null,
      version: f.version || null,
      modelYear: f.modelYear ? Number(f.modelYear) : null,
      firstRegistrationDate: f.firstRegistrationDate || null,
      dailyRateCents: parseMoney(f.dailyRate),
      depositCents: parseMoney(f.deposit),
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
      if (err instanceof ApiError && err.details) setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, t('customers.fieldInvalid')])));
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
          <label className="field">
            <span>{t('vehicles.make')}</span>
            <select required value={brandChoice} onChange={(e) => {
              const value = e.target.value;
              const brand = catalog.brands.find((b) => b.id === value);
              setBrandChoice(value);
              setModelChoice('');
              setF((x) => ({ ...x, make: brand?.name ?? '', model: '', catalogModelId: '', catalogGenerationId: '', catalogEngineId: '' }));
            }}>
              <option value="">—</option>
              {catalog.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              <option value="__other__">{t('vehicles.catalogOther')}</option>
            </select>
          </label>
          {brandChoice === '__other__' && text('make', 'vehicles.make', { required: true })}
          {selectedBrand ? (
            <label className="field">
              <span>{t('vehicles.model')}</span>
              <select required value={modelChoice} onChange={(e) => {
                const value = e.target.value;
                const model = catalogModels.find((m) => m.id === value);
                setModelChoice(value);
                setF((x) => ({ ...x, model: model?.name ?? '', catalogModelId: model?.id ?? '', catalogGenerationId: '', catalogEngineId: '' }));
              }}>
                <option value="">—</option>
                {catalogModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                <option value="__other__">{t('vehicles.catalogOther')}</option>
              </select>
              {selectedModel?.notes && <small className="hint">{selectedModel.notes}</small>}
            </label>
          ) : text('model', 'vehicles.model', { required: true })}
          {selectedBrand && modelChoice === '__other__' && text('model', 'vehicles.model', { required: true })}
          {selectedModel && generations.length > 0 && (
            <label className="field">
              <span>{t('vehicles.generation')}</span>
              <select value={f.catalogGenerationId} onChange={(e) => setF((x) => ({ ...x, catalogGenerationId: e.target.value, catalogEngineId: '' }))}>
                <option value="">{t('vehicles.generationUnspecified')}</option>
                {generations.map((g) => <option key={g.id} value={g.id}>{g.label} · {g.verificationStatus}</option>)}
              </select>
              {selectedGeneration?.notes && <small className="hint">{selectedGeneration.notes}</small>}
            </label>
          )}
          {selectedGeneration && engines.length > 0 && (
            <label className="field">
              <span>{t('vehicles.engineReference')}</span>
              <select value={f.catalogEngineId} onChange={(e) => set('catalogEngineId', e.target.value)}>
                <option value="">{t('vehicles.engineUnspecified')}</option>
                {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.commercialVersion} · {engine.verificationStatus}</option>)}
              </select>
              {f.catalogEngineId && engines.find((engine) => engine.id === f.catalogEngineId)?.notes && <small className="hint">{engines.find((engine) => engine.id === f.catalogEngineId)?.notes}</small>}
            </label>
          )}
          <small className="hint field-wide">{t('vehicles.catalogHint')}</small>
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
          {text('dailyRate', 'vehicles.dailyRate', { ltr: true })}
          {text('deposit', 'vehicles.deposit', { ltr: true })}
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
