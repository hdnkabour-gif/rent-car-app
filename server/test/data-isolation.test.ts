import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestApp, type TestContext } from './helpers.js';

/**
 * Company data stays inside the company system (D-012, CLAUDE.md): the server never sends data
 * to another service (no analytics, no telemetry, no external OCR, no CDN), and the browser is
 * told to talk only to this server. This test fails if such code is added without review.
 */
const ROOT = path.resolve(__dirname, '..', 'src');
const WEB = path.resolve(__dirname, '..', '..', 'web', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

const OUTBOUND = /\bfetch\s*\(|\bhttps?\.(request|get)\s*\(|from ['"](axios|node-fetch|got|undici|ws)['"]|new WebSocket|sendBeacon|XMLHttpRequest/;

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => {
  await ctx.pool.end();
});

describe('company data never leaves the system', () => {
  it('server code contains no outbound network call', () => {
    const offenders = files(ROOT).filter((f) => OUTBOUND.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('browser code only calls this server (/api), never another address', () => {
    const external = files(WEB).flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(/fetch\(\s*[`'"]([^`'"]*)/g)].map((m) => m[1]!).filter((u) => !u.startsWith('/api')).map((u) => `${path.basename(f)}: ${u}`);
    });
    expect(external).toEqual([]);
    const thirdParty = files(WEB).filter((f) => /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}/i.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
    expect(thirdParty.map((f) => path.basename(f))).toEqual([]);
  });

  it('the browser is only allowed to connect to this server and load its own assets', async () => {
    const res = await request(ctx.app).get('/api/health');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/https?:\/\//);
  });
});
