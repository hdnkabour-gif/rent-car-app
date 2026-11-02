import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit, sanitizeMetadata } from '../src/audit/audit.js';
import { auditRows, createUser, CSRF, loginAgent, setupTestApp, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('audit metadata sanitisation', () => {
  it('drops secrets, tokens and identity-document values at any depth', () => {
    const out = sanitizeMetadata({
      role: 'employee',
      password: 'p',
      newPassword: 'p2',
      sessionToken: 't',
      token_hash: 'h',
      nested: { apiKey: 'k', cin: 'AB123456', passportNumber: 'X', ocrText: 'raw', keep: 1 },
    });
    expect(out).toEqual({ role: 'employee', nested: { keep: 1 } });
  });

  it('truncates very long strings', () => {
    const out = sanitizeMetadata({ note: 'x'.repeat(2000) }) as { note: string };
    expect(out.note.length).toBeLessThan(510);
  });
});

describe('audit log storage', () => {
  it('stores actor, action, target, timestamp and safe metadata', async () => {
    const u = await createUser(ctx.pool, { email: 'actor@example.test', role: 'manager' });
    await recordAudit(ctx.pool, {
      actorUserId: u.id,
      action: 'test.action',
      targetType: 'thing',
      targetId: '42',
      metadata: { ok: true, password: 'should-not-persist' },
    });
    const [row] = await auditRows(ctx.pool, 'test.action');
    expect(row).toMatchObject({ actor_user_id: u.id, action: 'test.action', target_type: 'thing', target_id: '42', outcome: 'success' });
    expect(row.occurred_at).toBeInstanceOf(Date);
    expect(row.metadata).toEqual({ ok: true });
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
    await expect(ctx.pool.query(`UPDATE audit_logs SET action = 'x.y'`)).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    await expect(ctx.pool.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
  });

  it('users referenced by the audit log cannot be hard-deleted', async () => {
    const { rows } = await ctx.pool.query(`SELECT id FROM users WHERE email = 'actor@example.test'`);
    await expect(ctx.pool.query('DELETE FROM users WHERE id = $1', [rows[0].id])).rejects.toThrow();
  });

  it('never contains passwords or session tokens after real API flows', async () => {
    const m = await createUser(ctx.pool, { email: 'flow@example.test', role: 'manager', password: 'Flow-Secret-Pass-1' });
    const agent = await loginAgent(ctx.app, m.email, m.password);
    await agent.post('/api/users').set(CSRF).send({
      email: 'flow2@example.test',
      fullName: 'Flow Two',
      role: 'employee',
      password: 'Second-Secret-Pass-2',
    });
    await agent.post('/api/auth/change-password').set(CSRF).send({ currentPassword: 'Flow-Secret-Pass-1', newPassword: 'Third-Secret-Pass-3' });
    const all = JSON.stringify(await auditRows(ctx.pool));
    expect(all).not.toContain('Flow-Secret-Pass-1');
    expect(all).not.toContain('Second-Secret-Pass-2');
    expect(all).not.toContain('Third-Secret-Pass-3');
    expect(all).not.toMatch(/scrypt\$/);
    const { rows: sessions } = await ctx.pool.query('SELECT token_hash FROM sessions');
    for (const s of sessions) expect(all).not.toContain(Buffer.from(s.token_hash).toString('hex'));
  });

  it('GET /api/audit-logs paginates newest first and filters by action', async () => {
    const m = await createUser(ctx.pool, { email: 'reader@example.test', role: 'manager' });
    const agent = await loginAgent(ctx.app, m.email, m.password);
    const page1 = await agent.get('/api/audit-logs?limit=2').expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].id).toBeGreaterThan(page1.body.items[1].id);
    expect(page1.body.nextBefore).toBe(page1.body.items[1].id);
    const page2 = await agent.get(`/api/audit-logs?limit=2&before=${page1.body.nextBefore}`).expect(200);
    expect(page2.body.items[0].id).toBeLessThan(page1.body.items[1].id);
    const logins = await agent.get('/api/audit-logs?action=auth.login').expect(200);
    expect(logins.body.items.every((i: { action: string }) => i.action === 'auth.login')).toBe(true);
    await agent.get('/api/audit-logs?limit=9999').expect(400);
    await agent.get("/api/audit-logs?action=x';drop").expect(400);
  });
});
