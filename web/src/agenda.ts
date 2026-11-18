export type AgendaKind = 'reservation' | 'pickup' | 'return' | 'payment' | 'maintenance' | 'document';
export interface AgendaEvent {
  id: string;
  kind: AgendaKind;
  time: string | null;
  title: string;
  vehicle: { id: string; plate: string; make: string; model: string; photoFileId: string | null };
  branch: string;
  customer: string | null;
  reference: string | null;
  detail: string | null;
  link: string;
  overdue: boolean;
  urgent: boolean;
  amountCents: number | null;
  provisional: boolean;
}
export interface AgendaDay {
  date: string;
  today: string;
  generatedAt: string;
  truncated: boolean;
  totals: { reservations: number; pickups: number; returns: number; attention: number; outstandingCents: number };
  items: AgendaEvent[];
}
export const CASABLANCA_TZ = 'Africa/Casablanca';
export function moroccoDate(value = new Date()): string {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: CASABLANCA_TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(value);
  const get = (t: string) => p.find(x=>x.type===t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function changeDay(date: string, diff: number): string {
  const d = new Date(date + 'T12:00:00.000Z');
  d.setUTCDate(d.getUTCDate()+diff);
  return d.toISOString().slice(0,10);
}
