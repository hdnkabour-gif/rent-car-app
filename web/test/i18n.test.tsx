import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider, useI18n } from '../src/i18n';
import { fr } from '../src/i18n/fr';
import { ar } from '../src/i18n/ar';

function Probe() {
  const { t, setLang, dir } = useI18n();
  return (
    <div>
      <span data-testid="label">{t('login.title')}</span>
      <span data-testid="dir">{dir}</span>
      <span data-testid="vars">{t('dashboard.welcome', { name: 'Sara' })}</span>
      <button onClick={() => setLang('ar')}>ar</button>
      <button onClick={() => setLang('fr')}>fr</button>
    </div>
  );
}

describe('i18n and RTL', () => {
  it('Arabic and French dictionaries have identical keys and no empty strings', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(fr).sort());
    for (const v of [...Object.values(fr), ...Object.values(ar)]) expect(v.trim()).not.toBe('');
  });

  it('defaults to French LTR and switches the document to Arabic RTL', async () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('label')).toHaveTextContent('Connexion');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('fr');

    await userEvent.click(screen.getByText('ar'));
    expect(screen.getByTestId('label')).toHaveTextContent('تسجيل الدخول');
    expect(screen.getByTestId('dir')).toHaveTextContent('rtl');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(localStorage.getItem('fleetora.lang')).toBe('ar');

    await userEvent.click(screen.getByText('fr'));
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('interpolates variables', () => {
    render(
      <I18nProvider initial="ar">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('vars')).toHaveTextContent('مرحباً، Sara.');
  });
});
