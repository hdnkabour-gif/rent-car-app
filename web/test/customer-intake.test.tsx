import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

const ID = '11111111-2222-4333-8444-555555555555';
const VEHICLE = '22222222-2222-4333-8444-555555555555';
function json(status: number, value: unknown) {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
}
function renderAt(url: string) {
  return render(
    <I18nProvider initial="fr"><AuthProvider><MemoryRouter initialEntries={[url]}><App/></MemoryRouter></AuthProvider></I18nProvider>,
  );
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('customer invitation UI (synthetic files only)', () => {
  it('the guest can verify, consent, upload and explicitly submit without a staff login', async () => {
    const calls: Array<{url:string;init:RequestInit}> = [];
    vi.stubGlobal('fetch', vi.fn((url:string, init:RequestInit = {}) => {
      calls.push({ url, init });
      if (url === '/api/auth/me') return json(401, {error:{code:'unauthorized'}});
      if (url === '/api/branding') return json(200, {name:'Fleetora', color:'#204d82'});
      if (url.endsWith('/verify')) return json(200, {
        offer:{vehicle:{make:'Dacia',model:'Logan'},startAt:'2026-11-25T10:00:00Z',endAt:'2026-11-26T10:00:00Z',
          days:1,dailyCents:30000,totalCents:30000,depositCents:50000,expiresAt:'2026-11-24T10:00:00Z'},
        submitted:false,
      });
      if (url.includes('/documents/id_front')) return json(201, {accepted:true,duplicate:false});
      if (url.endsWith('/submit')) return json(200, {submitted:true});
      return json(404, {});
    }));
    const user = userEvent.setup();
    renderAt(`/collect/${ID}`);
    await user.type(await screen.findByLabelText('Code de sécurité'), '1234567890');
    await user.click(screen.getByRole('button', {name:'Accéder à mon dossier'}));
    expect(await screen.findByText('Dacia Logan')).toBeTruthy();
    await user.click(screen.getByRole('checkbox'));
    await user.upload(screen.getByText('Importer les photos ou PDF').querySelector('input')!, new File(
      ['%PDF-1.4\nsynthetic'], 'synthetic.pdf', {type:'application/pdf'},
    ));
    expect(await screen.findByText(/1 document\(s\) transmis/)).toBeTruthy();
    await user.click(screen.getByRole('button',{name:'Terminer et envoyer pour vérification'}));
    expect(await screen.findByText(/Documents reçus/)).toBeTruthy();
    expect(calls.some(x => x.url === `/api/guest-intakes/${ID}/documents/id_front` &&
      (x.init.headers as Record<string,string>)['X-Intake-Code'] === '1234567890')).toBe(true);
    expect(calls.some(x => x.url.includes('documents') && (x.init.headers as Record<string,string>)['X-Privacy-Consent'] === 'yes')).toBe(true);
  });

  it('a manager issues a link and sees WhatsApp as a manual share, not an API message', async () => {
    const me = {user:{id:'m1',email:'demo@example.test',fullName:'Manager Demo',role:'manager',preferredLanguage:'fr'},
      permissions:['dashboard.view','reservations.read','reservations.manage','customers.read','vehicles.read'],
      branchIds:[]};
    const calls: Array<{url:string;init:RequestInit}> = [];
    vi.stubGlobal('fetch', vi.fn((url:string, init:RequestInit = {}) => {
      calls.push({url,init});
      if (url === '/api/auth/me') return json(200,me);
      if (url === '/api/branding') return json(200,{name:'Fleetora',color:'#204d82'});
      if (url === '/api/vehicles') return json(200,{items:[{id:VEHICLE,make:'Dacia',model:'Logan',plate:'99991-أ-1',dailyRateCents:30000,depositCents:50000}]});
      if (url === '/api/customer-intakes' && init.method === 'POST') return json(201,{id:ID,path:`/collect/${ID}`,code:'1234567890',expiresAt:'2026-11-24T10:00:00Z'});
      if (url === '/api/customer-intakes') return json(200,{items:[]});
      if (url === '/api/customers') return json(200,{items:[]});
      return json(200,{});
    }));
    renderAt('/customer-intakes');
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Dacia Logan/ });
    await user.selectOptions(screen.getByLabelText('Véhicule proposé'), VEHICLE);
    fireEvent.change(screen.getByLabelText('Départ'), {target:{value:'2026-11-25T10:00'}});
    fireEvent.change(screen.getByLabelText('Retour'), {target:{value:'2026-11-26T10:00'}});
    await user.click(screen.getByRole('button',{name:'Créer une invitation'}));
    expect(await screen.findByText('1234567890')).toBeTruthy();
    const link = screen.getByRole('link',{name:'Partager manuellement via WhatsApp'});
    expect(link.getAttribute('href')).toContain('https://wa.me/?text=');
    expect(calls.filter(x=>x.url==='/api/customer-intakes' && x.init.method==='POST')).toHaveLength(1);
  });
});
