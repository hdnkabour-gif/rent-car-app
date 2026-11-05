import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider, type Lang } from '../src/i18n';
import { AuthProvider } from '../src/auth';
import { App } from '../src/App';

/** UX_GUIDELINES §2.1: staff never see UUIDs, internal action codes or permission names. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const INTERNAL_CODE = /\b[a-z_]+\.[a-z_]+\b/; // e.g. auth.login, company_settings.update, users.manage

const MANAGER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';
const managerMe = {
  user: { id: MANAGER_ID, email: 'm@example.test', fullName: 'Gérant Test', role: 'manager', preferredLanguage: 'fr' },
  permissions: ['audit_logs.read', 'company_settings.read', 'company_settings.update', 'dashboard.view', 'users.manage', 'users.read'],
};

const audit = {
  items: [
    { id: 5, occurredAt: '2026-11-02T10:00:00Z', actor: { id: MANAGER_ID, fullName: 'Gérant Test' }, action: 'user.update', outcome: 'success', targetType: 'user', targetId: OTHER_ID, targetName: 'Sara Employée' },
    // Target account no longer resolvable: must not fall back to showing the UUID.
    { id: 4, occurredAt: '2026-11-02T09:00:00Z', actor: { id: MANAGER_ID, fullName: 'Gérant Test' }, action: 'user.create', outcome: 'success', targetType: 'user', targetId: OTHER_ID, targetName: null },
    // Action added in a future version without a translation yet.
    { id: 3, occurredAt: '2026-11-02T08:00:00Z', actor: null, action: 'contract.future_action', outcome: 'success', targetType: 'contract', targetId: OTHER_ID, targetName: null },
    { id: 2, occurredAt: '2026-11-02T07:00:00Z', actor: { id: OTHER_ID, fullName: null }, action: 'authz.denied', outcome: 'denied', targetType: null, targetId: null, targetName: null },
    { id: 1, occurredAt: '2026-11-02T06:00:00Z', actor: null, action: 'auth.login', outcome: 'failure', targetType: null, targetId: null, targetName: null },
  ],
  nextBefore: null,
};
const users = {
  items: [
    { id: MANAGER_ID, email: 'm@example.test', fullName: 'Gérant Test', role: 'manager', isActive: true, lastLoginAt: '2026-11-02T10:00:00Z' },
    { id: OTHER_ID, email: 'sara@example.test', fullName: 'Sara Employée', role: 'employee', isActive: false, lastLoginAt: null },
  ],
};

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = url === '/api/auth/me' ? managerMe : url.startsWith('/api/audit-logs') ? audit : url === '/api/users' ? users : null;
      return Promise.resolve(new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } }));
    }),
  );
}

function renderAt(path: string, lang: Lang) {
  localStorage.setItem('fleetora.lang', lang);
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

const visibleText = () => document.body.textContent ?? '';

afterEach(() => vi.unstubAllGlobals());

describe.each(['fr', 'ar'] as const)('no technical codes shown to staff (%s)', (lang) => {
  it('history page', async () => {
    mockApi();
    // Saved preference is French for this mock user; force the tested language afterwards.
    managerMe.user.preferredLanguage = lang;
    renderAt('/audit', lang);
    await screen.findAllByText(lang === 'fr' ? 'Modification d’un compte' : 'تعديل حساب');
    const text = visibleText();
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(INTERNAL_CODE);
    expect(text).toContain(lang === 'fr' ? 'Autre action' : 'عملية أخرى');
    expect(text).toContain(lang === 'fr' ? 'Compte de Sara Employée' : 'حساب Sara Employée');
    expect(text).toContain(lang === 'fr' ? 'Compte utilisateur' : 'حساب مستخدم');
  });

  it('team page', async () => {
    mockApi();
    managerMe.user.preferredLanguage = lang;
    renderAt('/users', lang);
    await screen.findAllByText('Sara Employée');
    const text = visibleText();
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/\b(manager|employee)\b/); // role codes are translated
  });
});
