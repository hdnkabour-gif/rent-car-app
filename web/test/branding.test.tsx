import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
afterEach(() => vi.unstubAllGlobals());

const mount = () =>
  render(
    <I18nProvider initial="fr">
      <AuthProvider>
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );

describe('the app looks like the company’s own app', () => {
  it('login page shows the company name, city and colour; the tab title is the company', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/branding' ? json(200, { name: 'Location Démo', city: 'Marrakech', color: '#7A1F4E', logo: null }) : json(401, { error: { code: 'unauthorized' } }))));
    const { container } = mount();
    expect((await screen.findAllByText('Location Démo', {}, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.getByText('Marrakech')).toBeTruthy();
    expect(screen.getByText('Propulsé par Fleetora')).toBeTruthy();
    expect((container.querySelector('.brand-root') as HTMLElement).style.getPropertyValue('--brand')).toBe('#7A1F4E');
    await waitFor(() => expect(document.title).toBe('Location Démo'), { timeout: 5000 });
  });

  it('home screen greets with the company name and quick actions', async () => {
    const me = {
      user: { id: 'm1', email: 'm@example.test', fullName: 'Gérant Démo', role: 'manager', preferredLanguage: 'fr' },
      permissions: ['contracts.read', 'customers.manage', 'customers.read', 'dashboard.view', 'reservations.manage', 'reservations.read'],
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/branding' ? json(200, { name: 'Location Démo', city: null, color: '#1F4E79', logo: null }) : url === '/api/auth/me' ? json(200, me) : json(404, {}))));
    mount();
    expect(await screen.findByRole('link', { name: /Nouvelle réservation/ }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Nouveau client/ })).toBeTruthy();
    expect(screen.getAllByText('Location Démo').length).toBeGreaterThanOrEqual(2); // menu + welcome card
  });
});
