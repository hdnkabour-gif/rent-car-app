import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkStorageWritable } from '../src/storage/health.js';

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
