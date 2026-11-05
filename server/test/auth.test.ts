import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { auditRows, createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp({ ACCOUNT_LOCKOUT_THRESHOLD: '3', ACCOUNT_LOCKOUT_MINUTES: '15' });
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
});
afterAll(async () => {
  await ctx.pool.end();
});

const cookieName = () => ctx.config.cookie.name;

describe('login', () => {
  it('succeeds with valid credentials and sets a hardened session cookie', async () => {
    const u = await createUser(ctx.pool, { email: 'manager@example.test', role: 'manager' });
    const res = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: 'Manager@Example.test ', password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: u.id, email: u.email, role: 'manager' });
    expect(res.body.permissions).toContain('company_settings.update');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt\$/);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${cookieName()}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);

    // Token is stored only as a hash
    const token = cookie.split(';')[0]!.split('=')[1]!;
    const { rows } = await ctx.pool.query('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].token_hash).toString('base64url')).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);

    const audit = await auditRows(ctx.pool, 'auth.login');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'success', actor_user_id: u.id });
  });

  it('fails with a wrong password, using the same generic message as an unknown email', async () => {
    await createUser(ctx.pool, { email: 'emp@example.test', role: 'employee' });
    const wrong = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: 'emp@example.test', password: 'nope-nope-nope' });
    const unknown = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: 'ghost@example.test', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const audit = await auditRows(ctx.pool, 'auth.login');
    expect(audit.map((a) => [a.outcome, a.metadata.reason])).toEqual([
      ['failure', 'bad_password'],
      ['failure', 'unknown_account'],
    ]);
    // Attempted password and email are not stored in the audit log.
    expect(JSON.stringify(audit)).not.toContain('nope-nope-nope');
    expect(JSON.stringify(audit)).not.toContain('ghost@example.test');
  });

  it('rejects malformed login bodies with 400', async () => {
    const res = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    const big = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: 'a@example.test', password: 'x'.repeat(500) });
    expect(big.status).toBe(400);
  });

  it('rejects malformed JSON without leaking internals', async () => {
    const res = await request(ctx.app).post('/api/auth/login').set(CSRF).set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|SyntaxError/);
  });

  it('rejects inactive accounts', async () => {
    const u = await createUser(ctx.pool, { email: 'old@example.test', role: 'employee', isActive: false });
    const res = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const u = await createUser(ctx.pool, { email: 'lock@example.test', role: 'employee' });
    for (let i = 0; i < 3; i++) {
      await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: 'wrong-password' }).expect(401);
    }
    const res = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
    const { rows } = await ctx.pool.query('SELECT locked_until > now() AS locked FROM users WHERE id = $1', [u.id]);
    expect(rows[0].locked).toBe(true);

    // Lock expiry restores access
    await ctx.pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [u.id]);
    await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password }).expect(200);
  });

  it('requires the anti-CSRF header and an allowed Origin on state-changing requests', async () => {
    const u = await createUser(ctx.pool, { email: 'csrf@example.test', role: 'employee' });
    const noHeader = await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('csrf_failed');
    const badOrigin = await request(ctx.app)
      .post('/api/auth/login')
      .set(CSRF)
      .set('Origin', 'https://evil.example')
      .send({ email: u.email, password: u.password });
    expect(badOrigin.status).toBe(403);
    const goodOrigin = await request(ctx.app)
      .post('/api/auth/login')
      .set(CSRF)
      .set('Origin', 'http://localhost:5173')
      .send({ email: u.email, password: u.password });
    expect(goodOrigin.status).toBe(200);
  });
});

describe('login rate limiting', () => {
  it('successful logins do not count toward the limit (an office behind one address can log in)', async () => {
    const limited = await setupTestApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const u = await createUser(limited.pool, { email: 'office@example.test', role: 'employee' });
      for (let i = 0; i < 6; i++) {
        await request(limited.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password }).expect(200);
      }
    } finally {
      await limited.pool.end();
    }
  });

  it('returns 429 after too many attempts from one client', async () => {
    const limited = await setupTestApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      for (let i = 0; i < 3; i++) {
        await request(limited.app).post('/api/auth/login').set(CSRF).send({ email: 'x@example.test', password: 'whatever-1' }).expect(401);
      }
      const res = await request(limited.app).post('/api/auth/login').set(CSRF).send({ email: 'x@example.test', password: 'whatever-1' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('rate_limited');
    } finally {
      await limited.pool.end();
    }
  });
});

describe('sessions', () => {
  it('GET /api/auth/me works with a session and fails without one', async () => {
    const u = await createUser(ctx.pool, { email: 'me@example.test', role: 'employee' });
    await request(ctx.app).get('/api/auth/me').expect(401);
    const agent = await loginAgent(ctx.app, u.email, u.password);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe(u.email);
    expect(me.body.permissions).toEqual(['branches.read', 'cash.read', 'company_settings.read', 'contracts.manage', 'contracts.read', 'customers.manage', 'customers.read', 'dashboard.view', 'expenses.record', 'payments.record', 'reminders.send', 'reservations.manage', 'reservations.read', 'vehicles.inspect', 'vehicles.read']);
  });

  it('logout revokes the session server-side (replaying the cookie fails)', async () => {
    const u = await createUser(ctx.pool, { email: 'out@example.test', role: 'employee' });
    const login = await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    await request(ctx.app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    await request(ctx.app).post('/api/auth/logout').set(CSRF).set('Cookie', cookie).expect(204);
    await request(ctx.app).get('/api/auth/me').set('Cookie', cookie).expect(401);
    const { rows } = await ctx.pool.query('SELECT revoked_reason FROM sessions');
    expect(rows[0].revoked_reason).toBe('logout');
    expect(await auditRows(ctx.pool, 'auth.logout')).toHaveLength(1);
  });

  it('rejects sessions past their absolute expiry', async () => {
    const u = await createUser(ctx.pool, { email: 'exp@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second'`);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects sessions past their idle timeout', async () => {
    const u = await createUser(ctx.pool, { email: 'idle@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    await ctx.pool.query(`UPDATE sessions SET idle_expires_at = now() - interval '1 second'`);
    await agent.get('/api/auth/me').expect(401);
  });

  it('extends the idle window on activity but never beyond the absolute expiry', async () => {
    const u = await createUser(ctx.pool, { email: 'slide@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    await ctx.pool.query(
      `UPDATE sessions SET last_seen_at = now() - interval '10 minutes', idle_expires_at = now() + interval '5 minutes',
                           expires_at = now() + interval '20 minutes'`,
    );
    await agent.get('/api/auth/me').expect(200);
    const { rows } = await ctx.pool.query('SELECT idle_expires_at, expires_at FROM sessions');
    expect(rows[0].idle_expires_at.getTime()).toBe(rows[0].expires_at.getTime());
  });

  it('logout-all revokes every session of the user', async () => {
    const u = await createUser(ctx.pool, { email: 'all@example.test', role: 'employee' });
    const a1 = await loginAgent(ctx.app, u.email, u.password);
    const a2 = await loginAgent(ctx.app, u.email, u.password);
    await a1.post('/api/auth/logout-all').set(CSRF).expect(204);
    await a2.get('/api/auth/me').expect(401);
    await a1.get('/api/auth/me').expect(401);
  });

  it('rejects forged or garbage session cookies', async () => {
    await request(ctx.app).get('/api/auth/me').set('Cookie', `${cookieName()}=forged-token`).expect(401);
    await request(ctx.app).get('/api/auth/me').set('Cookie', `${cookieName()}=${'a'.repeat(5000)}`).expect(401);
  });

  it('changing password keeps the current session and revokes the others', async () => {
    const u = await createUser(ctx.pool, { email: 'chg@example.test', role: 'employee' });
    const current = await loginAgent(ctx.app, u.email, u.password);
    const other = await loginAgent(ctx.app, u.email, u.password);
    await current
      .post('/api/auth/change-password')
      .set(CSRF)
      .send({ currentPassword: 'wrong', newPassword: 'Brand-New-Pass-1' })
      .expect(400);
    await current
      .post('/api/auth/change-password')
      .set(CSRF)
      .send({ currentPassword: u.password, newPassword: 'short' })
      .expect(400);
    await current
      .post('/api/auth/change-password')
      .set(CSRF)
      .send({ currentPassword: u.password, newPassword: 'Brand-New-Pass-1' })
      .expect(204);
    await current.get('/api/auth/me').expect(200);
    await other.get('/api/auth/me').expect(401);
    await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password }).expect(401);
    await request(ctx.app).post('/api/auth/login').set(CSRF).send({ email: u.email, password: 'Brand-New-Pass-1' }).expect(200);
  });

  it('a new login replaces a session already present in the browser (no fixation)', async () => {
    const u = await createUser(ctx.pool, { email: 'fix@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    await agent.post('/api/auth/login').set(CSRF).send({ email: u.email, password: u.password }).expect(200);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL');
    expect(rows[0].n).toBe(1);
  });

  it('saves the preferred UI language', async () => {
    const u = await createUser(ctx.pool, { email: 'lang@example.test', role: 'employee' });
    const agent = await loginAgent(ctx.app, u.email, u.password);
    const res = await agent.patch('/api/auth/me/preferences').set(CSRF).send({ preferredLanguage: 'ar' }).expect(200);
    expect(res.body.user.preferredLanguage).toBe('ar');
    await agent.patch('/api/auth/me/preferences').set(CSRF).send({ preferredLanguage: 'en' }).expect(400);
  });
});
