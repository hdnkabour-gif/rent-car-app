/**
 * Restore drill (issue #14): proves that a backup can actually be brought back, end to end, WITHOUT
 * touching the source database or its files.
 *
 *  1. take the newest COMPLETE off-site backup (or a local one) and download it into a new, empty,
 *     detached folder — every object checked against the completion marker (size + SHA-256);
 *  2. verify it: passphrase, manifest authentication, dump and every file SHA-256;
 *  3. create a brand-new database `fleetora_drill_<random>` and an empty storage folder, restore into
 *     them, and prove the result (same row counts, same migrations, every file present with its SHA-256);
 *  4. negative checks on throwaway copies: wrong passphrase, truncated dump, missing file, altered
 *     manifest, interrupted upload, network failures (retried, then reported), non-empty target refused;
 *  5. drop the drill database and delete the temporary folders.
 *
 * The report holds counts, names and checksums only — never data, paths or secrets.
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listBackups, restoreBackup, sha256File, toolPool, verifyBackup, type Manifest } from './backup.js';
import { DirTarget, listOffsite, pullBackup, pushBackup, type OffsiteTarget } from './offsite.js';

export const DRILL_DB_PATTERN = /^fleetora_drill_[0-9a-f]{12}$/;

export interface DrillReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  source: 'offsite' | 'local';
  offsiteKind: 'dir' | 's3' | null;
  backupName: string | null;
  manifestSha256: string | null;
  encrypted: boolean;
  tables: number | null;
  rowsTotal: number | null;
  files: number | null;
  filesVerified: number;
  steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }>;
  negative: Array<{ check: string; passed: boolean; detail: string }>;
}

/** A target whose first `failures` calls fail like a dropped network connection. */
export class FlakyTarget implements OffsiteTarget {
  readonly kind: 'dir' | 's3';
  readonly label: string;
  calls = 0;
  constructor(private readonly inner: OffsiteTarget, private failures: number) {
    this.kind = inner.kind;
    this.label = `flaky(${inner.label})`;
  }
  private trip() {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw Object.assign(new Error('simulated network failure (ECONNRESET)'), { code: 'ECONNRESET' });
    }
  }
  async put(k: string, f: string, s: string) { this.trip(); return this.inner.put(k, f, s); }
  async head(k: string) { this.trip(); return this.inner.head(k); }
  async get(k: string, d: string) { this.trip(); return this.inner.get(k, d); }
  async list(p: string) { this.trip(); return this.inner.list(p); }
  async remove(k: string) { this.trip(); return this.inner.remove(k); }
}

function dbUrl(adminUrl: string, db: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function runDrill(opts: {
  adminDatabaseUrl: string;
  passphrase?: string;
  target: OffsiteTarget | null;
  localBackupDir?: string;
  backupName?: string;
  workRoot?: string;
  negative?: boolean;
  keep?: boolean;
  retry?: { attempts?: number; baseMs?: number };
}): Promise<DrillReport> {
  const started = new Date();
  const report: DrillReport = {
    ok: false, startedAt: started.toISOString(), finishedAt: '', source: opts.target ? 'offsite' : 'local',
    offsiteKind: opts.target?.kind ?? null, backupName: null, manifestSha256: null, encrypted: false,
    tables: null, rowsTotal: null, files: null, filesVerified: 0, steps: [], negative: [],
  };
  const step = async <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      report.steps.push({ step: name, ok: true, ms: Date.now() - t0, ...(detail ? { detail: detail(r) } : {}) });
      return r;
    } catch (e) {
      report.steps.push({ step: name, ok: false, ms: Date.now() - t0, detail: (e as Error).message.slice(0, 500) });
      throw e;
    }
  };

  const work = await mkdtemp(path.join(opts.workRoot ?? tmpdir(), 'fleetora-drill-'));
  const admin = toolPool(opts.adminDatabaseUrl);
  const drillDb = `fleetora_drill_${randomBytes(6).toString('hex')}`;
  let dbCreated = false;
  try {
    // 1. Fetch a detached copy.
    const name = await step('choose backup', async () => {
      if (opts.backupName) return opts.backupName;
      const names = opts.target ? (await listOffsite(opts.target)).complete : await listBackups(opts.localBackupDir ?? '');
      if (!names[0]) throw new Error(opts.target ? 'no complete off-site backup found' : 'no local backup found');
      return names[0];
    }, (n) => n);
    report.backupName = name;
    const fetched = await step('fetch detached copy', async () => {
      if (opts.target) return (await pullBackup(opts.target, name, path.join(work, 'fetched'), { retry: opts.retry })).dir;
      const dst = path.join(work, 'fetched', name);
      await cp(path.join(opts.localBackupDir!, name), dst, { recursive: true, errorOnExist: true, force: false });
      return dst;
    }, () => 'every object matched its size and SHA-256');
    report.manifestSha256 = await sha256File(path.join(fetched, 'manifest.json'));

    // 2. Verify everything.
    const manifest = await step('verify backup', async () => {
      const { manifest, problems } = await verifyBackup(fetched, opts.passphrase);
      if (problems.length) throw new Error(problems.join(' | '));
      return manifest;
    }, (m) => `${m.files.length} files + dump checked`);
    report.encrypted = Boolean(manifest.encryption);
    report.tables = Object.keys(manifest.tables).length;
    report.rowsTotal = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
    report.files = manifest.files.length;

    // 3. Restore into a NEW database + EMPTY storage, then prove it.
    await step('create isolated database', async () => {
      if (!DRILL_DB_PATTERN.test(drillDb)) throw new Error('invalid drill database name');
      await admin.query(`CREATE DATABASE ${drillDb}`); // fails if it exists: never reuses a database
      dbCreated = true;
    }, () => 'fresh database created for this drill only');
    const storage = path.join(work, 'restored-files');
    await step('restore and prove', async () => {
      const { problems } = await restoreBackup({ dir: fetched, databaseUrl: dbUrl(opts.adminDatabaseUrl, drillDb), storageDir: storage, passphrase: opts.passphrase });
      if (problems.length) throw new Error(problems.join(' | '));
    }, () => 'row counts, migrations and every file checksum equal the manifest');
    report.filesVerified = await step('re-hash every restored file', async () => {
      let n = 0;
      for (const f of manifest.files) {
        if ((await sha256File(path.join(storage, f.key))) !== f.sha256) throw new Error(`restored file ${f.key} differs`);
        n += 1;
      }
      return n;
    }, (n) => `${n} files identical (SHA-256)`);

    // 4. Negative checks on throwaway copies.
    if (opts.negative !== false) await negativeChecks(report, fetched, manifest, work, opts, dbUrl(opts.adminDatabaseUrl, drillDb));

    report.ok = report.steps.every((s) => s.ok) && report.negative.every((n) => n.passed);
    return report;
  } catch {
    report.ok = false;
    return report;
  } finally {
    if (dbCreated && DRILL_DB_PATTERN.test(drillDb) && !opts.keep) {
      await admin.query(`DROP DATABASE IF EXISTS ${drillDb} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end();
    if (!opts.keep) await rm(work, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
  }
}

async function negativeChecks(
  report: DrillReport,
  fetched: string,
  manifest: Manifest,
  work: string,
  opts: { passphrase?: string; retry?: { attempts?: number; baseMs?: number } },
  restoredDbUrl: string,
): Promise<void> {
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      report.negative.push({ check: name, passed: true, detail: await fn() });
    } catch (e) {
      report.negative.push({ check: name, passed: false, detail: (e as Error).message.slice(0, 300) });
    }
  };
  const copy = async (label: string) => {
    const dst = path.join(work, `neg-${label}`, path.basename(fetched));
    await cp(fetched, dst, { recursive: true });
    return dst;
  };
  const expectProblem = async (dir: string, re: RegExp, pass?: string) => {
    const { problems } = await verifyBackup(dir, pass ?? opts.passphrase);
    if (!problems.some((p) => re.test(p))) throw new Error(`not detected (problems: ${problems.join(' | ') || 'none'})`);
    return problems.find((p) => re.test(p))!;
  };

  if (manifest.encryption) {
    await check('wrong passphrase is refused', async () => expectProblem(await copy('pass'), /Wrong backup passphrase/, `${opts.passphrase}-wrong`));
  }
  await check('truncated dump is detected', async () => {
    const dir = await copy('trunc');
    const f = path.join(dir, manifest.dump.file);
    const size = (await readFile(f)).length;
    await truncate(f, Math.floor(size / 2));
    return expectProblem(dir, /dump/);
  });
  if (manifest.files.length) {
    await check('missing file is detected', async () => {
      const dir = await copy('missing');
      const f = manifest.files[0]!;
      await unlink(path.join(dir, 'files', manifest.encryption ? `${f.key}.enc` : f.key));
      return expectProblem(dir, /missing from the backup/);
    });
    await check('damaged file is detected', async () => {
      const dir = await copy('damaged');
      const f = manifest.files[0]!;
      const p = path.join(dir, 'files', manifest.encryption ? `${f.key}.enc` : f.key);
      const b = await readFile(p);
      b[b.length - 1] = b[b.length - 1]! ^ 0xff;
      await writeFile(p, b);
      return expectProblem(dir, /damaged in the backup/);
    });
  }
  if (manifest.encryption) {
    await check('altered manifest is detected', async () => {
      const dir = await copy('tamper');
      const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
      const t = Object.keys(m.tables)[0]!;
      m.tables[t] = (m.tables[t] ?? 0) + 1;
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
      return expectProblem(dir, /manifest was altered/);
    });
  }
  // Off-site behaviour, on a throwaway local target (never the real provider).
  const scratch = new DirTarget(path.join(work, 'scratch-offsite'));
  const quick = { attempts: opts.retry?.attempts ?? 4, baseMs: Math.min(opts.retry?.baseMs ?? 50, 50) };
  if (manifest.encryption) {
    await check('interrupted upload (no completion marker) is never restored', async () => {
      await pushBackup(fetched, scratch, { retry: quick });
      await scratch.remove(`${path.basename(fetched)}/COMPLETE.json`);
      const listed = await listOffsite(scratch);
      if (listed.complete.includes(path.basename(fetched))) throw new Error('incomplete upload listed as complete');
      try {
        await pullBackup(scratch, path.basename(fetched), path.join(work, 'neg-incomplete'), { retry: { attempts: 1, baseMs: 1 } });
      } catch (e) {
        if (/not a complete off-site backup/.test((e as Error).message)) return 'refused: no completion marker';
        throw e;
      }
      throw new Error('incomplete off-site backup was accepted');
    });
    await check('network failures are retried, then the copy is verified', async () => {
      const target2 = new DirTarget(path.join(work, 'scratch-offsite-2'));
      await pushBackup(fetched, new FlakyTarget(target2, 2), { retry: quick });
      const { dir } = await pullBackup(new FlakyTarget(target2, 2), path.basename(fetched), path.join(work, 'neg-flaky'), { retry: quick });
      const { problems } = await verifyBackup(dir, opts.passphrase);
      if (problems.length) throw new Error(problems.join(' | '));
      return 'upload and download succeeded after 2 simulated connection resets each';
    });
    await check('a lasting network failure is reported, nothing half-restored', async () => {
      try {
        await pullBackup(new FlakyTarget(scratch, 1000), path.basename(fetched), path.join(work, 'neg-down'), { retry: { attempts: 3, baseMs: 1 } });
      } catch (e) {
        if (/failed after 3 attempts/.test((e as Error).message)) return 'reported after 3 attempts';
        throw e;
      }
      throw new Error('no error reported');
    });
    await check('an unencrypted backup is never copied off-site', async () => {
      const dir = await copy('plain');
      const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
      delete m.encryption;
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
      try {
        await pushBackup(dir, new DirTarget(path.join(work, 'scratch-offsite-3')), { retry: { attempts: 1, baseMs: 1 } });
      } catch (e) {
        if (/UNENCRYPTED/.test((e as Error).message)) return 'refused';
        throw e;
      }
      throw new Error('unencrypted backup was uploaded');
    });
  }
  await check('restore into a non-empty database is refused', async () => {
    try {
      await restoreBackup({ dir: fetched, databaseUrl: restoredDbUrl, storageDir: path.join(work, 'neg-storage'), passphrase: opts.passphrase });
    } catch (e) {
      if (/not empty/.test((e as Error).message)) return 'refused, nothing changed';
      throw e;
    }
    throw new Error('restore into a non-empty database was accepted');
  });
}
