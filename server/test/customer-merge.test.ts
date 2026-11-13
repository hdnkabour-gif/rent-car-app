import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createUser, CSRF, loginAgent, resetDatabase, setupTestApp, type TestContext } from './helpers.js';
import { nameSimilarity } from '../src/routes/customerMerge.js';

let ctx:TestContext; let manager:TestAgent; let employee:TestAgent; let source:string; let target:string; let another:string;
const create = (name:string,phone:string) => manager.post('/api/customers').set(CSRF).send({ fullName:name,phone });
beforeAll(async()=>{ctx=await setupTestApp();});
afterAll(async()=>{await ctx.pool.end();});
beforeEach(async()=>{
  await resetDatabase(ctx.pool);
  const m=await createUser(ctx.pool,{email:'merge-manager@example.test',role:'manager'});
  const e=await createUser(ctx.pool,{email:'merge-employee@example.test',role:'employee'});
  manager=await loginAgent(ctx.app,m.email,m.password);
  employee=await loginAgent(ctx.app,e.email,e.password);
  source=(await create('Mohamed El Idrissi','0600000021').expect(201)).body.customer.id;
  target=(await create('Mohamed El Idrissi','0600000021').expect(201)).body.customer.id;
  another=(await create('Mohammed El Idrissi','0600000022').expect(201)).body.customer.id;
});

describe('manager-controlled reversible customer links',()=>{
  it('flags matching names and shared numbers only as suggestions, never auto-merges',async()=>{
    expect(nameSimilarity('Mohamed El Idrissi','Mohamed El Idrissi')).toBe(1);
    expect(nameSimilarity('أحمد','احمد')).toBe(1);
    const c=(await manager.get(`/api/customer-merges/candidates/${source}`).expect(200)).body.items;
    expect(c.some((x:{id:string;reasons:string[]})=>x.id===target && x.reasons.includes('same_phone'))).toBe(true);
    expect((await ctx.pool.query('SELECT count(*)::int n FROM customer_merge_links')).rows[0].n).toBe(0);
    await employee.get(`/api/customer-merges/candidates/${source}`).expect(403);
  });

  it('links records only with manager confirmation and preserves all existing customers and historical FKs',async()=>{
    await manager.post('/api/customer-merges/links').set(CSRF).send({
      sourceId:source,canonicalId:target,reason:'Duplicate identity verified by manager',
      acknowledgeConflicts:true,confirmSourceName:'Wrong name',
    }).expect(409);
    const preview=(await manager.post('/api/customer-merges/preview').set(CSRF).send({sourceId:source,canonicalId:target}).expect(200)).body;
    expect(preview.historyCounts).toHaveLength(2);
    expect(preview.conflicts).toEqual([]);
    const merge=(await manager.post('/api/customer-merges/links').set(CSRF).send({
      sourceId:source,canonicalId:target,reason:'Duplicate identity verified by manager',
      acknowledgeConflicts:true,confirmSourceName:'Mohamed El Idrissi',
    }).expect(201)).body;
    expect(merge).toMatchObject({linked:true,historicalRecordsPreserved:true});
    const related=(await manager.get(`/api/customer-merges/related/${source}`).expect(200)).body;
    expect(related.canonicalId).toBe(target);
    expect(related.originalRecords).toHaveLength(2);
    await manager.post('/api/customer-merges/links').set(CSRF).send({
      sourceId:target,canonicalId:source,reason:'Try to create a cycle',
      acknowledgeConflicts:true,confirmSourceName:'Mohamed El Idrissi',
    }).expect(409);
    await manager.post('/api/customer-merges/links').set(CSRF).send({
      sourceId:another,canonicalId:source,reason:'Do not chain aliases',
      acknowledgeConflicts:true,confirmSourceName:'Mohammed El Idrissi',
    }).expect(409);
    expect((await ctx.pool.query('SELECT count(*)::int n FROM customers')).rows[0].n).toBe(3);
    await expect(ctx.pool.query('DELETE FROM customer_merge_links')).rejects.toThrow(/never be deleted/);
    await manager.post(`/api/customer-merges/links/${merge.id}/reverse`).set(CSRF).send({reason:'Identity mismatch found during review'}).expect(200);
    expect((await manager.get(`/api/customer-merges/related/${source}`).expect(200)).body.originalRecords).toHaveLength(1);
    const history=await ctx.pool.query('SELECT status,reverse_reason FROM customer_merge_links WHERE id=$1',[merge.id]);
    expect(history.rows[0]).toMatchObject({status:'reversed',reverse_reason:'Identity mismatch found during review'});
    await manager.post(`/api/customer-merges/links/${merge.id}/reverse`).set(CSRF).send({reason:'second reversal attempt'}).expect(404);
    const audits=await ctx.pool.query("SELECT action FROM audit_logs WHERE action IN ('customer.merge_linked','customer.merge_reversed') ORDER BY id");
    expect(audits.rows).toEqual([{action:'customer.merge_linked'},{action:'customer.merge_reversed'}]);
  });

  it('refuses merges involving a blocked customer so the do-not-rent flag cannot be bypassed',async()=>{
    await manager.post(`/api/customers/${source}/block`).set(CSRF).send({reason:'Safety review'}).expect(200);
    await manager.post('/api/customer-merges/links').set(CSRF).send({
      sourceId:source,canonicalId:target,reason:'Unsafe attempted merge',
      acknowledgeConflicts:true,confirmSourceName:'Mohamed El Idrissi',
    }).expect(409);
    expect((await ctx.pool.query('SELECT count(*)::int n FROM customer_merge_links')).rows[0].n).toBe(0);
  });
});
