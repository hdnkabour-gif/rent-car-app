import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard, built into Node.js — no native build tools needed
 * on Windows). Parameters follow OWASP guidance (N=2^17, r=8, p=1 ≈ 128 MiB) scaled down to
 * N=2^15 (≈ 32 MiB) for the 8 GB development PC; parameters are stored with each hash so they
 * can be raised later and old hashes still verify.
 *
 * Format: scrypt$<log2N>$<r>$<p>$<salt b64url>$<hash b64url>
 */
const DEFAULTS = { log2N: 15, r: 8, p: 1, keyLen: 32, saltLen: 16 };

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function options(log2N: number, r: number, p: number): ScryptOptions {
  const N = 2 ** log2N;
  return { N, r, p, maxmem: 128 * N * r * p + 16 * 1024 * 1024 };
}

export async function hashPassword(password: string, params: Partial<typeof DEFAULTS> = {}): Promise<string> {
  const { log2N, r, p, keyLen, saltLen } = { ...DEFAULTS, ...params };
  const salt = randomBytes(saltLen);
  const key = await scrypt(password, salt, keyLen, options(log2N, r, p));
  return ['scrypt', log2N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const log2N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  if (![log2N, rr, pp].every(Number.isInteger) || log2N < 10 || log2N > 20) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, options(log2N, rr, pp));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < DEFAULTS.log2N;
}

/** Hash used when the account does not exist, so login timing does not reveal valid emails. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
