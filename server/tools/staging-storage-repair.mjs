#!/usr/bin/env node
/** Isolated STAGING migration of synthetic uploads after /data/files -> /data switch.
 * Copy only checksum-verified missing files from the former subfolder, never delete,
 * overwrite, reassign, or change stored_files records.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const REQUIRED_PROJECT = '5985f4ff-7d6d-4c7b-954a-d773d166ae50';
const {DATABASE_URL,RAILWAY_PROJECT_ID,STORAGE_DIR,FLEETORA_STAGING_BACKUP_DRILL} = process.env;
if (RAILWAY_PROJECT_ID!==REQUIRED_PROJECT ||
    FLEETORA_STAGING_BACKUP_DRILL!=='synthetic-only' ||
    STORAGE_DIR!=='/data' || !DATABASE_URL ||
    !new URL(DATABASE_URL).hostname.endsWith('.railway.internal') ||
    new URL(DATABASE_URL).pathname!=='/railway') {
  console.error('STAGING_STORAGE_REPAIR refused outside synthetic staging project');
  process.exit(2);
}
const pool=new pg.Pool({connectionString:DATABASE_URL,max:1});
const digest=buf=>createHash('sha256').update(buf).digest('hex');
let moved=0;
let already=0;
let absent=0;
try {
  const data=(await pool.query('SELECT storage_key,sha256 FROM stored_files')).rows;
  for(const row of data){
    if(!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(row.storage_key) ||
       !/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error('Invalid stored file metadata');
    const canonical=path.join('/data',row.storage_key);
    try{
      const buf=await readFile(canonical);
      if(digest(buf)!==row.sha256) throw new Error('Canonical file checksum differs');
      already++;
      continue;
    }catch(e){
      if(e?.code!=='ENOENT') throw e;
    }
    const old=path.join('/data/files',row.storage_key);
    let content;
    try { content=await readFile(old); }
    catch(e) { if(e?.code==='ENOENT'){absent++;continue;} throw e; }
    if(digest(content)!==row.sha256) throw new Error('Old staging file checksum differs');
    await mkdir(path.dirname(canonical),{recursive:true});
    await copyFile(old,canonical,constants.COPYFILE_EXCL);
    if(digest(await readFile(canonical))!==row.sha256) throw new Error('Copied file checksum differs');
    moved++;
  }
  if(absent>0) throw new Error('Some staging-only files could not be located: '+absent);
  console.log('STAGING_STORAGE_REPAIR PASS verified='+already+' copied='+moved+' missing=0; original files preserved');
}catch(err){
  console.error('STAGING_STORAGE_REPAIR FAILED: '+String(err?.message||err).slice(0,180));
  process.exitCode=1;
}finally{
  await pool.end();
}
