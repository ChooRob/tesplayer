import test from 'node:test';
import assert from 'node:assert/strict';
import {createQuotaGuard} from '../public/engine/quota-guard.js';
test('an exhausted account receives the quota message before media loading',async()=>{
 let message;
 const guard=createQuotaGuard({fetcher:async()=>Response.json({quota:{remainingSeconds:0,resetAt:'next-week'}}),onExceeded:value=>message=value});
 assert.equal(await guard(),true);assert.equal(message,'next-week');
});
test('a generic media-loader error still produces the quota message when the allowance ran out',async()=>{
 let shown=false;
 const guard=createQuotaGuard({fetcher:async()=>Response.json({quota:{remainingSeconds:0}}),onExceeded:()=>shown=true});
 assert.equal(await guard(Error('Unable to load media')),true);assert.equal(shown,true);
});
test('structured quota errors are displayed without another request',async()=>{
 let reset;
 const guard=createQuotaGuard({fetcher:()=>{throw Error('must not fetch');},onExceeded:value=>reset=value});
 assert.equal(await guard({code:'QUOTA_EXCEEDED',resetAt:'next-week'}),true);assert.equal(reset,'next-week');
});
test('an account stream conflict produces the playback limit message', async () => {
  let shown = 0;
  const guard = createQuotaGuard({
    fetcher: async () => Response.json({ quota: null, accountStreamInUse: true }),
    onExceeded: () => assert.fail('unexpected quota banner'),
    onStreamLimit: () => shown++,
  });
  assert.equal(await guard(), true);
  assert.equal(await guard({ code: 'ACCOUNT_STREAM_LIMIT' }), true);
  assert.equal(shown, 2);
});
test('unlimited accounts, remaining time and network errors do not produce a false quota message',async()=>{
 for(const body of [{quota:null},{quota:{remainingSeconds:10}}]){
  const guard=createQuotaGuard({fetcher:async()=>Response.json(body),onExceeded:()=>assert.fail('unexpected quota banner')});
  assert.equal(await guard(),false);
 }
 const guard=createQuotaGuard({fetcher:async()=>{throw Error('offline');},onExceeded:()=>assert.fail()});assert.equal(await guard(),false);
});
