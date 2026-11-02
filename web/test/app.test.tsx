import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';
import { visibleNavItems } from '../src/components/navigation';

const employeeMe = {
  user: { id: 'u1', email: 'e@example.test', fullName: 'Employé Test', role: 'employee', preferredLanguage: 'fr' },
  permissions: ['company_settings.read', 'dashboard.view'],
};
const managerMe = {
  user: { id: 'u2', email: 'm@example.test', fullName: 'Gérant Test', role: 'manager', preferredLanguage: 'fr' },
  permissions: ['audit_logs.read', 'company_settings.read', 'company_settings.update', 'dashboard.view', 'users.manage', 'users.read'],
};

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function renderApp(path = '/') {
  return render(
    <I18nProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('navigation by permission', () => {
  it('employees see only dashboard and company settings', () => {
    expect(visibleNavItems(employeeMe.permissions).map((i) => i.to)).toEqual(['/', '/settings/company']);
  });
  it('managers see users and audit log too', () => {
    expect(visibleNavItems(managerMe.permissions).map((i) => i.to)).toEqual(['/', '/settings/company', '/users', '/audit']);
  });
});

describe('app shell', () => {
  it('shows the login screen when not authenticated, then logs in', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return json(401, { error: { code: 'unauthorized', message: 'x' } });
      if (url === '/api/auth/login') {
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-Requested-With']).toBe('fleetora');
        expect(init?.credentials).toBe('same-origin');
        return json(200, employeeMe);
      }
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderApp();

    expect(await screen.findByRole('heading', { name: 'Bienvenue' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Adresse e-mail'), 'e@example.test');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'Correct-Horse-9');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('heading', { name: /^(Bonjour|Bonsoir), Employé$/ })).toBeInTheDocument();
    // Side menu shows every permitted page; the phone bottom bar shows the main ones + "Plus".
    expect(screen.getAllByRole('link', { name: 'Mon entreprise' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Accueil' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Plus' })).toHaveAttribute('href', '/more');
    expect(screen.queryByRole('link', { name: 'Équipe' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Historique' })).not.toBeInTheDocument();
    // No internal codes or ids visible to staff
    expect(document.body.textContent).not.toMatch(/dashboard\.view|company_settings/);
  });

  it('shows a generic error on failed login and clears the password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/auth/me'
          ? json(401, { error: { code: 'unauthorized' } })
          : json(401, { error: { code: 'unauthorized', message: 'Invalid' } }),
      ),
    );
    renderApp();
    await userEvent.type(await screen.findByLabelText('Adresse e-mail'), 'e@example.test');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou mot de passe incorrect');
    expect(screen.getByLabelText('Mot de passe')).toHaveValue('');
  });

  it('blocks an employee who navigates directly to a manager page', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/auth/me' ? json(200, employeeMe) : json(403, {}))));
    renderApp('/users');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cette page est réservée au gérant.');
  });

  it('shows company settings read-only for employees', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/auth/me') return json(200, employeeMe);
        if (url === '/api/company-settings')
          return json(200, {
            settings: {
              legalName: 'Société Fictive', tradeName: '', ice: null, ifNumber: null, rcNumber: null, rcCity: null,
              patente: null, addressLine: null, city: null, postalCode: null, countryCode: 'MA', phone: null, email: null,
              website: null, currency: 'MAD', timezone: 'Africa/Casablanca', defaultLanguage: 'fr', documentLanguages: ['fr', 'ar'],
              brandPrimaryColor: '#1F4E79', showCompanyBranding: true, documentHeaderText: null, documentFooterText: null,
              signatoryName: null, signatoryTitle: null,
            },
            logo: { configured: false },
            updatedAt: '2026-01-01T10:00:00Z',
          });
        return json(404, {});
      }),
    );
    renderApp('/settings/company');
    expect(await screen.findByDisplayValue('Société Fictive')).toBeDisabled();
    expect(screen.getByText(/Consultation seulement/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Monnaie' })).toHaveDisplayValue('Dirham marocain (DH)');
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();
  });

  it('shows a network error state with retry when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('Pas de connexion avec le serveur');
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });

  it("switches the UI to Arabic RTL from the user's saved preference", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/auth/me' ? json(200, { ...managerMe, user: { ...managerMe.user, preferredLanguage: 'ar' } }) : json(404, {}),
      ),
    );
    renderApp();
    expect(await screen.findByRole('heading', { name: /^(صباح الخير|مساء الخير)، Gérant$/ })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(screen.getAllByRole('link', { name: 'السجل' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'المزيد' })).toBeInTheDocument();
  });
});
