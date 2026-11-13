import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Db, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { requirePermission } from '../auth/middleware.js';
import { AppError, forbidden, notFound } from '../http/errors.js';
import { parseBody, parseParams } from '../http/validate.js';
import { recordAudit, auditContext } from '../audit/audit.js';

const Uuid = z.object({ id: z.uuid() });
const Preview = z.object({ sourceId: z.uuid(), canonicalId: z.uuid() }).strict();
const Link = Preview.extend({
  reason: z.string().trim().min(10).max(1000),
  acknowledgeConflicts: z.literal(true),
  confirmSourceName: z.string().trim().min(2).max(160),
}).strict();
const Reverse = z.object({ reason: z.string().trim().min(10).max(1000) }).strict();

type C = { id: string; full_name: string; phone_key: string; id_doc_number_key: string | null;
  licence_number: string | null; birth_date: string | null; blocked_at: Date | null; customer_type: string };
const compare = (source: C, canonical: C) => {
  const differences: string[] = [];
  for (const [name, a, b] of [
    ['customer_type',source.customer_type,canonical.customer_type],
    ['birth_date',source.birth_date,canonical.birth_date],
    ['id_doc_number',source.id_doc_number_key,canonical.id_doc_number_key],
    ['licence_number',source.licence_number,canonical.licence_number],
    ['phone',source.phone_key,canonical.phone_key],
  ] as const) if (a && b && a !== b) differences.push(name);
  return differences;
};
const managerOnly: RequestHandler = (_req,res,next) => res.locals.auth?.user.role === 'manager'
  ? next() : next(forbidden('Only a manager can link or unlink customer records'));

/** Suggestions never make an identity decision. Similar names or shared numbers may belong to different people. */
export function normalizeCustomerName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه')
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').trim().replace(/\s+/g,' ');
}
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeCustomerName(a); const y = normalizeCustomerName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  let prev = Array.from({length:y.length+1},(_,i)=>i);
  for (let i=1;i<=x.length;i+=1) {
    const next = [i];
    for (let j=1;j<=y.length;j+=1) next[j] = Math.min(
      next[j-1]!+1, prev[j]!+1, prev[j-1]!+(x[i-1]===y[j-1]?0:1),
    );
    prev=next;
  }
  return 1-prev[y.length]!/Math.max(x.length,y.length);
}

async function getPair(tx: Queryable, sourceId: string, canonicalId: string, lock = false) {
  if (sourceId === canonicalId) throw new AppError(400,'same_customer','Choose two different customers');
  const {rows} = await tx.query<C>(
    `SELECT id,full_name,phone_key,id_doc_number_key,licence_number,birth_date::text,
            blocked_at,customer_type FROM customers WHERE id = ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [[sourceId,canonicalId]],
  );
  const source=rows.find(x=>x.id===sourceId);
  const canonical=rows.find(x=>x.id===canonicalId);
  if (!source || !canonical) throw notFound('Customer not found');
  return {source,canonical};
}

export function customerMergeRouter(db: Db): Router {
  const r = Router();
  r.use(requirePermission(db, 'customers.manage'), managerOnly);
  r.get('/candidates/:id', async (req,res) => {
    const {id}=parseParams(Uuid,req);
    const person=(await db.query<C>(
      `SELECT id,full_name,phone_key,id_doc_number_key,licence_number,birth_date::text,
      blocked_at,customer_type FROM customers WHERE id=$1`,[id],
    )).rows[0];
    if(!person) throw notFound('Customer not found');
    const {rows}=await db.query<C>(
      `SELECT id,full_name,phone_key,id_doc_number_key,licence_number,birth_date::text,
      blocked_at,customer_type FROM customers WHERE id<>$1 ORDER BY updated_at DESC LIMIT 2000`,[id],
    );
    const candidates=rows.map(c=>{
      const reasons:string[]=[];
      if(person.phone_key===c.phone_key) reasons.push('same_phone');
      if(person.id_doc_number_key && person.id_doc_number_key===c.id_doc_number_key) reasons.push('same_document');
      if(person.licence_number && person.licence_number===c.licence_number) reasons.push('same_licence');
      const score=nameSimilarity(person.full_name,c.full_name);
      if(score>=0.85) reasons.push('similar_name');
      return { id:c.id,fullName:c.full_name,reasons,nameScore:Math.round(score*100)/100 };
    }).filter(x=>x.reasons.length).sort((a,b)=>b.reasons.length-a.reasons.length||b.nameScore-a.nameScore).slice(0,30);
    res.json({ items:candidates, autoMerged:false, searchedLimit:2000 });
  });
  r.post('/preview', async (req,res) => {
    const b=parseBody(Preview,req);
    const {source,canonical}=await getPair(db,b.sourceId,b.canonicalId);
    const counts=await db.query<{ customer_id: string; reservations: number; contracts: number; documents: number }>(
      `SELECT c.id AS customer_id,
        (SELECT count(*)::int FROM reservations r WHERE r.customer_id=c.id) reservations,
        (SELECT count(*)::int FROM contracts k WHERE k.customer_id=c.id) contracts,
        (SELECT count(*)::int FROM customer_documents d WHERE d.customer_id=c.id) documents
       FROM customers c WHERE c.id=ANY($1::uuid[])`,[[b.sourceId,b.canonicalId]],
    );
    res.json({
      source:{id:source.id,fullName:source.full_name,blocked:Boolean(source.blocked_at)},
      canonical:{id:canonical.id,fullName:canonical.full_name,blocked:Boolean(canonical.blocked_at)},
      conflicts:compare(source,canonical),historyCounts:counts.rows,
      notice:'No data or historical foreign key is modified. Confirm only after examining both identities.',
    });
  });
  r.post('/links', async (req,res) => {
    const b=parseBody(Link,req);
    const auth=res.locals.auth!;
    const output=await withTransaction(db,async tx=>{
      const {source,canonical}=await getPair(tx,b.sourceId,b.canonicalId,true);
      if(source.full_name!==b.confirmSourceName) throw new AppError(409,'name_confirmation_failed','Confirm the exact source name');
      if(source.blocked_at || canonical.blocked_at) {
        throw new AppError(409,'blocked_customer','Resolve the do-not-rent restrictions separately before linking');
      }
      const edges=await tx.query(
        `SELECT 1 FROM customer_merge_links WHERE status='active'
           AND (source_customer_id=ANY($1::uuid[]) OR canonical_customer_id=$2) LIMIT 1`,
        [[b.sourceId,b.canonicalId],b.sourceId],
      );
      if(edges.rowCount) throw new AppError(409,'merge_conflict','One customer is already involved in an incompatible active link');
      const row=(await tx.query<{id:string}>(
        `INSERT INTO customer_merge_links (source_customer_id,canonical_customer_id,reason,linked_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [b.sourceId,b.canonicalId,b.reason,auth.user.id],
      )).rows[0]!;
      await recordAudit(tx,{
        ...auditContext(req,res),action:'customer.merge_linked',targetType:'customer_merge',targetId:row.id,
        metadata:{sourceId:b.sourceId,canonicalId:b.canonicalId,conflictingFields:compare(source,canonical)},
      });
      return row;
    });
    res.status(201).json({ id:output.id, linked:true, historicalRecordsPreserved:true });
  });
  r.get('/links', async (_req,res) => {
    const rows=await db.query(
      `SELECT m.id,m.source_customer_id,m.canonical_customer_id,m.status,m.reason,m.linked_at,m.reversed_at,
        s.full_name AS source_name,c.full_name AS canonical_name
       FROM customer_merge_links m JOIN customers s ON s.id=m.source_customer_id
       JOIN customers c ON c.id=m.canonical_customer_id ORDER BY m.linked_at DESC LIMIT 200`,
    );
    res.json({items:rows.rows});
  });
  r.get('/related/:id',async(req,res)=>{
    const {id}=parseParams(Uuid,req);
    const linked=await db.query<{source_customer_id:string;canonical_customer_id:string}>(
      `SELECT source_customer_id,canonical_customer_id FROM customer_merge_links WHERE status='active'
        AND (source_customer_id=$1 OR canonical_customer_id=$1)`,[id],
    );
    const canonicalId=linked.rows.find(x=>x.source_customer_id===id)?.canonical_customer_id??id;
    const aliases=await db.query<{source_customer_id:string}>(
      `SELECT source_customer_id FROM customer_merge_links WHERE status='active' AND canonical_customer_id=$1`,
      [canonicalId],
    );
    const uniqueIds=[...new Set([canonicalId,...aliases.rows.map(x=>x.source_customer_id)])];
    const counts=await db.query(
      `SELECT c.id,c.full_name, (SELECT count(*)::int FROM reservations r WHERE r.customer_id=c.id) reservations,
         (SELECT count(*)::int FROM contracts k WHERE k.customer_id=c.id) contracts
       FROM customers c WHERE c.id=ANY($1::uuid[])`,[uniqueIds],
    );
    res.json({ canonicalId, originalRecords:counts.rows, historicalForeignKeysChanged:false });
  });
  r.post('/links/:id/reverse',async(req,res)=>{
    const {id}=parseParams(Uuid,req);
    const {reason}=parseBody(Reverse,req);
    const auth=res.locals.auth!;
    await withTransaction(db,async tx=>{
      const rows=await tx.query(
        `UPDATE customer_merge_links SET status='reversed',reversed_by=$2,reversed_at=now(),reverse_reason=$3
           WHERE id=$1 AND status='active' RETURNING source_customer_id,canonical_customer_id`,
        [id,auth.user.id,reason],
      );
      if(!rows.rowCount) throw notFound('Active merge link not found');
      await recordAudit(tx,{
        ...auditContext(req,res),action:'customer.merge_reversed',targetType:'customer_merge',targetId:id,
        metadata:{sourceId:rows.rows[0].source_customer_id,canonicalId:rows.rows[0].canonical_customer_id,reason},
      });
    });
    res.json({reversed:true,historicalRecordsPreserved:true});
  });
  return r;
}
