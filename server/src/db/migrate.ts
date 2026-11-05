import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/db (tsx) and dist/src/db (compiled build).
export const MIGRATIONS_DIR =
  [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')].find((d) => existsSync(d)) ??
  path.resolve(here, '../../migrations');
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql(?:\.gz)?$/;
// Arbitrary constant: serialises concurrent migration runs.
const LOCK_KEY = 72_410_001;

export interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  const files: MigrationFile[] = [];
  for (const file of entries) {
    const m = FILE_PATTERN.exec(file)!;
    const raw = await readFile(path.join(dir, file));
    const sql = file.endsWith('.sql.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    files.push({
      version: m[1]!,
      name: m[2]!,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const versions = new Set(files.map((f) => f.version));
  if (versions.size !== files.length) throw new Error('Duplicate migration version numbers found');
  return files;
}

/**
 * Applies pending forward-only migrations, each in its own transaction.
 * Refuses to run if an already-applied migration file was modified (checksum mismatch).
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const [version] of done) {
      if (!files.some((f) => f.version === version)) {
        throw new Error(`Database has migration ${version} that is missing from ${dir}`);
      }
    }
    for (const file of files) {
      const existing = done.get(file.version);
      if (existing) {
        if (existing !== file.checksum) {
          throw new Error(
            `Migration ${file.version}_${file.name} was modified after being applied. Create a new migration instead.`,
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          file.version,
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(`${file.version}_${file.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.version}_${file.name} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
