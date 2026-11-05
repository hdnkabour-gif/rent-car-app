import { useI18n } from '../i18n';

/** Fuel in eighths (0 = empty, 8 = full), shown the way agencies say it: 1/4, 1/2, 3/4, plein. */
export function fuelLabel(e: number | null, t: ReturnType<typeof useI18n>['t']): string {
  if (e === null) return t('vehicles.unknownFuel');
  if (e === 0) return t('fuel.empty');
  if (e === 8) return t('fuel.full');
  if (e === 2) return t('fuel.quarter');
  if (e === 4) return t('fuel.half');
  if (e === 6) return t('fuel.threeQuarters');
  return `${e}/8`;
}

export function FuelGauge({ eighths }: { eighths: number | null }) {
  const { t } = useI18n();
  return (
    <span className="fuel-gauge" title={fuelLabel(eighths, t)}>
      <span className="fuel-bar" aria-hidden="true">
        <span className="fuel-fill" style={{ width: `${((eighths ?? 0) / 8) * 100}%` }} />
      </span>
      <span>{fuelLabel(eighths, t)}</span>
    </span>
  );
}

/** Nine big buttons, thumb-friendly: Vide … Plein. */
export function FuelPicker({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="fuel-picker" role="radiogroup" aria-label={t('vehicles.fuel')}>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          className={value === e ? 'active' : ''}
          onClick={() => onChange(e)}
        >
          {fuelLabel(e, t)}
        </button>
      ))}
    </div>
  );
}
