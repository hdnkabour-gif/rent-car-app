#!/usr/bin/env node
/**
 * ISOLATED STAGING ONLY: encrypted backup + checksum verification + restore into
 * a newly created disposable PostgreSQL database and separate temporary file tree.
 * Does not edit or remove any application table, file or original database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createBackup, verifyBackup, restoreBackup } from '../dist/src/backup/backup.js';

const STAGING_PROJECT_ID = '5985f4ff-7d6d-4c7b-954a-d773d166ae50';
const { DATABASE_URL, STORAGE_DIR, RAILWAY_PROJECT_ID, FLEETORA_STAGING_BACKUP_DRILL } = process.env;
if (RAILWAY_PROJECT_ID !== STAGING_PROJECT_ID ||
  FLEETORA_STAGING_BACKUP_DRILL !== 'synthetic-only' ||
  STORAGE_DIR !== '/data' || process.env.NODE_ENV !== 'production' || !DATABASE_URL) {
  console.error('STAGING_BACKUP_DRILL refused: exact staging guards not satisfied');
  process.exit(2);
}
const original = new URL(DATABASE_URL);
if (!original.hostname.endsWith('.railway.internal') || original.pathname !== '/railway') {
  console.error('STAGING_BACKUP_DRILL refused: unexpected database destination');
  process.exit(2);
}
const restoreName = 'fleetora_restore_' + randomBytes(8).toString('hex') + '_test';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
let created = false;
let tmp = '';
try {
  const target = await pool.query('SELECT current_database() AS db');
  if (target.rows[0]?.db !== 'railway') throw new Error('Unexpected staging database');
  tmp = await mkdtemp(path.join(tmpdir(), 'fleetora-disaster-drill-'));
  const passphrase = randomBytes(48).toString('base64url');
  const saved = await createBackup({
    databaseUrl: DATABASE_URL, storageDir: STORAGE_DIR,
    backupRoot: path.join(tmp, 'backup'), passphrase,
  });
  const verified = await verifyBackup(saved.dir, passphrase);
  if (verified.problems.length !== 0 || !verified.manifest.encryption) {
    const codes = verified.problems.map(p =>
      p.includes('missing from storage') ? 'staging_file_missing_from_storage' :
      p.includes('checksum') ? 'checksum_mismatch' :
      p.includes('database dump unreadable') ? 'dump_unreadable' :
      p.includes('missing from the backup') ? 'backup_file_missing' : 'other_verification_problem');
    throw new Error('Encrypted backup verification failed: ' + codes.join(',').slice(0,170));
  }
  // Name is generated internally, never supplied by any user.
  await pool.query(`CREATE DATABASE "${restoreName}" TEMPLATE template0`);
  created = true;
  const restoredUrl = new URL(DATABASE_URL);
  restoredUrl.pathname = '/' + restoreName;
  const restored = await restoreBackup({
    dir: saved.dir, databaseUrl: restoredUrl.toString(),
    storageDir: path.join(tmp, 'restore-files'), passphrase,
  });
  if (restored.problems.length !== 0) throw new Error('Restored backup does not match original');
  console.log('STAGING_BACKUP_DRILL PASS: encrypted backup, verified checksums, isolated database restore and file parity');
} catch (error) {
  console.error('STAGING_BACKUP_DRILL FAILED: ' + String(error?.message || error).slice(0,250));
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await pool.query(`DROP DATABASE IF EXISTS "${restoreName}" WITH (FORCE)`);
    } catch {
      console.error('STAGING_BACKUP_DRILL warning: test database cleanup requires manual verification');
      process.exitCode = 1;
    }
  }
  await pool.end();
  if (tmp) await rm(tmp, { recursive: true, force: true });
}
