import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { auditRows, createUser, CSRF, loginAgent, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;
let managerId: string;

// Fictitious company data only.
const valid = {
  legalName: 'Société Fictive de Location SARL',
  tradeName: 'Location Fictive',
  ice: '001234567000089',
  ifNumber: '12345678',
  rcNumber: '99999',
  rcCity: 'Casablanca',
  patente: '12345',
  addressLine: '1 Rue Exemple',
  city: 'Casablanca',
  postalCode: '20000',
  countryCode: 'MA',
  phone: '+212 600 000 000',
  email: 'contact@example.test',
  website: 'https://example.test',
  currency: 'MAD',
  timezone: 'Africa/Casablanca',
  defaultLanguage: 'fr',
  documentLanguages: ['fr', 'ar'],
  brandPrimaryColor: '#1F4E79',
  showCompanyBranding: true,
  documentHeaderText: 'شركة كراء السيارات',
  documentFooterText: 'Merci de votre confiance',
  signatoryName: 'Responsable Fictif',
  signatoryTitle: 'Gérant',
};

beforeAll(async () => {
  ctx = await setupTestApp();
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee' });
  managerId = m.id;
  manager = await loginAgent(ctx.app, m.email, m.password);
  employee = await loginAgent(ctx.app, e.email, e.password);
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('company settings', () => {
  it('has Moroccan defaults (MAD, Africa/Casablanca, French + Arabic)', async () => {
    const res = await employee.get('/api/company-settings').expect(200);
    expect(res.body.settings).toMatchObject({
      currency: 'MAD',
      timezone: 'Africa/Casablanca',
      defaultLanguage: 'fr',
      documentLanguages: ['fr', 'ar'],
      countryCode: 'MA',
    });
    expect(res.body.logo).toEqual({ configured: false });
  });

  it('manager can update; values round-trip including Arabic text', async () => {
    const res = await manager.put('/api/company-settings').set(CSRF).send(valid).expect(200);
    expect(res.body.settings).toMatchObject(valid);
    expect(res.body.updatedBy).toBe(managerId);
    const read = await employee.get('/api/company-settings').expect(200);
    expect(read.body.settings.documentHeaderText).toBe('شركة كراء السيارات');
  });

  it('employee cannot update and the data is unchanged', async () => {
    await employee.put('/api/company-settings').set(CSRF).send({ ...valid, legalName: 'Hijacked' }).expect(403);
    const read = await manager.get('/api/company-settings').expect(200);
    expect(read.body.settings.legalName).toBe(valid.legalName);
  });

  it.each([
    ['ice', '12345'],
    ['ifNumber', 'ABC'],
    ['email', 'not-an-email'],
    ['website', 'javascript:alert(1)'],
    ['currency', 'dirham'],
    ['timezone', 'Mars/Olympus'],
    ['brandPrimaryColor', 'red'],
    ['documentLanguages', []],
    ['defaultLanguage', 'en'],
  ])('rejects invalid %s', async (field, value) => {
    const res = await manager.put('/api/company-settings').set(CSRF).send({ ...valid, [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects unknown fields (e.g. trying to set the product name or updated_by)', async () => {
    await manager.put('/api/company-settings').set(CSRF).send({ ...valid, productName: 'X' }).expect(400);
    await manager.put('/api/company-settings').set(CSRF).send({ ...valid, updatedBy: 'someone' }).expect(400);
  });

  it('empty optional identifiers are stored as null', async () => {
    const res = await manager.put('/api/company-settings').set(CSRF).send({ ...valid, ice: '', patente: '' }).expect(200);
    expect(res.body.settings.ice).toBeNull();
    expect(res.body.settings.patente).toBeNull();
  });

  it('audits each update with the changed fields', async () => {
    await manager.put('/api/company-settings').set(CSRF).send({ ...valid, tradeName: 'Nouveau Nom' }).expect(200);
    const rows = await auditRows(ctx.pool, 'company_settings.update');
    const last = rows.at(-1);
    expect(last).toMatchObject({ actor_user_id: managerId, target_type: 'company_settings', target_id: '1' });
    expect(last.metadata.changedFields).toContain('tradeName');
    expect(last.metadata.changes.tradeName).toEqual({ from: 'Location Fictive', to: 'Nouveau Nom' });
  });
});
