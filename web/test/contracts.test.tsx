import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

/** Synthetic data only. */
const RID = '88888888-2222-4333-8444-555555555555';
const KID = '99999999-2222-4333-8444-555555555555';
const V1 = '11111111-2222-4333-8444-555555555555';
const CID = '44444444-2222-4333-8444-555555555555';

const employeeMe = {
  user: { id: 'e1', email: 'e@example.test', fullName: 'Sara Employée', role: 'employee', preferredLanguage: 'fr' },
  permissions: ['contracts.manage', 'contracts.read', 'dashboard.view', 'payments.record', 'reservations.manage', 'reservations.read', 'vehicles.read'],
  branchIds: ['b1'],
};
const managerMe = {
  ...employeeMe,
  user: { ...employeeMe.user, role: 'manager' },
  permissions: [...employeeMe.permissions, 'company_settings.update', 'contracts.templates', 'deposits.refund', 'deposits.retain', 'payments.reverse', 'pricing.change'],
};

const reservation = {
  id: RID, number: 7, reference: 'R-00007', status: 'confirmed', startAt: '2026-11-10T09:00:00Z', endAt: '2026-11-13T09:00:00Z', startLocal: '2026-11-10T10:00', endLocal: '2026-11-13T10:00', days: 3,
  customer: { id: CID, fullName: 'Client Démo', phone: '0600000001', blocked: false }, vehicle: { id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', status: 'available' },
  branch: { id: 'b1', name: 'Casablanca' }, returnBranch: { id: 'b1', name: 'Casablanca' }, pickupPlace: 'agency', pickupDetails: null, returnPlace: 'agency', returnDetails: null,
  listDailyCents: 30000, dailyCents: 30000, priceReason: null, totalCents: 90000, depositCents: 300000, notes: null, cancelReason: null, createdBy: 'Sara', contractId: null, createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z',
};
const vehicle = { id: V1, branch: { id: 'b1', name: 'Casablanca', code: 'CAS' }, plate: '99991-أ-1', make: 'Dacia', model: 'Logan', status: 'available', mileageKm: 1000, fuelEighths: 8, fuelType: 'diesel', transmission: 'manual' };
const template = {
  id: 't1', version: 2, title: 'CONTRAT DE LOCATION', handedDocuments: ['Carte grise', 'Assurance', 'Vignette'], responsibilityClause: 'Le conducteur est responsable du véhicule en cas d’accident.',
  termsTitle: 'CONDITIONS GÉNÉRALES', terms: [{ title: 'ART 10', body: 'La journée de location correspond à 24 heures.' }], termsAr: null, showVehicleDiagram: true, secondDriverSection: true, notes: null, createdAt: '2026-11-04T10:00:00Z',
};
const contract = {
  id: KID, number: 1, reference: 'C-00001', paperNumber: '0660', status: 'open', reservation: { id: RID, reference: 'R-00007' }, customer: { id: CID, fullName: 'Client Démo', phone: '0600000001' },
  vehicle: { id: V1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan' }, branch: { id: 'b1', name: 'Casablanca' }, returnBranch: { id: 'b1', name: 'Casablanca' }, templateVersion: 2,
  outAt: '2026-11-01T09:00:00Z', plannedEndAt: '2026-11-03T09:00:00Z', kmOut: 1000, fuelOut: 8, washedOut: true, documentsOut: ['Carte grise', 'Assurance'], notesOut: 'Rayure pare-choc arrière', outBy: 'Sara',
  dailyCents: 30000, days: 2, late: { minutes: null, status: 'none', unit: null, quantity: null, unitCents: null, feeCents: 0, reason: null, decidedAt: null }, totalCents: 60000, depositCents: 300000, inAt: null, kmIn: null, fuelIn: null, notesIn: null, inBy: null, kmDriven: null, signedScanFileId: null,
  snapshot: {
    company: { name: 'Location Démo', legalName: 'Location Démo SARL', ice: '000000000000001', ifNumber: '1', rcNumber: null, address: '1 rue Démo, Casablanca', phone: '0500000000', phone2: '0600000000', logoFileId: null, footer: null },
    customer: { fullName: 'Client Démo', customerType: 'individual', companyIce: null, nationality: 'Marocaine', birthDate: '1990-01-01', profession: 'Commerçant', idDocType: 'cin', idDocNumber: 'ZZ1', idDocCountry: null, idDocIssueDate: null, idDocExpiry: null, licenceNumber: 'L-1', licenceIssueDate: '2015-01-01', licenceCountry: null, licenceExpiry: null, address: 'Casablanca', otherAddress: null, phone: '0600000001' },
    vehicle: { make: 'Dacia', model: 'Logan', plate: '99991-أ-1', fuelType: 'diesel' }, reservation: { reference: 'R-00007', pickupPlace: 'agency', pickupDetails: null, returnPlace: 'agency', returnDetails: null }, branch: 'Casablanca', returnBranch: 'Casablanca',
  },
};
const detail = {
  contract,
  balances: { totalCents: 60000, paidCents: 20000, restCents: 40000, depositReceivedCents: 300000, depositReturnedCents: 0, depositKeptCents: 0, depositHeldCents: 300000 },
  drivers: [], photos: [], events: [{ id: 1, event: 'checked_out', details: {}, reason: null, at: '2026-11-01T09:00:00Z', by: 'Sara' }],
  payments: [{ id: 'p1', kind: 'rental', method: 'cash', amountCents: 20000, reference: null, reason: null, reversesId: null, reversedBy: null, createdAt: '2026-11-01T09:00:00Z', by: 'Sara' }],
  template,
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
    if (url === `/api/reservations/${RID}`) return json(200, { reservation, events: [] });
    if (url === `/api/vehicles/${V1}`) return json(200, { vehicle, allowedTransitions: [], history: [] });
    if (url === '/api/contract-templates/current') return json(200, { template });
    if (url === '/api/contract-templates') return json(200, { items: [{ id: 't1', version: 2, title: 'CONTRAT', notes: null, createdAt: '2026-11-04T10:00:00Z', by: 'Gérant', contracts: 1 }] });
    if (url === `/api/contracts/${KID}/return-preview`) return json(200, { lateMinutes: 1600, graceMinutes: 60, isLate: true, suggestions: { day: 2, half_day: 3, hour: 27 }, unitPrices: { day: 30000, half_day: 15000, hour: 1300 } });
    if (url === `/api/contracts/${KID}`) return json(200, detail);
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

describe('check-out', () => {
  it('records km, fuel, documents, paper number, payment and deposit (deposit separate from rental)', async () => {
    const m = mockFetch(employeeMe, (url, init) => (url === '/api/contracts/checkout' && init.method === 'POST' ? json(201, { contract }) : undefined));
    const user = userEvent.setup();
    renderAt(`/contracts/new?reservationId=${RID}`);
    await user.type(await screen.findByLabelText(/^N° du contrat papier/), '0660');
    expect((screen.getByLabelText('Kilométrage de départ') as HTMLInputElement).value).toBe('1000');
    expect((screen.getByRole('checkbox', { name: 'Vignette' }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Vignette' }));
    await user.click(within(screen.getByRole('group', { name: 'Lavage' })).getByRole('button', { name: 'Oui' }));
    await user.type(screen.getByLabelText('Paiement maintenant (MAD)'), '200');
    await user.selectOptions(screen.getByLabelText('Type de caution'), 'cheque');
    await user.type(screen.getByLabelText(/^Référence/), 'CHQ 0001');
    await user.click(screen.getByRole('button', { name: 'Confirmer le départ' }));
    const body = JSON.parse(String(calls(m, 'POST', '/api/contracts/checkout')[0]![1]!.body));
    expect(body).toMatchObject({ reservationId: RID, paperNumber: '0660', kmOut: 1000, fuelOut: 8, washedOut: true, documentsOut: ['Carte grise', 'Assurance'] });
    expect(body.payments).toEqual([
      { kind: 'rental', method: 'cash', amountCents: 20000, reference: null },
      { kind: 'deposit_in', method: 'cheque', amountCents: 300000, reference: 'CHQ 0001' },
    ]);
    expect(await screen.findByText('Véhicule remis. Le contrat est ouvert.')).toBeTruthy();
  });

  it('a vehicle not yet inspected cannot be handed over', async () => {
    mockFetch(employeeMe, (url) => (url === `/api/vehicles/${V1}` ? json(200, { vehicle: { ...vehicle, status: 'inspection_pending' }, allowedTransitions: [], history: [] }) : undefined));
    renderAt(`/contracts/new?reservationId=${RID}`);
    expect(await screen.findByText(/Le véhicule n’est pas disponible/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirmer le départ' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('contract page', () => {
  it('shows money with the deposit apart; an employee cannot refund or decide the late charge', async () => {
    const m = mockFetch(employeeMe, (url) => (url === `/api/contracts/${KID}/checkin` ? json(200, { contract: { ...contract, status: 'closed' } }) : undefined));
    const user = userEvent.setup();
    renderAt(`/contracts/${KID}`);
    expect(await screen.findByText('Reste à payer')).toBeTruthy();
    expect(screen.getByText('Caution détenue')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rendre la caution' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Corriger/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retour du véhicule' }));
    expect(await screen.findByText(/Retard : 26 h 40 min/)).toBeTruthy();
    expect(screen.getByText('Le gérant décidera ce qui est facturé pour le retard.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Demi-journée(s)' })).toBeNull();
    await user.type(screen.getByLabelText('Kilométrage de retour'), '1500');
    await user.click(within(screen.getByRole('radiogroup', { name: /Carburant/ })).getByRole('radio', { name: '3/4' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer le retour' }));
    expect(JSON.parse(String(calls(m, 'POST', `/api/contracts/${KID}/checkin`)[0]![1]!.body))).toEqual({ kmIn: 1500, fuelIn: 6, notesIn: null, cleaned: false });
  });

  it('the manager decides a late return in half days at the return (owner rule)', async () => {
    const m = mockFetch(managerMe, (url) => (url === `/api/contracts/${KID}/checkin` ? json(200, { contract: { ...contract, status: 'closed' } }) : undefined));
    const user = userEvent.setup();
    renderAt(`/contracts/${KID}`);
    await user.click(await screen.findByRole('button', { name: 'Retour du véhicule' }));
    await user.click(await screen.findByRole('button', { name: 'Demi-journée(s)' }));
    expect((screen.getByLabelText('Nombre de demi-journées') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Prix par demi-journée (MAD)') as HTMLInputElement).value).toBe('150');
    expect(screen.getByText(/450,00/)).toBeTruthy();
    await user.type(screen.getByLabelText('Kilométrage de retour'), '1500');
    await user.click(within(screen.getByRole('radiogroup', { name: /Carburant/ })).getByRole('radio', { name: 'Plein' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer le retour' }));
    const body = JSON.parse(String(calls(m, 'POST', `/api/contracts/${KID}/checkin`)[0]![1]!.body));
    expect(body.late).toEqual({ decision: 'charge', unit: 'half_day', quantity: 3, unitCents: 15000, reason: null });
  });

  it('a pending late return shows the manager a decision panel; waiving needs a reason', async () => {
    const pending = { ...detail, contract: { ...contract, status: 'closed', inAt: '2026-11-04T10:00:00Z', kmIn: 1500, fuelIn: 6, kmDriven: 500, late: { minutes: 200, status: 'pending', unit: null, quantity: null, unitCents: null, feeCents: 0, reason: null, decidedAt: null } } };
    const m = mockFetch(managerMe, (url) => (url === `/api/contracts/${KID}` ? json(200, pending) : url === `/api/contracts/${KID}/late-fee` ? json(200, { contract: pending.contract }) : undefined));
    const user = userEvent.setup();
    renderAt(`/contracts/${KID}`);
    expect(await screen.findByText(/à décider par le gérant/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Décider du retard' }));
    await user.click(screen.getByRole('button', { name: 'Heure(s)' }));
    expect((screen.getByLabelText('Nombre d’heures') as HTMLInputElement).value).toBe('4');
    await user.click(screen.getByRole('button', { name: 'Rien (offert)' }));
    const save = screen.getAllByRole('button', { name: 'Enregistrer' }).at(-1) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByLabelText('Motif (obligatoire)'), 'Client fidèle');
    await user.click(save);
    expect(JSON.parse(String(calls(m, 'POST', `/api/contracts/${KID}/late-fee`)[0]![1]!.body))).toEqual({ decision: 'waive', reason: 'Client fidèle' });
  });

  it('a manager keeps part of the deposit with a reason', async () => {
    const m = mockFetch(managerMe, (url) => (url === `/api/contracts/${KID}/payments` ? json(201, { balances: detail.balances }) : undefined));
    const user = userEvent.setup();
    renderAt(`/contracts/${KID}`);
    await user.click(await screen.findByRole('button', { name: 'Retenir sur la caution' }));
    const form = screen.getByRole('form', { name: 'Retenir sur la caution' });
    await user.clear(within(form).getByLabelText(/^Montant/));
    await user.type(within(form).getByLabelText(/^Montant/), '500');
    const save = within(form).getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(within(form).getByLabelText('Motif (obligatoire)'), 'Rayure portière');
    await user.click(save);
    expect(JSON.parse(String(calls(m, 'POST', `/api/contracts/${KID}/payments`)[0]![1]!.body))).toMatchObject({ kind: 'deposit_kept', amountCents: 50000, reason: 'Rayure portière' });
  });
});

describe('audit fixes', () => {
  it('only the manager (or a delegated employee) sees "Prolonger"', async () => {
    mockFetch(employeeMe);
    const { unmount } = renderAt(`/contracts/${KID}`);
    await screen.findByRole('button', { name: 'Retour du véhicule' });
    expect(screen.queryByRole('button', { name: 'Prolonger' })).toBeNull();
    unmount();
    vi.unstubAllGlobals();
    mockFetch({ ...managerMe, permissions: [...managerMe.permissions, 'contracts.extend'] });
    renderAt(`/contracts/${KID}`);
    expect(await screen.findByRole('button', { name: 'Prolonger' })).toBeTruthy();
  });

  it('an other driver needs a birth date and a licence number before the handover', async () => {
    mockFetch(employeeMe);
    const user = userEvent.setup();
    renderAt(`/contracts/new?reservationId=${RID}`);
    await user.click(await screen.findByRole('button', { name: 'Ajouter un autre conducteur' }));
    const grid = document.querySelector('.driver-grid') as HTMLElement;
    await user.type(within(grid).getByLabelText(/^Nom et prénom/), 'Second Démo');
    const confirm = screen.getByRole('button', { name: 'Confirmer le départ' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText('Pour chaque autre conducteur : nom, date de naissance et n° de permis.')).toBeTruthy();
    await user.type(within(grid).getByLabelText(/^Date de naissance/), '1990-01-01');
    await user.type(within(grid).getByLabelText(/^Permis de conduire N°/), 'L-2');
    expect(confirm.disabled).toBe(false);
  });

  it('the manager is warned when files are not persistent or the backup is missing', async () => {
    mockFetch(managerMe, (url) =>
      url === '/api/system/status'
        ? json(200, { storage: { warning: true }, backup: { warning: true, last: null, lastOkAt: null, overdueHours: 36 } })
        : undefined,
    );
    renderAt('/');
    expect(await screen.findByText('Protection des données : à régler')).toBeTruthy();
    expect(screen.getByText(/STORAGE_DIR non défini/)).toBeTruthy();
    expect(screen.getByText(/Aucune sauvegarde enregistrée/)).toBeTruthy();
  });
});

describe('printable contract', () => {
  it('prints the frozen copy with bilingual labels, the documents ticked and the general conditions', async () => {
    mockFetch(employeeMe);
    const { container } = renderAt(`/contracts/${KID}/print`);
    expect(await screen.findByText('Location Démo')).toBeTruthy();
    expect(container.querySelector('.sidebar')).toBeNull(); // no app shell on the printed page
    expect(screen.getAllByText('LOCATAIRE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('المكتري').length).toBeGreaterThan(0);
    expect(screen.getByText('0660')).toBeTruthy();
    expect(screen.getByText('Commerçant')).toBeTruthy();
    expect(screen.getByText(/ICE : 000000000000001/)).toBeTruthy();
    expect(screen.getByText(/0500000000 \/ 0600000000/)).toBeTruthy();
    expect(screen.getByText('La journée de location correspond à 24 heures.')).toBeTruthy();
    expect(screen.getByText('Le conducteur est responsable du véhicule en cas d’accident.')).toBeTruthy();
    const docs = container.querySelector('.p-docs')!.textContent!;
    expect(docs).toContain('☒ Carte grise');
    expect(docs).toContain('☐ Vignette');
    expect(screen.getByText(/400,00 MAD/)).toBeTruthy(); // reste
  });
});

describe('contract template', () => {
  it('the manager adds an article; saving sends a new version', async () => {
    const m = mockFetch(managerMe, (url, init) => (url === '/api/contract-templates' && init.method === 'POST' ? json(201, { template: { ...template, version: 3 } }) : undefined));
    const user = userEvent.setup();
    renderAt('/settings/contract');
    expect(await screen.findByText(/Version 2/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ajouter un article' }));
    await user.type(screen.getByLabelText('Texte 2'), 'Le client s’interdit de quitter le territoire marocain sans autorisation écrite.');
    await user.click(screen.getByRole('button', { name: 'Ajouter un document' }));
    await user.type(screen.getByLabelText('Documents remis (cases à cocher) 4'), 'Autorisation');
    await user.click(screen.getByRole('button', { name: 'Enregistrer une nouvelle version' }));
    const post = calls(m, 'POST', '/api/contract-templates')[0]!;
    const body = JSON.parse(String(post[1]!.body));
    expect(body.terms).toHaveLength(2);
    expect(body.terms[1]).toEqual({ title: 'ART 02', body: 'Le client s’interdit de quitter le territoire marocain sans autorisation écrite.' });
    expect(body.handedDocuments).toEqual(['Carte grise', 'Assurance', 'Vignette', 'Autorisation']);
    expect(await screen.findByText(/Version 3 enregistrée/)).toBeTruthy();
  });

  it('an employee has no access to the template page', async () => {
    mockFetch(employeeMe);
    renderAt('/settings/contract');
    expect(await screen.findByText('Cette page est réservée au gérant.')).toBeTruthy();
  });
});
