import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkStorageWritable } from '../src/storage/health.js';
import { createUser, loginAgent, setupTestApp } from './helpers.js';

describe('safe storage health probe', () => {
  it('proves current write/read access without changing existing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fleetora-storage-health-'));
    try {
      const original = path.join(root, 'important-existing-document');
      const bytes = Buffer.from('Synthetic file: never modify', 'utf8');
      await writeFile(original, bytes);
      expect(await checkStorageWritable(root)).toBe(true);
      expect(await readFile(original)).toEqual(bytes);
      expect(await readdir(root)).toEqual(['important-existing-document']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns the manager when a configured storage path cannot be written, without leaking the path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fleetora-storage-health-'));
    const blocked = path.join(root, 'ordinary-file');
    await writeFile(blocked, 'not a directory');
    const ctx = await setupTestApp({ STORAGE_DIR: blocked });
    try {
      const manager = await createUser(ctx.pool, { email: 'storage@example.test', role: 'manager' });
      const agent = await loginAgent(ctx.app, manager.email, manager.password);
      const res = await agent.get('/api/system/status').expect(200);
      expect(res.body.storage).toMatchObject({
        persistentConfigured: false, writable: false, persistenceVerified: false, warning: true,
      });
      expect(JSON.stringify(res.body)).not.toContain(root);
    } finally {
      await ctx.pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns false for missing and non-directory storage roots without creating them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fleetora-storage-health-'));
    try {
      const file = path.join(root, 'regular-file');
      const missing = path.join(root, 'not-created');
      await writeFile(file, 'synthetic');
      expect(await checkStorageWritable(file)).toBe(false);
      expect(await checkStorageWritable(missing)).toBe(false);
      expect(await readdir(root)).toEqual(['regular-file']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
