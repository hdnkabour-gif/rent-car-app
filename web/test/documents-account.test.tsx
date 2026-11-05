import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, type Lang } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

/** Synthetic fixtures only (example.test, 9999x plates). */
const VEHICLE_ID = '11111111-2222-4333-8444-555555555555';
const DOC_ID = '22222222-2222-4333-8444-555555555555';
const FILE_ID = '33333333-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';

const managerMe = {
  user: { id: 'm1', email: 'm@example.test', fullName: 'Gérant Démo', role: 'manager', preferredLanguage: 'fr' },
  permissions: ['branches.all', 'branches.manage', 'branches.read', 'dashboard.view', 'users.manage', 'users.read', 'vehicles.documents', 'vehicles.manage', 'vehicles.read'],
};
const employeeMe = {
  user: { id: 'e1', email: 'e@example.test', fullName: 'Sara Employée', role: 'employee', preferredLanguage: 'fr' },
  permissions: ['dashboard.view', 'vehicles.read'],
  branchIds: ['b1'],
};

const vehicle = {
  id: VEHICLE_ID,
  branch: { id: 'b1', name: 'Agence Démo Casablanca', code: 'CAS' },
  internalCode: null,
  plate: '99991-أ-1',
  make: 'Dacia',
  model: 'Logan',
  version: null,
  modelYear: 2023,
  color: null,
  fuelType: 'diesel',
  transmission: 'manual',
  seats: 5,
  category: null,
  vin: null,
  status: 'available',
  statusChangedAt: '2026-11-02T10:00:00Z',
  mileageKm: 84250,
  fuelEighths: 8,
  notes: null,
  firstRegistrationDate: '2023-03-15',
  documentAlert: 'expiring',
};

const insurance = {
  id: DOC_ID,
  docType: 'insurance',
  label: null,
  number: 'POL-0001',
  issuer: 'Assureur Démo',
  issueDate: '2026-01-01',
  expiryDate: '2026-11-13',
  notes: null,
  status: 'expiring',
  daysLeft: 10,
  file: { id: FILE_ID, mimeType: 'application/pdf', sizeBytes: 1200, name: 'scan.pdf' },
};

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

type Handler = (url: string, init: RequestInit) => Promise<Response> | undefined;

function mockFetch(me: unknown, extra: Handler = () => undefined) {
  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    const custom = extra(url, init);
    if (custom) return custom;
    if (url === '/api/auth/me') return json(200, me);
    if (url.startsWith(`/api/vehicles/${VEHICLE_ID}/documents`)) return json(200, { items: [insurance] });
    if (url === `/api/vehicles/${VEHICLE_ID}/photos`) return json(200, { items: [] });
    if (url === `/api/vehicles/${VEHICLE_ID}`) return json(200, { vehicle, allowedTransitions: [], history: [] });
    if (url.startsWith('/api/vehicles/summary')) return json(200, { counts: { available: 1 }, total: 1, documents: { expired: 2, expiring: 1 } });
    if (url.startsWith('/api/vehicles')) return json(200, { items: [vehicle] });
    if (url === '/api/branches') return json(200, { items: [] });
    if (url === '/api/company-settings') return json(200, { settings: {} });
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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
  m.mock.calls.filter(([u, i]) => u === url && ((i as RequestInit | undefined)?.method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('vehicle documents', () => {
  it('shows each document with its status in words, expiry and an open link to the scan', async () => {
    mockFetch(managerMe);
    renderAt(`/vehicles/${VEHICLE_ID}`);
    const card = (await screen.findByRole('heading', { name: 'Documents du véhicule' })).closest('.card') as HTMLElement;
    expect(await within(card).findByText('Assurance')).toBeTruthy();
    expect(within(card).getByText('Expire bientôt')).toBeTruthy();
    expect(within(card).getByText(/dans 10 j/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Ouvrir/ }).getAttribute('href')).toBe(`/api/vehicles/${VEHICLE_ID}/files/${FILE_ID}`);
    // Vehicle alert at the top and the first registration date in the details.
    expect(screen.getByRole('link', { name: 'Document à renouveler' })).toBeTruthy();
    expect(screen.getByText('Date de 1re mise en circulation')).toBeTruthy();
  });

  it('an employee without the delegated right sees documents but no add/edit buttons', async () => {
    mockFetch(employeeMe);
    renderAt(`/vehicles/${VEHICLE_ID}`);
    expect(await screen.findByText('Assurance')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ajouter un document/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archiver/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ajouter des photos/ })).toBeNull();
  });

  it('manager adds a document; the dates are checked before sending', async () => {
    const fetchMock = mockFetch(managerMe, (url, init) =>
      url === `/api/vehicles/${VEHICLE_ID}/documents` && init.method === 'POST' ? json(201, { ...insurance, id: OTHER_ID }) : undefined,
    );
    const user = userEvent.setup();
    renderAt(`/vehicles/${VEHICLE_ID}`);
    await user.click(await screen.findByRole('button', { name: /Ajouter un document/ }));
    await user.selectOptions(screen.getByLabelText('Type de document'), 'technical_inspection');
    await user.type(screen.getByLabelText('Numéro'), 'VT-42');
    await user.type(screen.getByLabelText('Date de délivrance'), '2026-10-01');
    await user.type(screen.getByLabelText(/^Date d’expiration/), '2026-09-01');
    expect(screen.getByText('La date d’expiration est avant la date de délivrance.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText(/^Date d’expiration/));
    await user.type(screen.getByLabelText(/^Date d’expiration/), '2027-10-01');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    const [post] = calls(fetchMock, 'POST', `/api/vehicles/${VEHICLE_ID}/documents`);
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      docType: 'technical_inspection',
      label: null,
      number: 'VT-42',
      issuer: null,
      issueDate: '2026-10-01',
      expiryDate: '2027-10-01',
      notes: null,
    });
    expect(await screen.findByText('Modifications enregistrées.')).toBeTruthy();
  });

  it('archiving asks for a reason', async () => {
    const fetchMock = mockFetch(managerMe, (url) => (url.endsWith(`/documents/${DOC_ID}/archive`) ? json(204, null) : undefined));
    const user = userEvent.setup();
    renderAt(`/vehicles/${VEHICLE_ID}`);
    await user.click(await screen.findByRole('button', { name: /Archiver/ }));
    const submit = screen.getAllByRole('button', { name: 'Archiver' }).at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText(/Motif de l’archivage/), 'Renouvelée');
    await user.click(submit);
    const [post] = calls(fetchMock, 'POST', `/api/vehicles/${VEHICLE_ID}/documents/${DOC_ID}/archive`);
    expect(JSON.parse(String(post![1]!.body))).toEqual({ reason: 'Renouvelée' });
  });

  it('Arabic: document types and statuses are translated', async () => {
    mockFetch({ ...managerMe, user: { ...managerMe.user, preferredLanguage: 'ar' } });
    renderAt(`/vehicles/${VEHICLE_ID}`, 'ar');
    expect(await screen.findByText('وثائق السيارة')).toBeTruthy();
    expect(await screen.findByText('تنتهي قريباً')).toBeTruthy();
  });
});

describe('vehicle photos', () => {
  it('sends each photo as its own request with the file name, and offers a retry for failed ones', async () => {
    let n = 0;
    const fetchMock = mockFetch(managerMe, (url, init) => {
      if (url === `/api/vehicles/${VEHICLE_ID}/photos` && init.method === 'POST') {
        n += 1;
        return n === 2 ? json(415, { error: { code: 'unsupported_file', message: 'x' } }) : json(201, { id: 'p', fileId: FILE_ID });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderAt(`/vehicles/${VEHICLE_ID}`);
    await screen.findByRole('button', { name: /Ajouter des photos/ });
    const a = new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'avant.jpg', { type: 'image/jpeg' });
    const b = new File([new Uint8Array([1, 2, 3])], 'côté.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Ajouter des photos', { selector: 'input' }), [a, b]);
    expect(await screen.findByText(/1 photo\(s\) non envoyée\(s\)/)).toBeTruthy();
    expect(screen.getByText(/Type de fichier non accepté/)).toBeTruthy();
    const posts = calls(fetchMock, 'POST', `/api/vehicles/${VEHICLE_ID}/photos`);
    expect(posts).toHaveLength(2);
    const headers = posts[1]![1]!.headers as Record<string, string>;
    expect(headers['X-File-Name']).toBe(encodeURIComponent('côté.jpg'));
    expect(headers['Content-Type']).toBe('image/jpeg');
    expect(headers['X-Requested-With']).toBe('fleetora');
    expect(posts[1]![1]!.body).toBe(b);
    await user.click(screen.getByRole('button', { name: 'Réessayer l’envoi' }));
    expect(calls(fetchMock, 'POST', `/api/vehicles/${VEHICLE_ID}/photos`)).toHaveLength(3);
  });
});

describe('fleet and dashboard alerts', () => {
  it('fleet card shows the document alert; the filter asks the API for vehicles to renew', async () => {
    const fetchMock = mockFetch(managerMe);
    const user = userEvent.setup();
    renderAt('/vehicles');
    expect(await screen.findByText('Document à renouveler')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Documents à renouveler' }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/vehicles?') && String(u).includes('docs=alert'))).toBe(true);
  });

  it('dashboard shows the number of expired and soon-expiring documents', async () => {
    mockFetch(managerMe);
    renderAt('/');
    expect(await screen.findByText('Documents des véhicules')).toBeTruthy();
    expect(screen.getByText('2 expiré(s)')).toBeTruthy();
    expect(screen.getByText('1 à renouveler sous 30 jours')).toBeTruthy();
  });
});

describe('my account', () => {
  it('checks both new passwords match, maps a wrong current password, and confirms success', async () => {
    let attempt = 0;
    const fetchMock = mockFetch(employeeMe, (url) => {
      if (url !== '/api/auth/change-password') return undefined;
      attempt += 1;
      return attempt === 1 ? json(400, { error: { code: 'invalid_current_password', message: 'x' } }) : json(204, null);
    });
    const user = userEvent.setup();
    renderAt('/account');
    await user.type(await screen.findByLabelText('Mot de passe actuel'), 'ancien-mot-de-passe');
    await user.type(screen.getByLabelText(/Nouveau mot de passe/), 'nouveau-mot-de-passe');
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), 'autre-chose-123');
    expect(screen.getByText('Les deux mots de passe ne sont pas identiques.')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Changer mon mot de passe' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.clear(screen.getByLabelText('Confirmer le nouveau mot de passe'));
    await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), 'nouveau-mot-de-passe');
    await user.click(submit);
    expect(await screen.findByText('Le mot de passe actuel est incorrect.')).toBeTruthy();
    await user.click(submit);
    expect(await screen.findByText(/Mot de passe changé/)).toBeTruthy();
    const [first] = calls(fetchMock, 'POST', '/api/auth/change-password');
    expect(JSON.parse(String(first![1]!.body))).toEqual({ currentPassword: 'ancien-mot-de-passe', newPassword: 'nouveau-mot-de-passe' });
  });

  it('is reachable from "Plus" for an employee', async () => {
    mockFetch(employeeMe);
    const { container } = renderAt('/more');
    await screen.findAllByRole('link', { name: /Mon compte/ });
    expect(within(container.querySelector('.more-list') as HTMLElement).getByRole('link', { name: /Mon compte/ }).getAttribute('href')).toBe('/account');
  });
});

describe('users: role and password reset', () => {
  const list = {
    items: [
      { id: 'm1', email: 'm@example.test', fullName: 'Gérant Démo', role: 'manager', isActive: true, lastLoginAt: null, branchIds: [], grants: [] },
      { id: OTHER_ID, email: 'g2@example.test', fullName: 'Karim Gérant', role: 'manager', isActive: true, lastLoginAt: null, branchIds: [], grants: [] },
    ],
  };

  it('resets a password and explains the last-manager refusal in plain words', async () => {
    const fetchMock = mockFetch(managerMe, (url, init) => {
      if (url === '/api/users') return json(200, list);
      if (url === `/api/users/${OTHER_ID}/reset-password`) return json(204, null);
      if (url === `/api/users/${OTHER_ID}` && init.method === 'PATCH')
        return json(409, { error: { code: 'last_manager', message: 'At least one active manager is required' } });
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/users');
    await user.click(await screen.findByRole('button', { name: 'Réinitialiser le mot de passe' }));
    await user.type(screen.getByLabelText(/^Nouveau mot de passe pour Karim Gérant/), 'mot-de-passe-temporaire');
    await user.click(screen.getByRole('button', { name: 'Réinitialiser le mot de passe' }));
    expect(await screen.findByText(/Mot de passe réinitialisé/)).toBeTruthy();
    const [reset] = calls(fetchMock, 'POST', `/api/users/${OTHER_ID}/reset-password`);
    expect(JSON.parse(String(reset![1]!.body))).toEqual({ newPassword: 'mot-de-passe-temporaire' });

    await user.click(screen.getByRole('button', { name: 'Rôle' }));
    await user.click(screen.getByRole('button', { name: 'Employé' }));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Impossible : il faut au moins un gérant actif.')).toBeTruthy();
    expect(screen.queryByText(/At least one/)).toBeNull();
  });
});

describe('login', () => {
  it('a malformed e-mail gets a clear message and is not sent', async () => {
    const fetchMock = mockFetch(null, (url) => (url === '/api/auth/me' ? json(401, { error: { code: 'unauthenticated' } }) : undefined));
    const user = userEvent.setup();
    renderAt('/');
    await user.type(await screen.findByLabelText('Adresse e-mail'), 'gerant-agence');
    await user.type(screen.getByLabelText('Mot de passe'), 'x');
    await user.click(screen.getByRole('button', { name: /Se connecter/ }));
    expect(screen.getByText(/Entrez une adresse e-mail valide/)).toBeTruthy();
    expect(calls(fetchMock, 'POST', '/api/auth/login')).toHaveLength(0);
  });
});
