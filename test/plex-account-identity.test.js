import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlexAccountLookup, createPlexIdentityLookup } from '../plex-account-identity.js';
test('verifies the authenticating account with its token and coalesces lookups', async () => {
  let calls=0;
  const lookup=createPlexAccountLookup({fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://plex.tv/api/v2/user');assert.equal(options.headers['X-Plex-Token'],'account-token');
    return Response.json({id:123,title:'Owner'});
  }});
  assert.deepEqual(await Promise.all([lookup('account-token'),lookup('account-token')]),['123','123']);assert.equal(calls,1);
  assert.equal(await lookup(null),null);
});
test('identity failures fail closed and can be retried',async()=>{
 let fail=true;
 const lookup=createPlexAccountLookup({fetchImpl:async()=>fail?new Response('',{status:401}):Response.json({id:456})});
 await assert.rejects(lookup('token'));fail=false;assert.equal(await lookup('token'),'456');
});
test('different accounts never share identity and cached identities expire',async()=>{
 let time=0,calls=0;
 const lookup=createPlexAccountLookup({now:()=>time,fetchImpl:async(_,options)=>{calls++;return Response.json({id:options.headers['X-Plex-Token']==='owner'?123:456});}});
 assert.equal(await lookup('owner'),'123');assert.equal(await lookup('other'),'456');time=300001;await lookup('owner');assert.equal(calls,3);
});
test('admin identity uses the email confirmed by Plex', async () => {
  const lookup = createPlexIdentityLookup({
    fetchImpl: async (_, options) => Response.json({
      id: 123, email: ' Admin@Example.Test ', confirmed: options.headers['X-Plex-Token'] === 'verified',
    }),
  });
  assert.deepEqual(await lookup('verified'), { id: '123', confirmedEmail: 'admin@example.test', username: '' });
  assert.deepEqual(await lookup('unverified'), { id: '123', confirmedEmail: null, username: '' });
});
