import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, CSRF, loginAgent, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('public branding (login page shows the company)', () => {
  it('gives only the display name, city, colour and logo — never identifiers, address or phones', async () => {
    await ctx.pool.query(
      `UPDATE company_settings SET trade_name = 'Location Démo', legal_name = 'Location Démo SARL', city = 'Casablanca', ice = '000000000000001',
              phone = '0500000000', address_line = '1 rue Démo', brand_primary_color = '#7A1F4E' WHERE id = 1`,
    );
    const res = await request(ctx.app).get('/api/branding').expect(200);
    expect(res.body).toEqual({ name: 'Location Démo', city: 'Casablanca', color: '#7A1F4E', logo: null });
    expect(JSON.stringify(res.body)).not.toMatch(/0000000000|0500000000|rue/);
    await request(ctx.app).get('/api/branding/logo').expect(404);
  });

  it('serves the uploaded logo without login; hiding branding hides it', async () => {
    const m = await createUser(ctx.pool, { email: 'brand@example.test', role: 'manager' });
    const agent = await loginAgent(ctx.app, m.email, m.password);
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('brand-logo')]);
    await agent.put('/api/company-settings/logo').set(CSRF).set('Content-Type', 'image/png').send(PNG).expect(200);
    const b = (await request(ctx.app).get('/api/branding').expect(200)).body;
    expect(b.logo).toMatch(/^\/api\/branding\/logo\?v=/);
    const logo = await request(ctx.app).get('/api/branding/logo').expect(200);
    expect(Buffer.compare(logo.body, PNG)).toBe(0);
    await ctx.pool.query('UPDATE company_settings SET show_company_branding = false WHERE id = 1');
    expect((await request(ctx.app).get('/api/branding').expect(200)).body).toMatchObject({ name: null, logo: null });
    await request(ctx.app).get('/api/branding/logo').expect(404);
  });
});
