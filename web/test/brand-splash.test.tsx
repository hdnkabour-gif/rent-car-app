import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';
import { AuthProvider } from '../src/auth';
import { I18nProvider } from '../src/i18n';

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const mount = (lang: 'fr' | 'ar' = 'fr') => render(
  <I18nProvider initial={lang}>
    <AuthProvider><MemoryRouter><App /></MemoryRouter></AuthProvider>
  </I18nProvider>,
);
afterEach(() => vi.unstubAllGlobals());

describe('JMR splash / branding', () => {
  it('maintains the full six-second intro after auth and keeps pieces separate', async () => {
    let finishAuth!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishAuth = resolve; });
    const fetchMock = vi.fn((url: string) =>
      url === '/api/auth/me' ? pending :
        url === '/api/branding' ? json(200, {
          name: 'JMR LUXE CAR', city: 'Casablanca', color: '#172739', logo: null,
        }) : json(404, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = mount();

    const status = screen.getByRole('status', { name: /Chargement/ });
    expect(status).toHaveClass('jmr-splash');
    await waitFor(() => expect(container.querySelector('.jmr-splash__asset-preload')).toHaveAttribute(
      'src', '/branding/jmr-logo.png',
    ));
    expect(container.querySelector('.jmr-splash__jmr')).toHaveTextContent('JMR');
    expect(container.querySelector('.jmr-splash__lux')).toHaveTextContent('LUX CAR');
    expect(container.querySelector('.jmr-splash__car')).toBeInTheDocument();
    expect(container.querySelector('.jmr-splash__crown')).toBeInTheDocument();
    expect(container.querySelector('.jmr-splash__asset-preload')).toHaveAttribute('src', '/branding/jmr-logo.png');
    expect(container.querySelector('.jmr-splash__ring')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemin','0');
    finishAuth(new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }));
    expect(await screen.findByRole('heading', { name: 'Bienvenue' })).toBeInTheDocument();
    // The new intro intentionally continues after auth resolves: no abrupt cut before
    // the chrome logo and company name finish revealing. The loaded asset releases the gate.
    expect(container.querySelector('.jmr-splash')).toBeInTheDocument();
    fireEvent.load(container.querySelector('.jmr-splash__asset-preload')!);
    await waitFor(() => expect(container.querySelector('.jmr-splash')).not.toBeInTheDocument(), { timeout: 7500 });
  }, 11000);

  it('never overrides the manager-uploaded company logo', async () => {
    let finishAuth!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishAuth = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url === '/api/auth/me' ? pending :
        url === '/api/branding' ? json(200, {
          name: 'JMR LUXE CAR', city: null, color: '#172739',
          logo: '/api/branding/logo?v=demo1234',
        }) : json(404, {}),
    ));
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('.jmr-splash__other-logo')).toHaveAttribute(
      'src', '/api/branding/logo?v=demo1234',
    ));
    finishAuth(new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }));
    await screen.findByRole('heading', { name: 'Bienvenue' });
    expect(container.querySelector('.brand-logo')).toHaveAttribute('src', '/api/branding/logo?v=demo1234');
  });

  it('keeps unrelated agency branding and Arabic loading text', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url === '/api/auth/me' ? new Promise<Response>(() => undefined) :
        url === '/api/branding' ? json(200, {
          name: 'Agence Démo', city: 'Rabat', color: '#336699', logo: null,
        }) : json(404, {}),
    ));
    const { container } = mount('ar');
    await waitFor(() => expect(container.querySelector('.jmr-splash__fallback')).toHaveTextContent('Agence Démo'));
    expect(container.querySelector('.jmr-splash__other-logo')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('جار');
  });
});
