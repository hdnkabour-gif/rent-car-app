import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, type Lang } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

const VEHICLE_ID = '11111111-2222-4333-8444-555555555555';
const employeeMe = {
  user: { id: 'u1', email: 'e@example.test', fullName: 'Sara Employée', role: 'employee', preferredLanguage: 'fr' },
  permissions: ['branches.read', 'company_settings.read', 'dashboard.view', 'vehicles.inspect', 'vehicles.read'],
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
  status: 'inspection_pending',
  statusChangedAt: '2026-11-02T10:00:00Z',
  mileageKm: 84250,
  fuelEighths: null,
  notes: null,
};

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
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

afterEach(() => vi.unstubAllGlobals());

describe('plate display', () => {
  it('keeps the written order of number, Arabic letter and region by isolating each part', async () => {
    const { Plate } = await import('../src/components/Plate');
    const { container } = render(<Plate value="12345 | أ | 6" />);
    const parts = [...container.querySelectorAll('bdi')].map((b) => [b.textContent, b.getAttribute('dir')]);
    expect(parts).toEqual([
      ['12345', 'ltr'],
      ['أ', 'rtl'],
      ['6', 'ltr'],
    ]);
    expect(container.textContent).toBe('12345-أ-6');
  });
});

describe('vehicle screens', () => {
  it('fleet list shows plate (LTR), status in words and the branch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/auth/me') return json(200, employeeMe);
        if (url.startsWith('/api/vehicles/summary')) return json(200, { counts: { inspection_pending: 1 }, total: 1 });
        if (url.startsWith('/api/vehicles')) return json(200, { items: [vehicle] });
        if (url === '/api/branches') return json(200, { items: [] });
        return json(404, {});
      }),
    );
    renderAt('/vehicles');
    const card = (await screen.findByText('Dacia Logan')).closest('a')!;
    const plate = card.querySelector('.plate')!;
    expect(plate).toHaveAttribute('dir', 'ltr');
    expect(plate.textContent).toBe('99991-أ-1');
    expect(card).toHaveAttribute('href', `/vehicles/${VEHICLE_ID}`);
    expect(within(card).getByText('À inspecter')).toBeInTheDocument();
    expect(within(card).getByText('Agence Démo Casablanca')).toBeInTheDocument();
    // An employee without vehicles.manage gets no "add" button.
    expect(screen.queryByRole('link', { name: /Ajouter un véhicule/ })).not.toBeInTheDocument();
  });

  it('detail shows only the allowed actions; inspection needs mileage AND fuel before it can be confirmed', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/auth/me') return json(200, employeeMe);
        if (url === `/api/vehicles/${VEHICLE_ID}/transitions`) {
          posted.push(JSON.parse(String(init?.body)));
          return json(200, { vehicle: { ...vehicle, status: 'available' }, allowedTransitions: [] });
        }
        if (url === `/api/vehicles/${VEHICLE_ID}`)
          return json(200, {
            vehicle,
            allowedTransitions: [
              { to: 'available', reasonRequired: false, inspection: true },
              { to: 'maintenance', reasonRequired: true, inspection: false },
            ],
            history: [{ id: 1, from: null, to: 'inspection_pending', at: '2026-11-02T10:00:00Z', by: 'Gérant Démo', reason: null, mileageKm: 84250, fuelEighths: null, cleaned: null, notes: null }],
          });
        return json(404, {});
      }),
    );
    renderAt(`/vehicles/${VEHICLE_ID}`);
    const inspect = await screen.findByRole('button', { name: 'Inspection OK : rendre disponible' });
    expect(screen.getByRole('button', { name: 'Envoyer en maintenance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bloquer le véhicule' })).not.toBeInTheDocument();

    await userEvent.click(inspect);
    const confirm = screen.getByRole('button', { name: 'Valider' });
    expect(confirm).toBeDisabled(); // fuel not chosen yet
    await userEvent.click(screen.getByRole('radio', { name: '3/4' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Le véhicule a été lavé' }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(posted).toEqual([{ to: 'available', expectedStatus: 'inspection_pending', mileageKm: 84250, fuelEighths: 6, cleaned: true }]);
  });

  it('maintenance requires a reason, in Arabic too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/auth/me') return json(200, { ...employeeMe, user: { ...employeeMe.user, preferredLanguage: 'ar' } });
        if (url === `/api/vehicles/${VEHICLE_ID}`)
          return json(200, { vehicle, allowedTransitions: [{ to: 'maintenance', reasonRequired: true, inspection: false }], history: [] });
        return json(404, {});
      }),
    );
    renderAt(`/vehicles/${VEHICLE_ID}`, 'ar');
    await userEvent.click(await screen.findByRole('button', { name: 'إرسالها إلى الصيانة' }));
    const confirm = screen.getByRole('button', { name: 'تأكيد' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('السبب (إلزامي)'), 'عطب في الفرامل');
    expect(confirm).toBeEnabled();
  });
});
