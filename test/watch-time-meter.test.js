import test from 'node:test';
import assert from 'node:assert/strict';
import {createWatchTimeMeter} from '../watch-time-meter.js';
function fixture(limit=30,streamLimit) {
 let time=0,used=0,cutoffs=0;
 const meter=createWatchTimeMeter({now:()=>time,recordUsage:async(_,seconds)=>{used+=seconds;},getQuotaStatus:async()=>({remainingSeconds:Math.max(0,limit-used),resetAt:'next-week'}),...(streamLimit===undefined?{}:{getStreamLimit:async()=>streamLimit})});
 const begin=()=>meter.begin({viewer:'viewer',accountKey:'account',playbackId:'player',onExhausted:async()=>cutoffs++});
 return {meter,begin,advance:ms=>time+=ms,get used(){return used;},get cutoffs(){return cutoffs;}};
}
test('server elapsed time charges a live stream and stops it at the limit',async()=>{
 const f=fixture(12);await f.begin();await f.meter.heartbeat('viewer','player','playing');
 f.advance(10000);await f.meter.tick();assert.equal(f.used,10);
 f.advance(2000);await f.meter.tick();assert.equal(f.cutoffs,1);
 const result=await f.meter.heartbeat('viewer','player','playing');assert.equal(result.exhausted,true);assert.equal(result.quota.remainingSeconds,0);
 await f.meter.tick();assert.equal(f.cutoffs,1);
});
test('pauses and buffering do not consume watch time',async()=>{
 const f=fixture();await f.begin();await f.meter.heartbeat('viewer','player','playing');
 f.advance(5000);await f.meter.heartbeat('viewer','player','paused');
 for(let i=0;i<6;i++){f.advance(10000);await f.meter.heartbeat('viewer','player','paused');}assert.equal(f.used,5);
 await f.meter.heartbeat('viewer','player','playing');f.advance(3000);await f.meter.tick();assert.equal(f.used,8);
});
test('a disconnected player expires its playing lease and cannot run the meter forever',async()=>{
 const f=fixture(1000);await f.begin();await f.meter.heartbeat('viewer','player','playing');f.advance(60000);await f.meter.tick();assert.equal(f.used,25);f.advance(60000);await f.meter.tick();assert.equal(f.used,25);
});
test('old page heartbeats cannot pause or charge the replacement player',async()=>{
 const f=fixture();await f.begin();await f.meter.heartbeat('viewer','player','playing');f.advance(5000);
 await f.meter.begin({viewer:'viewer',accountKey:'account',playbackId:'new-player'});
 assert.deepEqual(await f.meter.heartbeat('viewer','player','stopped'), {stale:true,replaced:true});assert.equal(f.used,5);
 await f.meter.heartbeat('viewer','new-player','playing');f.advance(5000);await f.meter.tick();assert.equal(f.used,10);
});

test('an early heartbeat from a new player is not a stream-limit conflict', async () => {
  const f = fixture();
  await f.begin();
  await f.meter.heartbeat('viewer', 'player', 'stopped');
  assert.deepEqual(await f.meter.heartbeat('viewer', 'incoming-player', 'paused'), { stale: true, replaced: false });
  await f.meter.begin({ viewer: 'viewer', accountKey: 'account', playbackId: 'incoming-player' });
  assert.equal((await f.meter.heartbeat('viewer', 'incoming-player', 'playing')).stale, undefined);
  assert.equal((await f.meter.heartbeat('viewer', 'player', 'paused')).replaced, true);
});

test('streams per account are unlimited without a stream-limit plugin', async () => {
  const f = fixture();
  await f.begin();
  for (const viewer of ['second-login', 'third-login']) await f.meter.begin({ viewer, accountKey: 'account', playbackId: viewer });
  assert.equal(await f.meter.atStreamLimit('fourth-login', 'account'), false);
});

test('a non-positive or missing plugin limit is treated as unlimited', async () => {
  for (const limit of [null, 0, -1, 1.5, 'one']) {
    const f = fixture(30, limit);
    await f.begin();
    await f.meter.begin({ viewer: 'second-login', accountKey: 'account', playbackId: 'second' });
  }
});

test('a plugin limit of two admits two logins per account and rejects a third', async () => {
  const f = fixture(30, 2);
  await f.begin();
  await f.meter.begin({ viewer: 'second-login', accountKey: 'account', playbackId: 'second' });
  assert.equal(await f.meter.atStreamLimit('third-login', 'account'), true);
  assert.equal(await f.meter.atStreamLimit('viewer', 'account'), false);
  await assert.rejects(f.meter.begin({ viewer: 'third-login', accountKey: 'account', playbackId: 'third' }), { code: 'ACCOUNT_STREAM_LIMIT' });
});

test('a plugin limit of one lets only one login reserve a stream per account, while other accounts can start', async () => {
  const f = fixture(30, 1);
  const other = { viewer: 'second-login', accountKey: 'account', playbackId: 'second-player' };
  const [first, second] = await Promise.allSettled([f.begin(), f.meter.begin(other)]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.reason.code, 'ACCOUNT_STREAM_LIMIT');
  await f.meter.begin({ ...other, viewer: 'other-account', accountKey: 'another-account' });
  await f.meter.heartbeat('viewer', 'player', 'stopped');
  await f.meter.begin(other);
  assert.equal(await f.meter.atStreamLimit('viewer', 'account'), true);
  assert.equal((await f.meter.heartbeat('viewer', 'player', 'playing')).stale, true);
});
test('concurrent accounting ticks never double-charge elapsed time',async()=>{
 const f=fixture();await f.begin();await f.meter.heartbeat('viewer','player','playing');f.advance(5000);await Promise.all([f.meter.tick(),f.meter.tick()]);assert.equal(f.used,5);
});

test('a stream with missing heartbeats is stopped rather than becoming unmetered',async()=>{
 let time=0,stopped=0;
 const meter=createWatchTimeMeter({now:()=>time,recordUsage:()=>{},getQuotaStatus:()=>({remainingSeconds:100})});
 await meter.begin({viewer:'v',accountKey:'a',playbackId:'id',onExpired:()=>stopped++});
 await meter.heartbeat('v','id','playing');
 time=26000;await meter.tick();assert.equal(stopped,1);assert.equal((await meter.heartbeat('v','id','playing')).expired,true);
 await meter.tick();assert.equal(stopped,1);
});

test('a slow-loading player is not stopped before its first heartbeat', async () => {
  let time = 0, stopped = 0;
  const meter = createWatchTimeMeter({ now: () => time, recordUsage: () => {}, getQuotaStatus: () => ({ remainingSeconds: 100 }) });
  await meter.begin({ viewer: 'v', accountKey: 'a', playbackId: 'id', onExpired: () => stopped++ });
  // Loading took 40 s: past the 25 s lease, inside the startup grace.
  time = 40000; await meter.tick();
  assert.equal(stopped, 0);
  assert.equal((await meter.heartbeat('v', 'id', 'playing')).expired, false);
  // After the first heartbeat the ordinary lease applies again.
  time = 40000 + 26000; await meter.tick();
  assert.equal(stopped, 1);
});

test('a player that never loads is still stopped once the startup grace runs out', async () => {
  let time = 0, stopped = 0;
  const meter = createWatchTimeMeter({ now: () => time, recordUsage: () => {}, getQuotaStatus: () => ({ remainingSeconds: 100 }) });
  await meter.begin({ viewer: 'v', accountKey: 'a', playbackId: 'id', onExpired: () => stopped++ });
  time = 89000; await meter.tick();
  assert.equal(stopped, 0);
  time = 91000; await meter.tick();
  assert.equal(stopped, 1);
});

test('a loading player holds its stream slot during the startup grace', async () => {
  let time = 0;
  const meter = createWatchTimeMeter({ now: () => time, recordUsage: () => {}, getQuotaStatus: () => ({ remainingSeconds: 100 }), getStreamLimit: () => 1 });
  await meter.begin({ viewer: 'first', accountKey: 'a', playbackId: 'one' });
  time = 40000;
  await assert.rejects(meter.begin({ viewer: 'second', accountKey: 'a', playbackId: 'two' }), { code: 'ACCOUNT_STREAM_LIMIT' });
});
test('activeStreams lists only streams that are playing right now, by account', async () => {
  let time = 0;
  const meter = createWatchTimeMeter({ now: () => time, recordUsage: async () => {}, getQuotaStatus: async () => ({ remainingSeconds: 1000 }) });
  const start = (viewer, accountKey) => meter.begin({ viewer, accountKey, playbackId: `p-${viewer}` });
  await start('a', 'plex:1'); await start('b', 'jellyfin:x:y'); await start('c', 'plex:2');
  assert.deepEqual(meter.activeStreams(), [], 'a stream that has not reported playing is not counted');
  await meter.heartbeat('a', 'p-a', 'playing');
  await meter.heartbeat('b', 'p-b', 'playing');
  await meter.heartbeat('c', 'p-c', 'paused');
  assert.deepEqual(meter.activeStreams().map(stream => stream.accountKey).sort(), ['jellyfin:x:y', 'plex:1']);
  assert.deepEqual(Object.keys(meter.activeStreams()[0]), ['accountKey'], 'nothing but the key is exposed');
  await meter.heartbeat('a', 'p-a', 'stopped');
  assert.deepEqual(meter.activeStreams().map(stream => stream.accountKey), ['jellyfin:x:y']);
  time += 60000;
  assert.deepEqual(meter.activeStreams(), [], 'a stream whose heartbeats stopped is no longer counted');
});

test('usage says whether the time was music or video, and a playback is video until the media server says otherwise', async () => {
  let time = 0;
  const recorded = [];
  const meter = createWatchTimeMeter({ now: () => time, recordUsage: async (key, seconds, detail) => { recorded.push([key, seconds, detail]); }, getQuotaStatus: async () => ({ remainingSeconds: 1000 }) });
  await meter.begin({ viewer: 'v', accountKey: 'plex:1', playbackId: 'movie' });
  await meter.heartbeat('v', 'movie', 'playing');
  time += 4000; await meter.tick();
  await meter.begin({ viewer: 'v', accountKey: 'plex:1', playbackId: 'song' });
  meter.setKind('v', 'song', 'music');
  await meter.heartbeat('v', 'song', 'playing');
  time += 6000; await meter.tick();
  assert.deepEqual(recorded, [['plex:1', 4, { kind: 'video' }], ['plex:1', 6, { kind: 'music' }]]);
});

test('a stale or unknown playback cannot change what a stream is counted as', async () => {
  let time = 0;
  const recorded = [];
  const meter = createWatchTimeMeter({ now: () => time, recordUsage: async (key, seconds, detail) => { recorded.push(detail.kind); }, getQuotaStatus: async () => ({ remainingSeconds: 1000 }) });
  await meter.begin({ viewer: 'v', accountKey: 'a', playbackId: 'new' });
  meter.setKind('v', 'old-id', 'music');
  meter.setKind('nobody', 'new', 'music');
  await meter.heartbeat('v', 'new', 'playing');
  time += 3000; await meter.tick();
  assert.deepEqual(recorded, ['video']);
});
