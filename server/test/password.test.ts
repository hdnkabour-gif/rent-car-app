import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('produces a salted scrypt hash that never contains the plaintext', async () => {
    const hash = await hashPassword('Synthetic-Pass-123');
    expect(hash).toMatch(/^scrypt\$15\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain('Synthetic-Pass-123');
  });

  it('uses a unique salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-1'), hashPassword('same-password-1')]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects wrong ones', async () => {
    const hash = await hashPassword('Synthetic-Pass-123');
    expect(await verifyPassword('Synthetic-Pass-123', hash)).toBe(true);
    expect(await verifyPassword('synthetic-pass-123', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('normalises Unicode so the same Arabic/French passphrase verifies', async () => {
    const composed = 'Mot-de-passé-سري';
    const decomposed = composed.normalize('NFD');
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('rejects malformed or unsupported stored hashes without throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$10$abc')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$40$8$1$aa$bb')).toBe(false);
  });

  it('flags weaker parameters for rehash', async () => {
    expect(needsRehash(await hashPassword('weak-params-1', { log2N: 12 }))).toBe(true);
    expect(needsRehash(await hashPassword('strong-params-1'))).toBe(false);
  });
});
