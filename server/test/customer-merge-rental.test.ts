import { describe,expect,it,vi } from 'vitest';
import { assertCustomerIdentityNotAliasedOrBlocked } from '../src/domain/customerAliases.js';
import type { Queryable } from '../src/db/pool.js';

function fakeDatabase(results:Array<{rows:unknown[];rowCount:number}>): Queryable {
  const query=vi.fn().mockImplementation(async()=>results.shift()??{rows:[],rowCount:0});
  return {query} as unknown as Queryable;
}
describe('linked customer rental protections',()=>{
  const id='11111111-2222-4333-8444-555555555555';
  it('refuses a source alias, preserving the canonical ID hint for staff',async()=>{
    await expect(assertCustomerIdentityNotAliasedOrBlocked(fakeDatabase([
      {rows:[{canonical_customer_id:'22222222-2222-4333-8444-555555555555'}],rowCount:1},
    ]),id)).rejects.toMatchObject({status:409,code:'customer_record_linked'});
  });
  it('prevents using a canonical record when an attached identity is blocked',async()=>{
    await expect(assertCustomerIdentityNotAliasedOrBlocked(fakeDatabase([
      {rows:[],rowCount:0},{rows:[{exists:1}],rowCount:1},
    ]),id)).rejects.toMatchObject({status:409,code:'customer_blocked'});
  });
  it('permits customer identity only if not aliased and none of its aliases are blocked',async()=>{
    await expect(assertCustomerIdentityNotAliasedOrBlocked(fakeDatabase([
      {rows:[],rowCount:0},{rows:[],rowCount:0},
    ]),id)).resolves.toBeUndefined();
  });
});
