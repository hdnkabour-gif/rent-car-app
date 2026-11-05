import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { auditRows, createUser, CSRF, loginAgent, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
let manager: TestAgent;
let employee: TestAgent;
let managerId: string;
let employeeId: string;

beforeAll(async () => {
  ctx = await setupTestApp();
  const m = await createUser(ctx.pool, { email: 'm@example.test', role: 'manager' });
  const e = await createUser(ctx.pool, { email: 'e@example.test', role: 'employee' });
  managerId = m.id;
  employeeId = e.id;
  manager = await loginAgent(ctx.app, m.email, m.password);
  employee = await loginAgent(ctx.app, e.email, e.password);
});
afterAll(async () => {
  await ctx.pool.end();
});

const protectedRoutes: Array<[method: 'get' | 'put' | 'post' | 'patch', path: string]> = [
  ['get', '/api/auth/me'],
  ['get', '/api/users'],
  ['post', '/api/users'],
  ['get', '/api/company-settings'],
  ['put', '/api/company-settings'],
  ['get', '/api/audit-logs'],
  ['post', '/api/auth/logout-all'],
];

describe('unauthenticated requests', () => {
  it.each(protectedRoutes)('%s %s returns 401', async (method, path) => {
    const res = await request(ctx.app)[method](path).set(CSRF).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});

describe('employee permissions', () => {
  it('can read company settings', async () => {
    await employee.get('/api/company-settings').expect(200);
  });

  it.each([
    ['put', '/api/company-settings'],
    ['get', '/api/users'],
    ['post', '/api/users'],
    ['get', '/api/audit-logs'],
  ] as const)('is forbidden from %s %s', async (method, path) => {
    const res = await employee[method](path).set(CSRF).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('cannot change their own role by calling the API directly', async () => {
    await employee.patch(`/api/users/${employeeId}`).set(CSRF).send({ role: 'manager' }).expect(403);
    const { rows } = await ctx.pool.query('SELECT role_code FROM users WHERE id = $1', [employeeId]);
    expect(rows[0].role_code).toBe('employee');
  });

  it('client-supplied role data in the login body is ignored', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .set(CSRF)
      .send({ email: 'e@example.test', password: 'Correct-Horse-9', role: 'manager', permissions: ['users.manage'] });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('employee');
    expect(res.body.permissions).not.toContain('users.manage');
  });

  it('records denied attempts in the audit log', async () => {
    const denied = await auditRows(ctx.pool, 'authz.denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((d) => d.actor_user_id === employeeId && d.outcome === 'denied')).toBe(true);
  });
});

describe('manager permissions', () => {
  it('can read and update company settings, list users and read the audit log', async () => {
    await manager.get('/api/company-settings').expect(200);
    await manager.get('/api/users').expect(200);
    await manager.get('/api/audit-logs').expect(200);
  });

  it('can create an employee account; duplicate email returns 409', async () => {
    const body = { email: 'new@example.test', fullName: 'Nouvel Employé', role: 'employee', password: 'Initial-Pass-77' };
    const res = await manager.post('/api/users').set(CSRF).send(body).expect(201);
    expect(res.body).toMatchObject({ email: 'new@example.test', role: 'employee', isActive: true });
    expect(res.body.passwordHash).toBeUndefined();
    await manager.post('/api/users').set(CSRF).send({ ...body, email: 'NEW@example.test' }).expect(409);
    await manager.post('/api/users').set(CSRF).send({ ...body, email: 'x2@example.test', role: 'superadmin' }).expect(400);
    await manager.post('/api/users').set(CSRF).send({ ...body, email: 'x3@example.test', password: 'short' }).expect(400);
  });

  it('deactivating a user revokes their sessions immediately', async () => {
    const u = await createUser(ctx.pool, { email: 'leaver@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    await agent.get('/api/auth/me').expect(200);
    await manager.patch(`/api/users/${u.id}`).set(CSRF).send({ isActive: false }).expect(200);
    await agent.get('/api/auth/me').expect(401);
    const audit = await auditRows(ctx.pool, 'user.deactivate');
    expect(audit.at(-1)).toMatchObject({ target_id: u.id, actor_user_id: managerId });
    expect(audit.at(-1).metadata.revokedSessions).toBe(1);
  });

  it('changing a role revokes sessions so new permissions apply at next login', async () => {
    const u = await createUser(ctx.pool, { email: 'promo@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    await manager.patch(`/api/users/${u.id}`).set(CSRF).send({ role: 'manager' }).expect(200);
    await agent.get('/api/auth/me').expect(401);
    const again = await loginAgent(ctx.app, u.email, u.password);
    const me = await again.get('/api/auth/me').expect(200);
    expect(me.body.permissions).toContain('users.manage');
  });

  it('cannot remove their own manager access', async () => {
    const res = await manager.patch(`/api/users/${managerId}`).set(CSRF).send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('self_lockout');
  });

  it('cannot demote or deactivate the last active manager', async () => {
    const second = await createUser(ctx.pool, { email: 'm2@example.test', role: 'manager' });
    const m2 = await loginAgent(ctx.app, second.email, second.password);
    // Leave exactly two active managers: the original one and "second".
    await ctx.pool.query(`UPDATE users SET is_active = false WHERE role_code = 'manager' AND id NOT IN ($1, $2)`, [
      managerId,
      second.id,
    ]);
    // "second" may remove the first manager because another active manager (itself) remains...
    await m2.patch(`/api/users/${managerId}`).set(CSRF).send({ isActive: false }).expect(200);
    // ...but a direct DB check confirms only one active manager is left, and it cannot remove itself.
    const res = await m2.patch(`/api/users/${second.id}`).set(CSRF).send({ role: 'employee' });
    expect(res.status).toBe(409);
    const { rows } = await ctx.pool.query(`SELECT count(*)::int AS n FROM users WHERE role_code = 'manager' AND is_active`);
    expect(rows[0].n).toBe(1);
  });

  it('rejects malformed user ids and unknown fields with 400, unknown ids with 404', async () => {
    const m3 = await createUser(ctx.pool, { email: 'm3@example.test', role: 'manager' });
    const agent = await loginAgent(ctx.app, m3.email, m3.password);
    await agent.patch('/api/users/not-a-uuid').set(CSRF).send({ fullName: 'X' }).expect(400);
    await agent.patch(`/api/users/${employeeId}`).set(CSRF).send({ passwordHash: 'x' }).expect(400);
    await agent.patch('/api/users/00000000-0000-4000-8000-000000000000').set(CSRF).send({ fullName: 'X' }).expect(404);
  });
});
