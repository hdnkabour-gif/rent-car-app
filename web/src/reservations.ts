export type ReservationStatus = 'confirmed' | 'cancelled' | 'no_show' | 'in_progress' | 'completed';
export type Place = 'agency' | 'airport' | 'hotel' | 'other';
export const PLACES: Place[] = ['agency', 'airport', 'hotel', 'other'];

export interface Reservation {
  id: string;
  number: number;
  reference: string;
  status: ReservationStatus;
  startAt: string;
  endAt: string;
  startLocal: string;
  endLocal: string;
  days: number;
  customer: { id: string; fullName: string; phone: string; blocked: boolean };
  vehicle: { id: string; plate: string; make: string; model: string; status: string };
  branch: { id: string; name: string };
  returnBranch: { id: string; name: string };
  pickupPlace: Place;
  pickupDetails: string | null;
  returnPlace: Place;
  returnDetails: string | null;
  listDailyCents: number;
  dailyCents: number;
  priceReason: string | null;
  totalCents: number;
  depositCents: number;
  notes: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationEvent {
  id: number;
  event: 'created' | 'changed' | 'cancelled' | 'no_show' | 'reopened';
  changes: Record<string, unknown>;
  reason: string | null;
  at: string;
  by: string | null;
}

export type Warning =
  | 'customer_licence_expires'
  | 'customer_id_expires'
  | 'customer_licence_missing'
  | 'vehicle_not_ready'
  | 'vehicle_no_price'
  | 'start_in_past';

export interface Quote {
  days: number;
  listDailyCents: number;
  dailyCents: number;
  totalCents: number;
  depositCents: number;
  priceChanged: boolean;
  warnings: Warning[];
  conflicts: Array<{ id: string; reference: string; startAt: string; endAt: string; customerName: string }>;
  available: boolean;
}

export interface AvailableVehicle {
  id: string;
  plate: string;
  make: string;
  model: string;
  category: string | null;
  transmission: 'manual' | 'automatic';
  fuelType: string;
  seats: number | null;
  status: string;
  dailyRateCents: number | null;
  depositCents: number | null;
  branch: { id: string; name: string };
  available: boolean;
  conflictReference: string | null;
}

/** "300,00 MAD" / "300,00 د.م." — amounts are integer centimes everywhere. */
export function formatMoney(cents: number, lang: 'fr' | 'ar'): string {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { style: 'currency', currency: 'MAD' }).format(cents / 100);
}

/** "300", "300,50", "300.5" -> 30000 / 30050; empty -> null; invalid -> NaN. */
export function parseMoney(text: string): number | null {
  const t = text.replace(/\s/g, '').replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

export const centsToInput = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(c % 100 ? 2 : 0));

/** Local Casablanca "YYYY-MM-DDTHH:mm" for an input, `days` from now at `hour`. */
export function localInput(days: number, hour: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + days * 86400_000),
  );
  return `${parts}T${String(hour).padStart(2, '0')}:00`;
}

/** Adds whole days to a "YYYY-MM-DDTHH:mm" value (calendar arithmetic, no time zone shift). */
export function addDaysLocal(value: string, days: number): string {
  const d = new Date(`${value}:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 16);
}
