/**
 * Off-site copies of backups (issue #14). Only ENCRYPTED backup folders may leave the host: the
 * storage provider or the person holding the external disk only ever sees ciphertext and checksums.
 *
 * Layout at the target: `<prefix><backup name>/<relative path>` for every file of the backup folder,
 * then `<prefix><backup name>/COMPLETE.json` written LAST. A backup without that marker is an
 * interrupted upload and is never used for a restore. The marker lists every object with its size and
 * SHA-256, so a download is checked object by object before the backup itself is verified.
 *
 * Two targets behind one interface (storage stays behind an adapter, CLAUDE.md):
 *  - `dir`: a folder on a DIFFERENT disk (company external disk, NAS mount).
 *  - `s3`: a private S3-compatible bucket (AWS, Scaleway, OVH, Backblaze B2, MinIO…).
 * Credentials come from the environment only and are never logged or written anywhere.
 */
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { readManifest, sha256File } from './backup.js';

export const COMPLETE = 'COMPLETE.json';
/** The only object paths a backup may contain (RC-02): no traversal, no absolute path, no surprise file. */
const OBJECT_PATH = /^(manifest\.json|database\.dump(\.enc)?|files\/[0-9a-f]{2}\/[0-9a-f]{64}(\.enc)?)$/;
const NAME = /^fleetora-backup-\d{8}-\d{6}(-\d{3})?$/;

export interface OffsiteTarget {
  readonly kind: 'dir' | 's3';
  /** Non-secret description for messages (never credentials). */
  readonly label: string;
  put(key: string, file: string, sha256: string): Promise<void>;
  /** Size and recorded SHA-256 of an object, or null if it does not exist. */
  head(key: string): Promise<{ bytes: number; sha256: string | null } | null>;
  get(key: string, dest: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

export interface CompleteMarker {
  format: 'fleetora-offsite-1';
  backup: string;
  uploadedAt: string;
  manifestSha256: string;
  objects: Array<{ path: string; bytes: number; sha256: string }>;
}

/** Retries a transient operation (network, provider hiccup) with growing pauses. */
export async function withRetry<T>(what: string, fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 1000;
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, base * 3 ** (i - 1)));
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts: ${(last as Error)?.message ?? String(last)}`);
}

// ---------------------------------------------------------------- directory target

export class DirTarget implements OffsiteTarget {
  readonly kind = 'dir' as const;
  readonly label: string;
  constructor(private readonly root: string) {
    this.label = `dir:${path.basename(root)}`;
  }
  private p(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('invalid off-site key');
    return full;
  }
  async put(key: string, file: string): Promise<void> {
    const dst = this.p(key);
    if ((await lstat(file)).isSymbolicLink()) throw new Error('symbolic link refused');
    await mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
    const tmp = `${dst}.partial`;
    await copyFile(file, tmp);
    await rename(tmp, dst); // a reader never sees half a file under the final name
  }
  async head(key: string) {
    try {
      const dst = this.p(key);
      return { bytes: (await stat(dst)).size, sha256: await sha256File(dst) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async get(key: string, dest: string): Promise<void> {
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const src = this.p(key);
    if ((await lstat(src)).isSymbolicLink()) throw new Error('symbolic link refused on the off-site disk');
    await copyFile(src, dest);
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (!e.name.endsWith('.partial')) out.push(r);
      }
    };
    await walk(this.root, '');
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
  async remove(key: string): Promise<void> {
    await rm(this.p(key), { force: true });
  }
}

// ---------------------------------------------------------------- S3-compatible target

export interface S3Settings {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Target implements OffsiteTarget {
  readonly kind = 's3' as const;
  readonly label: string;
  private readonly client: S3Client;
  constructor(private readonly s: S3Settings) {
    this.label = `s3:${s.bucket}/${s.prefix}`;
    this.client = new S3Client({
      region: s.region,
      endpoint: s.endpoint,
      forcePathStyle: s.forcePathStyle,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
      maxAttempts: 1, // retries are ours (withRetry), so tests and logs stay predictable
      // Only send/validate the checksums every S3-compatible provider understands.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  private k(key: string) {
    return `${this.s.prefix}${key}`;
  }
  async put(key: string, file: string, sha256: string): Promise<void> {
    const body = await readFile(file);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.s.bucket, Key: this.k(key), Body: body, ContentLength: body.length, Metadata: { sha256 } }),
    );
  }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.s.bucket, Key: this.k(key) }));
      return { bytes: Number(r.ContentLength ?? -1), sha256: r.Metadata?.sha256 ?? null };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === 'NotFound' || (e as Error).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async get(key: string, dest: string): Promise<void> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: this.k(key) }));
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await pipeline(r.Body as Readable, createWriteStream(dest, { mode: 0o600 }));
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.s.bucket, Prefix: this.k(prefix), ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key.slice(this.s.prefix.length));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort();
  }
  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.s.bucket, Key: this.k(key) }));
  }
}

// ---------------------------------------------------------------- configuration

/** Reads OFFSITE_* settings. Returns null when no off-site copy is configured. Never logs secrets. */
export function offsiteFromEnv(env: NodeJS.ProcessEnv = process.env): OffsiteTarget | null {
  const kind = env.OFFSITE_KIND?.trim();
  if (!kind) return null;
  if (kind === 'dir') {
    if (!env.OFFSITE_DIR) throw new Error('OFFSITE_KIND=dir needs OFFSITE_DIR (a folder on another disk).');
    return new DirTarget(path.resolve(env.OFFSITE_DIR));
  }
  if (kind === 's3') {
    const missing = ['OFFSITE_S3_BUCKET', 'OFFSITE_S3_ACCESS_KEY_ID', 'OFFSITE_S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`OFFSITE_KIND=s3 needs ${missing.join(', ')}.`);
    let prefix = env.OFFSITE_S3_PREFIX ?? 'fleetora/';
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    return new S3Target({
      bucket: env.OFFSITE_S3_BUCKET!,
      prefix,
      region: env.OFFSITE_S3_REGION || 'us-east-1',
      endpoint: env.OFFSITE_S3_ENDPOINT || undefined,
      forcePathStyle: env.OFFSITE_S3_FORCE_PATH_STYLE === 'true',
      accessKeyId: env.OFFSITE_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.OFFSITE_S3_SECRET_ACCESS_KEY!,
    });
  }
  throw new Error(`OFFSITE_KIND must be "dir" or "s3" (got "${kind}").`);
}

// ---------------------------------------------------------------- push / pull

async function filesOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/**
 * Copies one verified, ENCRYPTED backup folder to the target and checks every object afterwards.
 * Refuses an unencrypted backup. The completion marker is written only when everything is there.
 */
export async function pushBackup(
  dir: string,
  target: OffsiteTarget,
  opts: { retry?: { attempts?: number; baseMs?: number } } = {},
): Promise<{ name: string; objects: number; bytes: number }> {
  const name = path.basename(dir);
  if (!NAME.test(name)) throw new Error(`not a backup folder name: ${name}`);
  const manifest = await readManifest(dir);
  if (!manifest.encryption) throw new Error('Refusing to copy an UNENCRYPTED backup off-site: set BACKUP_PASSPHRASE.');
  const existing = await withRetry('check the off-site target', () => target.head(`${name}/${COMPLETE}`), opts.retry);
  if (existing) throw new Error(`${name} already exists off-site; a backup is never overwritten.`);

  const objects: CompleteMarker['objects'] = [];
  for (const rel of (await filesOf(dir)).filter((r) => r !== 'VERIFIED.json')) { // the receipt is a local fact
    const file = path.join(dir, rel);
    const sha = await sha256File(file);
    const bytes = (await stat(file)).size;
    const key = `${name}/${rel}`;
    await withRetry(`upload ${rel}`, async () => {
      await target.put(key, file, sha);
      const h = await target.head(key);
      if (!h || h.bytes !== bytes || (h.sha256 !== null && h.sha256 !== sha)) throw new Error(`${rel} differs after upload`);
    }, opts.retry);
    objects.push({ path: rel, bytes, sha256: sha });
  }
  const marker: CompleteMarker = {
    format: 'fleetora-offsite-1',
    backup: name,
    uploadedAt: new Date().toISOString(),
    manifestSha256: objects.find((o) => o.path === 'manifest.json')!.sha256,
    objects,
  };
  const markerFile = path.join(dir, `.${COMPLETE}.tmp`);
  await writeFile(markerFile, JSON.stringify(marker, null, 2), { mode: 0o600 });
  try {
    const sha = await sha256File(markerFile);
    await withRetry('upload completion marker', () => target.put(`${name}/${COMPLETE}`, markerFile, sha), opts.retry);
  } finally {
    await rm(markerFile, { force: true });
  }
  return { name, objects: objects.length, bytes: objects.reduce((a, o) => a + o.bytes, 0) };
}

/** Complete off-site backups (marker present), newest first. Incomplete uploads are listed apart. */
export async function listOffsite(
  target: OffsiteTarget,
  opts: { retry?: { attempts?: number; baseMs?: number } } = {},
): Promise<{ complete: string[]; incomplete: string[] }> {
  const keys = await withRetry('list the off-site target', () => target.list('fleetora-backup-'), opts.retry);
  const names = new Map<string, boolean>();
  for (const k of keys) {
    const [name, ...rest] = k.split('/');
    if (!name || !NAME.test(name)) continue;
    names.set(name, names.get(name) === true || rest.join('/') === COMPLETE);
  }
  const all = [...names.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  return { complete: all.filter(([, c]) => c).map(([n]) => n), incomplete: all.filter(([, c]) => !c).map(([n]) => n) };
}

/**
 * Downloads one complete off-site backup into a NEW folder (`destRoot/<name>`), checking each object's
 * size and SHA-256 against the completion marker. The result can then be verified and restored.
 */
export async function pullBackup(
  target: OffsiteTarget,
  name: string,
  destRoot: string,
  opts: { retry?: { attempts?: number; baseMs?: number } } = {},
): Promise<{ dir: string; objects: number; bytes: number }> {
  if (!NAME.test(name)) throw new Error(`not a backup name: ${name}`);
  const dir = path.join(destRoot, name);
  await mkdir(destRoot, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }); // fails if it exists: always a fresh, detached copy
  const markerFile = path.join(dir, `.${COMPLETE}`);
  try {
    await withRetry('download completion marker', () => target.get(`${name}/${COMPLETE}`, markerFile), opts.retry);
  } catch (e) {
    throw new Error(`${name} is not a complete off-site backup (no completion marker): ${(e as Error).message}`, { cause: e });
  }
  const marker = JSON.parse(await readFile(markerFile, 'utf8')) as CompleteMarker;
  await rm(markerFile, { force: true });
  if (marker.format !== 'fleetora-offsite-1' || marker.backup !== name || !Array.isArray(marker.objects) || marker.objects.length > 10_000_000) {
    throw new Error('completion marker does not belong to this backup');
  }
  if (!marker.objects.some((o) => o.path === 'manifest.json')) throw new Error('completion marker lists no manifest');
  const problems: string[] = [];
  for (const o of marker.objects) {
    if (typeof o.path !== 'string' || !OBJECT_PATH.test(o.path) || !Number.isInteger(o.bytes) || o.bytes < 0 || !/^[0-9a-f]{64}$/.test(o.sha256)) {
      throw new Error('invalid object in completion marker');
    }
    const dst = path.join(dir, o.path);
    try {
      await withRetry(`download ${o.path}`, () => target.get(`${name}/${o.path}`, dst), opts.retry);
      const [bytes, sha] = [(await stat(dst)).size, await sha256File(dst)];
      if (bytes !== o.bytes || sha !== o.sha256) problems.push(`${o.path} differs from the off-site record (size or SHA-256)`);
    } catch (e) {
      problems.push(`${o.path} could not be downloaded: ${(e as Error).message}`);
    }
  }
  if (problems.length) throw new Error(`Off-site copy of ${name} is not intact:\n- ${problems.join('\n- ')}`);
  // B23-2: only encrypted backups ever go off-site, so an unencrypted one coming back was planted or altered.
  const manifest = await readManifest(dir);
  if (!manifest.encryption) throw new Error(`Off-site copy of ${name} is not encrypted: refused (off-site copies are always encrypted).`);
  return { dir, objects: marker.objects.length, bytes: marker.objects.reduce((a, o) => a + o.bytes, 0) };
}

/** Deletes every object of one off-site backup (retention only; marker removed FIRST). */
export async function removeOffsiteBackup(target: OffsiteTarget, name: string): Promise<number> {
  if (!NAME.test(name)) throw new Error(`not a backup name: ${name}`);
  const keys = await target.list(`${name}/`);
  const ordered = [...keys.filter((k) => k.endsWith(`/${COMPLETE}`)), ...keys.filter((k) => !k.endsWith(`/${COMPLETE}`))];
  for (const k of ordered) await withRetry(`delete ${k}`, () => target.remove(k));
  return ordered.length;
}
