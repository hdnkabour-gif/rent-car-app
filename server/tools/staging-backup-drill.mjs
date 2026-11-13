#!/usr/bin/env node
/** Encrypted backup -> restore drill using TWO freshly created disposable staging DBs.
 * The existing Fleetora staging app DB and all its files stay completely untouched.
 * The script creates synthetic app schema, user and file, verifies bytes, restores to
 * a second empty DB and drops ONLY the two DBs created by this run.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate } from '../dist/src/db/migrate.js';
import { createBackup, verifyBackup, restoreBackup } from '../dist/src/backup/backup.js';

const STAGING_PROJECT_ID='5985f4ff-7d6d-4c7b-954a-d773d166ae50';
const {DATABASE_URL,RAILWAY_PROJECT_ID,STORAGE_DIR,FLEETORA_STAGING_BACKUP_DRILL}=process.env;
if (RAILWAY_PROJECT_ID!==STAGING_PROJECT_ID ||
    FLEETORA_STAGING_BACKUP_DRILL!=='synthetic-only' ||
    STORAGE_DIR!=='/data' || process.env.NODE_ENV!=='production' || !DATABASE_URL) {
  console.error('STAGING_BACKUP_DRILL refused: exact staging guards not satisfied');
  process.exit(2);
}
const original=new URL(DATABASE_URL);
if(!original.hostname.endsWith('.railway.internal') || original.pathname!=='/railway'){
  console.error('STAGING_BACKUP_DRILL refused: unexpected PostgreSQL target');
  process.exit(2);
}
const nonce=randomBytes(8).toString('hex');
const sourceName='fleetora_drill_source_'+nonce+'_test';
const restoreName='fleetora_drill_restore_'+nonce+'_test';
const sourceUrl=new URL(DATABASE_URL);sourceUrl.pathname='/'+sourceName;
const restoreUrl=new URL(DATABASE_URL);restoreUrl.pathname='/'+restoreName;
const admin=new pg.Pool({connectionString:DATABASE_URL,max:1});
const created=[];
let dir='';
const pgIdentifier=(name)=>'"'+name+'"'; // names are fixed prefix + cryptographic hex
try{
  const row=(await admin.query('SELECT current_database() AS db')).rows[0];
  if(row?.db!=='railway') throw new Error('Not the expected isolated staging database');
  dir=await mkdtemp(path.join(tmpdir(),'fleetora-disaster-drill-'));
  await admin.query(`CREATE DATABASE ${pgIdentifier(sourceName)} TEMPLATE template0`);
  created.push(sourceName);
  await admin.query(`CREATE DATABASE ${pgIdentifier(restoreName)} TEMPLATE template0`);
  created.push(restoreName);
  const sourcePool=new pg.Pool({connectionString:sourceUrl.toString(),max:1});
  try{
    const applied=await migrate(sourcePool);
    if(!applied.some(v=>v.startsWith('0014_'))) throw new Error('Synthetic schema migrations incomplete');
    const user=(await sourcePool.query(
      `INSERT INTO users (email,full_name,role_code,password_hash)
       VALUES ('backup-drill@fleetora.example.test','Synthetic Backup Tester','manager','not-a-real-password')
       RETURNING id`,
    )).rows[0].id;
    const bytes=Buffer.from('%PDF-1.4\n% SYNTHETIC FLEETORA BACKUP DRILL - NO REAL DOCUMENT\n%%EOF\n','utf8');
    const sha=createHash('sha256').update(bytes).digest('hex');
    const key=sha.slice(0,2)+'/'+sha;
    const sourceStorage=path.join(dir,'source-files');
    await mkdir(path.dirname(path.join(sourceStorage,key)),{recursive:true});
    await writeFile(path.join(sourceStorage,key),bytes,{mode:0o600});
    await sourcePool.query(
      `INSERT INTO stored_files (storage_key,sha256,size_bytes,mime_type,original_name,uploaded_by)
       VALUES ($1,$2,$3,'application/pdf','synthetic-identity.pdf',$4)`,
      [key,sha,bytes.length,user],
    );
    const passphrase=randomBytes(40).toString('base64url');
    const saved=await createBackup({
      databaseUrl:sourceUrl.toString(),storageDir:sourceStorage,
      backupRoot:path.join(dir,'backup'),passphrase,
    });
    const verified=await verifyBackup(saved.dir,passphrase);
    if(verified.problems.length!==0 || !verified.manifest.encryption || verified.manifest.files.length!==1) {
      throw new Error('Encrypted synthetic source backup failed checksum verification');
    }
    const restored=await restoreBackup({
      dir:saved.dir,databaseUrl:restoreUrl.toString(),
      storageDir:path.join(dir,'restored-files'),passphrase,
    });
    if(restored.problems.length!==0) throw new Error('Restore verification failed');
    console.log('STAGING_BACKUP_DRILL PASS: encrypted backup + 14 migrations + 1 synthetic file + isolated restore + checksum parity');
  }finally{await sourcePool.end();}
}catch(error){
  // No credentials, document numbers, file keys or URLs in logs.
  console.error('STAGING_BACKUP_DRILL FAILED: '+String(error?.message||error).slice(0,200));
  process.exitCode=1;
}finally{
  for(const name of created.reverse()){
    try{await admin.query(`DROP DATABASE IF EXISTS ${pgIdentifier(name)} WITH (FORCE)`);}
    catch{console.error('STAGING_BACKUP_DRILL cleanup failed: temporary DB needs manual review');process.exitCode=1;}
  }
  await admin.end();
  if(dir) await rm(dir,{recursive:true,force:true});
}
