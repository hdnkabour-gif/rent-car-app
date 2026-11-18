import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';
import { AuthProvider } from '../src/auth';
import { I18nProvider } from '../src/i18n';
import { visibleNavItems } from '../src/components/navigation';

const V = '11111111-2222-4333-8444-555555555555';
const me = {
  user: { id: 'm-demo', email: 'm@example.test', fullName: 'Manager Démo', role: 'manager', preferredLanguage: 'fr' },
  permissions: ['dashboard.view', 'vehicles.read', 'infractions.read', 'infractions.manage'],
  branchIds: [],
};
const json = (status: number, data: unknown) => Promise.resolve(new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
}));
const renderAt = () => render(
  <I18nProvider initial="fr"><AuthProvider><MemoryRouter initialEntries={['/infractions']}><App /></MemoryRouter></AuthProvider></I18nProvider>,
);

afterEach(() => vi.unstubAllGlobals());
describe('road infractions page (synthetic)', () => {
  it('hides this menu from employees without infractions.read', () => {
    expect(visibleNavItems(['vehicles.read']).some((x) => x.to === '/infractions')).toBe(false);
    expect(visibleNavItems(['infractions.read']).some((x) => x.to === '/infractions')).toBe(true);
  });

  it('renders a manager-only manual form and never calls the NARSA portal or any finance API', async () => {
    const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/me') return json(200, me);
      if (url.startsWith('/api/infractions') && (init.method ?? 'GET') === 'GET') return json(200, { items: [] });
      if (url.startsWith('/api/vehicles')) return json(200, { items: [{ id: V, plate: '00001-أ-1', make: 'Dacia', model: 'Logan' }] });
      if (url === '/api/infractions' && init.method === 'POST') return json(201, { infraction: { id: 'demo' } });
      return json(404, { error: { code: 'not_found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderAt();
    expect(await screen.findByRole('heading', { name: 'Infractions & amendes' })).toBeInTheDocument();
    expect(screen.getByText(/Saisie manuelle uniquement/)).toBeInTheDocument();
    const official = screen.getByRole('link', { name: 'Portail Tasrih Saeq' });
    expect(official).toHaveAttribute('href', 'https://tasrih-saeq.narsa.gov.ma');

    await user.click(screen.getByRole('button', { name: 'Ajouter un avis' }));
    const vehicle = screen.getAllByLabelText('Véhicule');
    await user.selectOptions(vehicle[vehicle.length - 1]!, V);
    await user.type(screen.getByLabelText('N° PV / avis'), 'DEMO-PV-001');
    fireEvent.change(screen.getByLabelText(/Date et heure de l'infraction/), { target: { value: '2026-10-15T14:22' } });
    await user.type(screen.getByLabelText('Montant (MAD)'), '300.50');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    const calls = fetchMock.mock.calls.filter(([url, init]) => url === '/api/infractions' && (init as RequestInit)?.method === 'POST');
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String((calls[0]![1] as RequestInit).body));
    expect(payload).toMatchObject({
      vehicleId: V, issuer: 'NARSA', noticeNumber: 'DEMO-PV-001',
      occurredLocal: '2026-10-15T14:22', amountCents: 30050,
    });
    expect(payload).not.toHaveProperty('source');
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((url) => url.includes('narsa.gov.ma'))).toBe(false);
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((url) => url.includes('/cash') || url.includes('/payments'))).toBe(false);
  });
});
