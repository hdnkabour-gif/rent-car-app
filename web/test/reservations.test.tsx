import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, type Lang } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';
import { addDaysLocal, formatMoney, parseMoney } from '../src/reservations';

/** Synthetic data only. */
const RID = '88888888-2222-4333-8444-555555555555';
const CID = '44444444-2222-4333-8444-555555555555';
const V1 = '11111111-2222-4333-8444-555555555555';
const V2 = '22222222-3333-4333-8444-555555555555';

const employeeMe = {
  user: { id: 'e1', email: 'e@example.test', fullName: 'Sara Employée', role: 'employee', preferredLanguage: 'fr' },
  permissions: ['customers.manage', 'customers.read', 'dashboard.view', 'reservations.manage', 'reservations.read', 'vehicles.read'],
  branchIds: ['b1'],
};
const managerMe = { ...employeeMe, user: { ...employeeMe.user, role: 'manager' }, permissions: [...employeeMe.permissions, 'pricing.change'] };

const reservation = {
  id: RID,
  number: 7,
  reference: 'R-00007',
  status: 'confirmed',
  startAt: '2030-01-10T09:00:00Z',
  endAt: '2030-01-13T09:00:00Z',
  startLocal: '2030-01-10T10:00',
  endLocal: '2030-01-13T10:00',
  days: 3,
  customer: { id: CID, fullName: 'Client Démo', phone: '0600000001', blocked: false },
  vehicle: { id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', status: 'available' },
  branch: { id: 'b1', name: 'Casablanca' },
  returnBranch: { id: 'b1', name: 'Casablanca' },
  pickupPlace: 'airport',
  pickupDetails: 'Vol AT 800',
  returnPlace: 'agency',
  returnDetails: null,
  listDailyCents: 30000,
  dailyCents: 30000,
  priceReason: null,
  totalCents: 90000,
  depositCents: 300000,
  notes: null,
  cancelReason: null,
  createdBy: 'Sara Employée',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
};
const customer = { id: CID, fullName: 'Client Démo', phone: '0600000001', blocked: null };
const vehicles = [
  { id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', category: null, transmission: 'manual', fuelType: 'diesel', seats: 5, status: 'available', dailyRateCents: 30000, depositCents: 300000, branch: { id: 'b1', name: 'Casablanca' }, available: true, conflictReference: null },
  { id: V2, plate: '99992-أ-1', make: 'Renault', model: 'Clio', category: null, transmission: 'manual', fuelType: 'petrol', seats: 5, status: 'available', dailyRateCents: 35000, depositCents: null, branch: { id: 'b1', name: 'Casablanca' }, available: false, conflictReference: 'R-00003' },
];

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}
type Handler = (url: string, init: RequestInit) => Promise<Response> | undefined;
function mockFetch(me: unknown, extra: Handler = () => undefined) {
  const m = vi.fn((url: string, init: RequestInit = {}) => {
    const x = extra(url, init);
    if (x) return x;
    if (url === '/api/auth/me') return json(200, me);
    if (url.startsWith('/api/reservations/availability')) return json(200, { items: vehicles });
    if (url.startsWith('/api/reservations/quote'))
      return json(200, { days: 3, listDailyCents: 30000, dailyCents: 30000, totalCents: 90000, depositCents: 300000, priceChanged: false, warnings: ['customer_licence_missing'], conflicts: [], available: true });
    if (url === `/api/reservations/${RID}`)
      return json(200, {
        reservation,
        events: [
          { id: 1, event: 'created', changes: {}, reason: null, at: '2026-11-04T10:00:00Z', by: 'Sara Employée' },
          { id: 2, event: 'changed', changes: { totalCents: { from: 60000, to: 90000 } }, reason: null, at: '2026-11-04T11:00:00Z', by: 'Sara Employée' },
        ],
      });
    if (url.startsWith('/api/reservations?')) return json(200, { items: [reservation] });
    if (url === '/api/reservations/summary') return json(200, { departures: 2, returns: 1, upcoming: 5 });
    if (url === `/api/customers/${CID}`) return json(200, { customer });
    if (url === '/api/branches') return json(200, { items: [] });
    return json(404, {});
  });
  vi.stubGlobal('fetch', m);
  return m;
}
function renderAt(path: string, lang: Lang = 'fr') {
  return render(
    <I18nProvider initial={lang}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}
const calls = (m: ReturnType<typeof vi.fn>, method: string, url: string) =>
  m.mock.calls.filter(([u, i]) => String(u).startsWith(url) && ((i as RequestInit | undefined)?.method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('money and dates (unit)', () => {
  it('parses MAD amounts into integer centimes and formats them back', () => {
    expect(parseMoney('300')).toBe(30000);
    expect(parseMoney('300,50')).toBe(30050);
    expect(parseMoney(' 1 200.5 ')).toBe(120050);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('3oo')).toBeNaN();
    expect(formatMoney(30000, 'fr').replace(/\s/g, ' ')).toMatch(/300,00/);
    expect(addDaysLocal('2026-12-30T10:00', 3)).toBe('2027-01-02T10:00');
  });
});

describe('reservation screens', () => {
  it('list: reference, customer, status in words and total; home shows today’s departures and returns', async () => {
    mockFetch(employeeMe);
    renderAt('/reservations');
    const card = (await screen.findByText(/Client Démo/)).closest('a') as HTMLElement;
    expect(within(card).getByText('R-00007').getAttribute('dir')).toBe('ltr');
    expect(within(card).getByText('Confirmée')).toBeTruthy();
    expect(within(card).getByText(/900,00/)).toBeTruthy();
    vi.unstubAllGlobals();
    mockFetch(employeeMe);
  });

  it('home screen tiles', async () => {
    mockFetch(employeeMe);
    renderAt('/');
    expect(await screen.findByText('départ(s) aujourd’hui')).toBeTruthy();
    expect(screen.getByText('retour(s) aujourd’hui')).toBeTruthy();
    expect(within(document.querySelector('.bottom-nav') as HTMLElement).getByRole('link', { name: /Réservations/ })).toBeTruthy();
  });

  it('form: preset customer, taken vehicle disabled, live price and warnings, then saves the right body', async () => {
    const m = mockFetch(employeeMe, (url, init) => (url === '/api/reservations' && init.method === 'POST' ? json(201, { reservation, warnings: [] }) : undefined));
    const user = userEvent.setup();
    renderAt(`/reservations/new?customerId=${CID}`);
    expect(await screen.findByText('Client Démo')).toBeTruthy();
    const taken = (await screen.findByText('Déjà réservée (R-00003)')).closest('button') as HTMLButtonElement;
    expect(taken.disabled).toBe(true);
    // Employee without the pricing right: no price field.
    expect(screen.getByText('Seule une personne autorisée peut changer le prix.')).toBeTruthy();
    expect(screen.queryByLabelText('Prix convenu par jour (MAD)')).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Dacia Logan/ }));
    await user.click(within(screen.getByRole('group', { name: 'Lieu de départ' })).getByRole('button', { name: 'Aéroport' }));
    await user.type(screen.getByLabelText(/^Précisions/), 'Vol AT 800');
    expect(await screen.findByText('Le permis du client n’est pas enregistré.')).toBeTruthy();
    expect(screen.getByText(/900,00/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Enregistrer la réservation' }));
    const [post] = calls(m, 'POST', '/api/reservations').filter(([u]) => u === '/api/reservations');
    const body = JSON.parse(String(post![1]!.body));
    expect(body).toMatchObject({ customerId: CID, vehicleId: V1, pickupPlace: 'airport', pickupDetails: 'Vol AT 800', returnPlace: 'agency' });
    expect(body.start).toMatch(/^\d{4}-\d{2}-\d{2}T10:00$/);
    expect(body.dailyCents).toBeUndefined();
    expect(await screen.findByText('Réservation enregistrée.')).toBeTruthy();
  });

  it('a manager may agree another price; a reason is then required', async () => {
    const m = mockFetch(managerMe, (url) =>
      url.startsWith('/api/reservations/quote')
        ? json(200, { days: 3, listDailyCents: 30000, dailyCents: 25000, totalCents: 75000, depositCents: 300000, priceChanged: true, warnings: [], conflicts: [], available: true })
        : undefined,
    );
    const user = userEvent.setup();
    renderAt(`/reservations/new?customerId=${CID}&vehicleId=${V1}`);
    await user.type(await screen.findByLabelText('Prix convenu par jour (MAD)'), '250');
    const reason = await screen.findByLabelText(/^Motif du prix/);
    const save = screen.getByRole('button', { name: 'Enregistrer la réservation' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(reason, 'Client fidèle');
    expect(save.disabled).toBe(false);
    const quotes = calls(m, 'POST', '/api/reservations/quote');
    expect(JSON.parse(String(quotes.at(-1)![1]!.body)).dailyCents).toBe(25000);
  });

  it('a conflict at save time is explained in plain words', async () => {
    mockFetch(employeeMe, (url, init) =>
      url === '/api/reservations' && init.method === 'POST' ? json(409, { error: { code: 'vehicle_unavailable', message: 'x' } }) : undefined,
    );
    const user = userEvent.setup();
    renderAt(`/reservations/new?customerId=${CID}&vehicleId=${V1}`);
    await screen.findByText(/900,00/);
    await user.click(screen.getByRole('button', { name: 'Enregistrer la réservation' }));
    expect(await screen.findByText(/Ce véhicule est déjà réservé sur une partie de ces dates/)).toBeTruthy();
  });

  it('detail: history with translated fields and money; cancelling needs a reason', async () => {
    const m = mockFetch(employeeMe, (url) => (url.endsWith('/cancel') ? json(200, { reservation: { ...reservation, status: 'cancelled' } }) : undefined));
    const user = userEvent.setup();
    renderAt(`/reservations/${RID}`);
    expect(await screen.findByText('Réservation modifiée')).toBeTruthy();
    expect(screen.getByText(/Total :/)).toBeTruthy();
    expect(screen.getByText(/Aéroport — Vol AT 800/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Annuler la réservation' }));
    const submit = screen.getAllByRole('button', { name: 'Annuler la réservation' }).at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('Motif (obligatoire)'), 'Le client a annulé');
    await user.click(submit);
    expect(JSON.parse(String(calls(m, 'POST', `/api/reservations/${RID}/cancel`)[0]![1]!.body))).toEqual({ reason: 'Le client a annulé' });
  });

  it('Arabic: statuses and places are translated, reference stays LTR', async () => {
    mockFetch({ ...employeeMe, user: { ...employeeMe.user, preferredLanguage: 'ar' } });
    renderAt(`/reservations/${RID}`, 'ar');
    expect(await screen.findByText('مؤكدة')).toBeTruthy();
    expect(screen.getByText(/المطار/)).toBeTruthy();
    expect(screen.getByText('R-00007').closest('bdi')?.getAttribute('dir')).toBe('ltr');
  });
});
