import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

/** Synthetic data only. The catalogue rows mirror migration 0011's ids (text codes, not UUIDs). */
const B1 = 'b1111111-2222-4333-8444-555555555555';
const me = {
  user: { id: 'm1', email: 'm@example.test', fullName: 'Gérant Démo', role: 'manager', preferredLanguage: 'fr' },
  permissions: ['dashboard.view', 'vehicles.read', 'vehicles.manage'],
  branchIds: [B1],
};
const none = { segment: null, marketNote: null, verificationStatus: 'À vérifier' };
const model = (id: string, brandId: string, brandName: string, name: string) => ({
  id, brandId, brandName, name, dataStatus: 'À compléter', notes: null, sourceNote: null, startYear: null, endYear: null, bodyType: null,
  engineDescriptions: null, generationLabel: null, engineCode: null, fuelType: null, transmission: null, powerKw: null, displacementCm3: null, checkedOn: null,
});
const catalog = {
  brands: [{ id: 'BRAND-DACIA', name: 'Dacia', ...none }, { id: 'BRAND-KIA', name: 'Kia', ...none }],
  models: [model('MODEL-DACIA-LOGAN', 'BRAND-DACIA', 'Dacia', 'Logan'), model('MODEL-DACIA-SANDERO', 'BRAND-DACIA', 'Dacia', 'Sandero'), model('MODEL-KIA-PICANTO', 'BRAND-KIA', 'Kia', 'Picanto')],
  generations: [{ id: 'GEN-DAC-LOG-CUR', brandId: 'BRAND-DACIA', modelId: 'MODEL-DACIA-LOGAN', label: 'Nouvelle Logan – gamme actuelle Maroc', generationCode: null, productionStartYear: null, productionEndYear: null, referenceYear: 2026, bodyType: null, market: 'Maroc', sourceId: null, sourceUrl: null, verificationStatus: 'PARTIAL_OFFICIAL', notes: null }],
  engines: [{ id: 'ENG-DAC-LOG-DCI95', generationId: 'GEN-DAC-LOG-CUR', commercialVersion: 'dCi 95', engineDesignation: 'dCi 95', engineCode: null, displacementCm3: null, cylinders: null, fuelType: 'Diesel', powerHp: 95, powerKw: 69.9, torqueNm: null, gearbox: 'Manuelle', gears: null, sourceId: null, verificationStatus: 'OFFICIAL_LINEUP_PARTIAL', notes: null }],
  tireBrands: [], tireModels: [], tireSizes: [], tireFitments: [], oilBrands: [], oilProducts: [], oilFitments: [],
  maintenance: [], marketPriority: [], sources: [], statusReference: [], compatibilityIsAdvisory: true,
};

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
function mockFetch() {
  const m = vi.fn((url: string, init: RequestInit = {}) => {
    if (url === '/api/auth/me') return json(200, me);
    if (url === '/api/branches') return json(200, { items: [{ id: B1, code: 'CAS', name: 'Casablanca', city: 'Casablanca', isActive: true, vehicleCount: 0 }] });
    if (url === '/api/vehicle-catalog') return json(200, catalog);
    if (url === '/api/vehicles' && init.method === 'POST') return json(201, { id: 'v-new' });
    return json(404, {});
  });
  vi.stubGlobal('fetch', m);
  return m;
}
const posted = (m: ReturnType<typeof vi.fn>) => JSON.parse(String(m.mock.calls.find(([u, i]) => u === '/api/vehicles' && (i as RequestInit)?.method === 'POST')![1]!.body));
const renderNew = () =>
  render(
    <I18nProvider initial="fr">
      <AuthProvider>
        <MemoryRouter initialEntries={['/vehicles/new']}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('vehicle form with the reference catalogue', () => {
  it('picks brand → model → generation → engine from the catalogue and sends the text codes', async () => {
    const m = mockFetch();
    const user = userEvent.setup();
    renderNew();
    await user.type(await screen.findByLabelText(/Plaque d’immatriculation/), '99991-أ-1');
    await user.selectOptions(screen.getByLabelText('Marque'), 'BRAND-DACIA');
    // Only Dacia models are offered.
    const modelSelect = screen.getByLabelText('Modèle') as HTMLSelectElement;
    expect([...modelSelect.options].map((o) => o.textContent)).toEqual(['—', 'Logan', 'Sandero', 'Autre (saisie manuelle)']);
    await user.selectOptions(modelSelect, 'MODEL-DACIA-LOGAN');
    await user.selectOptions(screen.getByLabelText('Génération'), 'GEN-DAC-LOG-CUR');
    await user.selectOptions(screen.getByLabelText('Motorisation référencée'), 'ENG-DAC-LOG-DCI95');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(posted(m)).toMatchObject({
      branchId: B1, plate: '99991-أ-1', make: 'Dacia', model: 'Logan',
      catalogModelId: 'MODEL-DACIA-LOGAN', catalogGenerationId: 'GEN-DAC-LOG-CUR', catalogEngineId: 'ENG-DAC-LOG-DCI95',
    });
  });

  it('"Autre" lets the employee type a brand and model outside the catalogue, with no catalogue link', async () => {
    const m = mockFetch();
    const user = userEvent.setup();
    renderNew();
    await user.type(await screen.findByLabelText(/Plaque d’immatriculation/), '99992-أ-1');
    await user.selectOptions(screen.getAllByLabelText('Marque')[0]!, '__other__');
    const [, makeInput] = screen.getAllByLabelText('Marque');
    await user.type(makeInput!, 'Marque Démo');
    await user.type(screen.getByLabelText('Modèle'), 'Modèle Démo');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(posted(m)).toMatchObject({ make: 'Marque Démo', model: 'Modèle Démo', catalogModelId: null, catalogGenerationId: null, catalogEngineId: null });
  });

  it('changing the brand clears a model, generation and engine chosen before', async () => {
    const m = mockFetch();
    const user = userEvent.setup();
    renderNew();
    await user.type(await screen.findByLabelText(/Plaque d’immatriculation/), '99993-أ-1');
    await user.selectOptions(screen.getByLabelText('Marque'), 'BRAND-DACIA');
    await user.selectOptions(screen.getByLabelText('Modèle'), 'MODEL-DACIA-LOGAN');
    await user.selectOptions(screen.getByLabelText('Génération'), 'GEN-DAC-LOG-CUR');
    await user.selectOptions(screen.getByLabelText('Marque'), 'BRAND-KIA');
    expect(screen.queryByLabelText('Génération')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Modèle'), 'MODEL-KIA-PICANTO');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(posted(m)).toMatchObject({ make: 'Kia', model: 'Picanto', catalogModelId: 'MODEL-KIA-PICANTO', catalogGenerationId: null, catalogEngineId: null });
  });
});
