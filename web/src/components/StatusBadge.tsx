import { useI18n, type MessageKey } from '../i18n';
import type { VehicleStatus } from '../vehicles';

/** Colour + text (never colour alone): green ready, blue out, amber needs attention, red blocked. */
const TONE: Record<VehicleStatus, string> = {
  available: 'good',
  rented: 'info',
  inspection_pending: 'warn',
  maintenance: 'warn',
  out_of_service: 'bad',
  retired: 'muted',
};

export function StatusBadge({ status, large = false }: { status: VehicleStatus; large?: boolean }) {
  const { t } = useI18n();
  return (
    <span className={`status-badge tone-${TONE[status]}${large ? ' status-lg' : ''}`}>
      <span className="dot" aria-hidden="true" />
      {t(`status.${status}` as MessageKey)}
    </span>
  );
}
