import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createUser, setupTestApp, TEST_STORAGE_DIR, type TestContext } from './helpers.js';
import { storeUpload } from '../src/storage/files.js';
import { keyFor, LocalDiskStorage, sha256Hex } from '../src/storage/storage.js';

let ctx: TestContext;
beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.pool.end(); });

describe('parallel content-addressed uploads', () => {
  it('stores one immutable record and one file for concurrent identical requests', async () => {
    const user = await createUser(ctx.pool, { email: 'concurrent@example.test', role: 'manager' });
    const storage = new LocalDiskStorage(TEST_STORAGE_DIR);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic concurrent photo')]);
    const opts = { declaredType: 'image/jpeg', originalName: 'test.jpg', userId: user.id, allowed: ['image/jpeg'] as const };
    const results = await Promise.all(Array.from({ length: 8 }, () => storeUpload(ctx.pool, storage, bytes, opts)));
    expect(new Set(results.map((f) => f.id)).size).toBe(1);
    expect(results.filter((f) => !f.reused)).toHaveLength(1);

    const sha = sha256Hex(bytes);
    const rows = await ctx.pool.query('SELECT id, sha256, storage_key FROM stored_files WHERE sha256 = $1', [sha]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].storage_key).toBe(keyFor(sha));

    const filename = path.join(TEST_STORAGE_DIR, keyFor(sha));
    expect(await readFile(filename)).toEqual(bytes);
    expect(await readdir(path.dirname(filename))).toEqual([sha]); // no temporary files left
  });
});
