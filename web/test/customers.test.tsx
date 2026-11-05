import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, type Lang } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

/** Synthetic people only. */
const CID = '44444444-2222-4333-8444-555555555555';
const OTHER = '55555555-2222-4333-8444-555555555555';
const DOC = '66666666-2222-4333-8444-555555555555';
const FILE = '77777777-2222-4333-8444-555555555555';

const employeeMe = {
  user: { id: 'e1', email: 'e@example.test', fullName: 'Sara Employée', role: 'employee', preferredLanguage: 'fr' },
  permissions: ['customers.manage', 'customers.read', 'dashboard.view'],
  branchIds: ['b1'],
};
const managerMe = {
  user: { id: 'm1', email: 'm@example.test', fullName: 'Gérant Démo', role: 'manager', preferredLanguage: 'fr' },
  permissions: ['customers.block', 'customers.manage', 'customers.read', 'customers.verify', 'dashboard.view'],
};

const customer = {
  id: CID,
  customerType: 'individual',
  fullName: 'Client Démo',
  companyIce: null,
  contactPerson: null,
  birthDate: '1990-05-01',
  nationality: 'Marocaine',
  residence: 'abroad_mre',
  phone: '+33 6 00 00 01 01',
  phoneKey: '33600000101',
  phone2: null,
  whatsappSamePhone: true,
  email: null,
  address: null,
  city: 'Lyon',
  country: 'France',
  preferredLanguage: 'fr',
  idDocType: 'passport',
  idDocNumber: 'XX0000001',
  idDocCountry: 'Maroc',
  idDocExpiry: '2030-01-01',
  idDocStatus: 'valid',
  licenceNumber: 'DEMO-1',
  licenceCategory: 'B',
  licenceCountry: 'Maroc',
  licenceIssueDate: null,
  licenceExpiry: '2026-11-01',
  licenceStatus: 'expired',
  notes: null,
  blocked: null,
  documentCount: 1,
  pendingDocuments: 1,
  createdBy: 'Sara Employée',
  createdAt: '2026-11-03T10:00:00Z',
  updatedAt: '2026-11-03T10:00:00Z',
};
const scan = {
  id: DOC,
  kind: 'passport',
  source: 'direct_upload',
  reviewStatus: 'pending',
  reviewNote: null,
  reviewedAt: null,
  reviewedBy: null,
  archivedAt: null,
  createdAt: '2026-11-03T10:05:00Z',
  createdBy: 'Sara Employée',
  file: { id: FILE, mimeType: 'application/pdf', sizeBytes: 900, name: 'scan.pdf' },
};

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}
type Handler = (url: string, init: RequestInit) => Promise<Response> | undefined;
function mockFetch(me: unknown, extra: Handler = () => undefined) {
  const m = vi.fn((url: string, init: RequestInit = {}) => {
    const x = extra(url, init);
    if (x) return x;
    if (url === '/api/auth/me') return json(200, me);
    if (url.startsWith(`/api/customers/${CID}/documents`)) return json(200, { items: [scan] });
    if (url === `/api/customers/${CID}`) return json(200, { customer });
    if (url === '/api/customers/summary') return json(200, { total: 12, blocked: 0, pendingDocuments: 3 });
    if (url.startsWith('/api/customers')) return json(200, { items: [customer] });
    if (url === '/api/company-settings') return json(200, { settings: {} });
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
  m.mock.calls.filter(([u, i]) => u === url && ((i as RequestInit | undefined)?.method ?? 'GET') === method);

afterEach(() => vi.unstubAllGlobals());

describe('customer list', () => {
  it('shows name, phone in LTR, residence and alerts in words; search goes to the API', async () => {
    const m = mockFetch(employeeMe);
    const user = userEvent.setup();
    renderAt('/customers');
    const card = (await screen.findByText('Client Démo')).closest('a') as HTMLElement;
    expect(card.getAttribute('href')).toBe(`/customers/${CID}`);
    expect(within(card).getByText('+33 6 00 00 01 01').getAttribute('dir')).toBe('ltr');
    expect(within(card).getByText('Marocain résidant à l’étranger (MRE)')).toBeTruthy();
    expect(within(card).getByText('Permis expiré')).toBeTruthy();
    expect(within(card).getByText('1 pièce(s) à vérifier')).toBeTruthy();
    await user.type(screen.getByRole('searchbox'), '0600{Enter}');
    expect(m.mock.calls.some(([u]) => String(u) === '/api/customers?q=0600')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Ne pas louer' }));
    expect(m.mock.calls.some(([u]) => String(u).includes('filter=blocked'))).toBe(true);
  });

  it('customers are on the home screen with pending scans, and in the menu', async () => {
    mockFetch(managerMe);
    renderAt('/');
    expect(await screen.findByText('12 client(s) enregistré(s)')).toBeTruthy();
    expect(screen.getByText('3 pièce(s) client à vérifier')).toBeTruthy();
    const side = document.querySelector('.sidebar') as HTMLElement;
    expect(within(side).getByRole('link', { name: /Clients/ })).toBeTruthy();
  });
});

describe('customer form', () => {
  it('sends a tourist with passport; a possible duplicate is shown and can be confirmed as another person', async () => {
    let n = 0;
    const m = mockFetch(employeeMe, (url, init) => {
      if (url === '/api/customers' && init.method === 'POST') {
        n += 1;
        return n === 1
          ? json(409, { error: { code: 'possible_duplicate', message: 'x', details: { matches: [{ id: OTHER, fullName: 'Ancien Client', phone: '0600000101', reasons: ['phone'] }] } } })
          : json(201, { customer: { ...customer, id: OTHER } });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/customers/new');
    await user.type(await screen.findByLabelText(/^Nom et prénom/), 'Demo Tourist');
    await user.click(screen.getByRole('button', { name: 'Touriste ou étranger' }));
    await user.type(screen.getByLabelText(/^Téléphone/), '+33 6 00 00 02 02');
    await user.selectOptions(screen.getByLabelText('Type de pièce'), 'passport');
    await user.type(screen.getByLabelText('Numéro de la pièce'), 'XX0000002');
    await user.type(screen.getByLabelText('Pays de délivrance'), 'France');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Ce client existe peut-être déjà')).toBeTruthy();
    expect(screen.getByText(/même téléphone/)).toBeTruthy();
    const [first] = calls(m, 'POST', '/api/customers');
    const body = JSON.parse(String(first![1]!.body));
    expect(body).toMatchObject({ fullName: 'Demo Tourist', residence: 'abroad_foreign', phone: '+33 6 00 00 02 02', idDocType: 'passport', idDocNumber: 'XX0000002', idDocCountry: 'France', companyIce: null });
    expect(body.acknowledgeDuplicates).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'C’est une autre personne : enregistrer' }));
    const second = calls(m, 'POST', '/api/customers')[1]!;
    expect(JSON.parse(String(second[1]!.body)).acknowledgeDuplicates).toBe(true);
  });

  it('shows translated field errors, never the server’s English message', async () => {
    mockFetch(employeeMe, (url, init) =>
      url === '/api/customers' && init.method === 'POST'
        ? json(400, { error: { code: 'validation_failed', message: 'x', details: [{ path: 'phone', message: 'Invalid phone number' }] } })
        : undefined,
    );
    const user = userEvent.setup();
    renderAt('/customers/new');
    await user.type(await screen.findByLabelText(/^Nom et prénom/), 'Client Démo');
    await user.type(screen.getByLabelText(/^Téléphone/), '123456');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Numéro de téléphone non valide.')).toBeTruthy();
    expect(screen.queryByText('Invalid phone number')).toBeNull();
  });

  it('company: asks for the ICE and the contact person instead of birth date', async () => {
    mockFetch(employeeMe);
    const user = userEvent.setup();
    renderAt('/customers/new');
    await user.click(await screen.findByRole('button', { name: 'Société' }));
    expect(screen.getByLabelText('ICE (15 chiffres)')).toBeTruthy();
    expect(screen.getByLabelText('Personne à contacter')).toBeTruthy();
    expect(screen.queryByLabelText('Date de naissance')).toBeNull();
  });
});

describe('customer card', () => {
  it('employee sees details and the scan to check, but cannot verify or block', async () => {
    mockFetch(employeeMe);
    renderAt(`/customers/${CID}`);
    expect(await screen.findByRole('heading', { name: 'Client Démo' })).toBeTruthy();
    expect(screen.getByText('XX0000001').getAttribute('dir')).toBe('ltr');
    expect(await screen.findByText('À vérifier')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Appeler/ }).getAttribute('href')).toBe('tel:+33600000101');
    expect(screen.queryByRole('button', { name: 'Conforme' })).toBeNull();
    expect(screen.queryByRole('button', { name: /ne pas louer/ })).toBeNull();
  });

  it('manager verifies a scan and blocks the customer with a reason', async () => {
    const m = mockFetch(managerMe, (url) => {
      if (url.endsWith(`/documents/${DOC}/review`)) return json(200, { ...scan, reviewStatus: 'verified' });
      if (url.endsWith('/block')) return json(200, { customer: { ...customer, blocked: { at: '2026-11-04T10:00:00Z', reason: 'Impayé', by: 'Gérant Démo' } } });
      return undefined;
    });
    const user = userEvent.setup();
    renderAt(`/customers/${CID}`);
    await user.click(await screen.findByRole('button', { name: 'Conforme' }));
    expect(JSON.parse(String(calls(m, 'POST', `/api/customers/${CID}/documents/${DOC}/review`)[0]![1]!.body))).toEqual({ status: 'verified' });
    await user.click(screen.getByRole('button', { name: /Marquer « ne pas louer »/ }));
    const submit = screen.getAllByRole('button', { name: /Marquer « ne pas louer »/ }).at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('Motif (obligatoire)'), 'Impayé');
    await user.click(submit);
    expect(JSON.parse(String(calls(m, 'POST', `/api/customers/${CID}/block`)[0]![1]!.body))).toEqual({ reason: 'Impayé' });
  });

  it('uploading a scan sends the chosen kind; the same file on another customer is flagged', async () => {
    const m = mockFetch(employeeMe, (url, init) =>
      url.startsWith(`/api/customers/${CID}/documents?kind=`) && init.method === 'POST'
        ? json(201, { ...scan, id: 'new', alsoLinkedTo: [{ id: OTHER, fullName: 'Ancien Client' }] })
        : undefined,
    );
    const user = userEvent.setup();
    renderAt(`/customers/${CID}`);
    await user.selectOptions(await screen.findByLabelText('Quelle pièce ?'), 'licence_front');
    await user.upload(screen.getByLabelText('Choisir le fichier', { selector: 'input' }), new File(['%PDF-1.4'], 'permis.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(/ce même fichier est déjà joint à : Ancien Client/)).toBeTruthy();
    expect(calls(m, 'POST', `/api/customers/${CID}/documents?kind=licence_front`)).toHaveLength(1);
  });

  it('Arabic: labels are translated and the phone stays LTR', async () => {
    mockFetch({ ...employeeMe, user: { ...employeeMe.user, preferredLanguage: 'ar' } });
    renderAt(`/customers/${CID}`, 'ar');
    expect(await screen.findByText('الوثائق الممسوحة')).toBeTruthy();
    expect(screen.getByText('مغربي مقيم بالخارج')).toBeTruthy();
    expect(screen.getByText('+33 6 00 00 01 01').getAttribute('dir')).toBe('ltr');
  });
});
