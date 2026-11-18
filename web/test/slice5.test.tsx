import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

/** Synthetic data only. */
const B1 = 'b1111111-2222-4333-8444-555555555555';
const V1 = '11111111-2222-4333-8444-555555555555';
const me = (perms: string[], role = 'manager') => ({
  user: { id: 'm1', email: 'm@example.test', fullName: 'Gérant Démo', role, preferredLanguage: 'fr' },
  permissions: ['dashboard.view', 'vehicles.read', ...perms],
  branchIds: [B1],
});
const zero = { cash: 0, cheque: 0, card: 0, transfer: 0 };
const day = {
  date: '2026-11-05',
  totals: { rental: { ...zero, cash: 50000 }, depositIn: { ...zero, cheque: 300000 }, depositOut: zero, depositKept: zero, expenses: { ...zero, cash: 10000 } },
  expectedCashCents: 40000,
  movements: [
    { at: '2026-11-05T09:00:00Z', source: 'payment', kind: 'rental', method: 'cash', amountCents: 50000, signedCashCents: 50000, label: 'C-00001', by: 'Sara' },
    { at: '2026-11-05T10:00:00Z', source: 'expense', kind: 'expense:washing', method: 'cash', amountCents: 10000, signedCashCents: -10000, label: 'Lavage Démo', by: 'Sara' },
  ],
  closing: null,
};

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
type Handler = (url: string, init: RequestInit) => Promise<Response> | undefined;
function mockFetch(user: unknown, extra: Handler = () => undefined) {
  const m = vi.fn((url: string, init: RequestInit = {}) => {
    const x = extra(url, init);
    if (x) return x;
    if (url === '/api/auth/me') return json(200, user);
    if (url === '/api/branches') return json(200, { items: [{ id: B1, code: 'CAS', name: 'Casablanca', city: 'Casablanca', isActive: true, vehicleCount: 1 }] });
    if (url.startsWith('/api/cash/day')) return json(200, day);
    if (url.startsWith('/api/cash/expenses')) return json(200, { items: [] });
    if (url.startsWith('/api/cash/closings')) return json(200, { items: [] });
    if (url.startsWith('/api/vehicles')) return json(200, { items: [] });
    return json(404, {});
  });
  vi.stubGlobal('fetch', m);
  return m;
}
const renderAt = (path: string) =>
  render(
    <I18nProvider initial="fr">
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
const calls = (m: ReturnType<typeof vi.fn>, method: string, url: string) =>
  m.mock.calls.filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('cash of the day', () => {
  it('shows expected cash and the methods apart; the manager closes with a reason for a difference', async () => {
    const m = mockFetch(me(['cash.read', 'cash.close', 'expenses.record']), (url, init) => (url === '/api/cash/close' && init.method === 'POST' ? json(201, { expectedCashCents: 40000, differenceCents: -1000 }) : undefined));
    const user = userEvent.setup();
    renderAt('/cash');
    expect(await screen.findByText(/400,00/)).toBeTruthy();
    expect(screen.getByText(/3\.000,00/)).toBeTruthy(); // cheque deposit shown apart, not in cash
    const form = screen.getByRole('form', { name: 'Clôturer la caisse' });
    await user.type(within(form).getByLabelText('Espèces comptées (MAD)'), '390');
    const btn = within(form).getByRole('button', { name: 'Clôturer la caisse' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.type(within(form).getByLabelText(/^Explication/), 'Pièce manquante');
    await user.click(btn);
    expect(JSON.parse(String(calls(m, 'POST', '/api/cash/close')[0]![1]!.body))).toEqual({ branchId: B1, date: expect.any(String), countedCashCents: 39000, notes: 'Pièce manquante' });
  });

  it('an employee records an expense but cannot close', async () => {
    const m = mockFetch(me(['cash.read', 'expenses.record'], 'employee'), (url, init) => (url === '/api/cash/expenses' && init.method === 'POST' ? json(201, { id: 'x' }) : undefined));
    const user = userEvent.setup();
    renderAt('/cash');
    expect(await screen.findByText('La clôture est faite par le gérant ou une personne autorisée.')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Ajouter une dépense' });
    await user.selectOptions(within(form).getByLabelText('Catégorie'), 'washing');
    await user.type(within(form).getByLabelText('Montant (MAD)'), '100');
    await user.click(within(form).getByRole('button', { name: 'Ajouter une dépense' }));
    expect(JSON.parse(String(calls(m, 'POST', '/api/cash/expenses')[0]![1]!.body))).toMatchObject({ branchId: B1, category: 'washing', amountCents: 10000, method: 'cash' });
  });
});

describe('maintenance', () => {
  it('lists what is due with km left, in words', async () => {
    mockFetch(me([]), (url) =>
      url === '/api/maintenance/due'
        ? json(200, { items: [{ id: 'p1', item: 'oil_change', label: null, intervalKm: 10000, intervalMonths: null, lastDoneKm: 50000, lastDoneOn: null, nextKm: 60000, nextOn: null, kmLeft: 500, daysLeft: null, status: 'soon', vehicle: { id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', mileageKm: 59500 } }] })
        : undefined,
    );
    renderAt('/maintenance');
    expect(await screen.findByText('Vidange')).toBeTruthy();
    expect(screen.getByText('Bientôt')).toBeTruthy();
    expect(screen.getByText(/dans 500 km/)).toBeTruthy();
  });
});

describe('WhatsApp reminders', () => {
  it('opens the wa.me link from the server and asks the employee to confirm he sent it', async () => {
    const link = 'https://wa.me/212600000001?text=Bonjour';
    const m = mockFetch(me(['reminders.send'], 'employee'), (url, init) => {
      if (url === '/api/reminders') return json(200, { items: [{ kind: 'pickup', refId: 'r1', reference: 'R-00001', at: '2026-11-06T09:00:00Z', customer: { id: 'c1', fullName: 'Client Démo', phone: '0600000001', language: 'fr' }, text: 'Bonjour Client Démo…', link, lastSentAt: null }] });
      if (url === '/api/reminders/sent' && init.method === 'POST') return json(201, { ok: true });
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/reminders');
    expect((await screen.findByRole('link', { name: /Ouvrir WhatsApp/ })).getAttribute('href')).toBe(link);
    expect(screen.getByText('Bonjour Client Démo…')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'J’ai envoyé le message' }));
    expect(JSON.parse(String(calls(m, 'POST', '/api/reminders/sent')[0]![1]!.body))).toEqual({ kind: 'pickup', refId: 'r1' });
  });
});

describe('reports', () => {
  it('shows income, deposits apart, result and the accountant exports', async () => {
    mockFetch(me(['reports.read']), (url) =>
      url.startsWith('/api/reports/summary')
        ? json(200, {
            income: { rentalByMethod: { cash: 50000 }, rentalCents: 50000, depositKeptCents: 20000, totalCents: 70000 },
            deposits: { receivedCents: 300000, returnedCents: 0, keptCents: 20000 },
            expenses: { byCategory: { fuel: 15000 }, totalCents: 15000 },
            resultCents: 55000,
            contracts: { count: 1, days: 3, billedCents: 90000, lateFeesCents: 0, outstandingCents: 40000 },
            reservations: { created: 2, cancelled: 1, no_show: 0 },
            fleet: [{ id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', utilisation: 0.5, revenueCents: 90000 }],
          })
        : undefined,
    );
    renderAt('/reports');
    expect(await screen.findByText('Cautions (pas un revenu)')).toBeTruthy();
    expect(screen.getAllByText(/550,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/50 %/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Dépenses/ }).getAttribute('href')).toMatch(/^\/api\/reports\/export\.csv\?type=expenses&from=/);
  });
});

describe('home screen, vehicle first', () => {
  const ov = {
    counts: { rented: 1, available: 1, inspection_pending: 0, maintenance: 0, out_of_service: 0 },
    total: 2,
    attention: 1,
    late: 1,
    items: [
      { id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', status: 'rented', mileageKm: 51200, fuelEighths: 4, branch: { id: B1, name: 'Casablanca' },
        contract: { id: 'k1', number: 7, outAt: '2026-11-01T09:00:00Z', plannedEndAt: '2026-11-04T09:00:00Z', late: true, customer: 'Client Démo', phone: '0600000001' },
        nextReservation: null, documents: { alert: 'expired', nextType: 'insurance', nextExpiry: '2026-11-01' },
        maintenance: { status: 'soon', due: 0, soon: 1, next: { item: 'oil_change', label: null, kmLeft: 800, daysLeft: null } }, needsAttention: true },
      { id: 'v2', plate: '99993-أ-1', make: 'Renault', model: 'Clio', status: 'available', mileageKm: 12000, fuelEighths: 8, branch: { id: B1, name: 'Casablanca' },
        contract: null, nextReservation: { id: 'r9', number: 9, startAt: '2026-11-08T09:00:00Z', endAt: '2026-11-10T09:00:00Z', customer: 'Autre Démo' },
        documents: null, maintenance: null, needsAttention: false },
    ],
  };

  it('shows each vehicle: who has it until when (late), next booking, documents, maintenance, km and fuel; filters by status', async () => {
    mockFetch(me(['contracts.read', 'reservations.read', 'customers.read']), (url) => (url === '/api/fleet/overview' ? json(200, ov) : undefined));
    const user = userEvent.setup();
    renderAt('/');
    await user.click(await screen.findByText('Autres informations et statistiques'));
    const logan = await screen.findByRole('article', { name: /Dacia Logan/ });
    expect(within(logan).getByText(/Chez Client Démo/).closest('a')!.getAttribute('href')).toBe('/contracts/k1');
    expect(within(logan).getByText('En retard')).toBeTruthy();
    expect(within(logan).getByText(/Assurance expiré\(e\) le/)).toBeTruthy();
    expect(within(logan).getByText(/Vidange bientôt · 800 km/)).toBeTruthy();
    expect(within(logan).getByText(/51.200 km/)).toBeTruthy();
    expect(within(logan).getByText('1/2')).toBeTruthy();
    const clio = screen.getByRole('article', { name: /Renault Clio/ });
    expect(within(clio).getByText(/Prochaine réservation/).closest('a')!.getAttribute('href')).toBe('/reservations/r9');

    await user.click(screen.getByRole('button', { name: /Disponible/ }));
    expect(screen.queryByRole('article', { name: /Dacia Logan/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /À traiter/ }));
    expect(screen.getByRole('article', { name: /Dacia Logan/ })).toBeTruthy();
    expect(screen.queryByRole('article', { name: /Renault Clio/ })).toBeNull();
  });
});
