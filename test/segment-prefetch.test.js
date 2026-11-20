import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentPrefetcher, parseMediaPlaylist } from '../public/engine/segment-prefetch.js';

const BASE = 'https://player.example/proxy/video/session/abc/base/';
const playlist = (count, duration = 8) => '#EXTM3U\n#EXT-X-TARGETDURATION:8\n'
  + Array.from({ length: count }, (_, i) => `#EXTINF:${duration}.000,\n${String(i).padStart(5, '0')}.ts?x=1`).join('\n')
  + '\n#EXT-X-ENDLIST\n';
const segmentUrl = i => `${BASE}${String(i).padStart(5, '0')}.ts?x=1`;
const settle = () => new Promise(resolve => setImmediate(resolve));

// A fake network: each request stays pending until the test releases it.
function network() {
  const requests = [];
  const fetchFn = (resource, init = {}) => {
    const url = typeof resource === 'string' ? resource : resource.url;
    if (url.endsWith('index.m3u8')) {
      return Promise.resolve(new Response(playlist(40), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
    }
    let release;
    const promise = new Promise((resolve, reject) => {
      release = (bytes = 100) => resolve(new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'video/mp2t' } }));
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    requests.push({ url, init, release, promise });
    return promise;
  };
  const pending = () => requests.filter(r => !r.released).map(r => r.url).sort();
  const release = (url, bytes) => { const r = requests.find(x => x.url === url && !x.released); r.released = true; r.release(bytes); };
  return { fetchFn, requests, pending, release };
}

async function serve(net, prefetcher, i) {
  const pending = prefetcher.fetch(segmentUrl(i));
  net.release(segmentUrl(i));
  return pending;
}

async function started(readAheadSeconds = 32, options = {}) {
  const net = network();
  const prefetcher = new SegmentPrefetcher({ readAheadSeconds, fetchFn: net.fetchFn, ...options });
  await prefetcher.fetch(`${BASE}index.m3u8`);
  prefetcher.activate();
  return { net, prefetcher };
}

test('nothing is read ahead while the player opens the stream, then it starts from the resume point', async () => {
  const net = network();
  const prefetcher = new SegmentPrefetcher({ readAheadSeconds: 16, fetchFn: net.fetchFn });
  await prefetcher.fetch(`${BASE}index.m3u8`);
  // Opening the stream reads segment 0 for track information.
  await serve(net, prefetcher, 0);
  await settle();
  assert.deepEqual(net.pending(), [], 'no read-ahead next to the probe');

  prefetcher.activate();
  const resumed = prefetcher.fetch(segmentUrl(30));
  assert.deepEqual(net.pending(), [segmentUrl(30), segmentUrl(31), segmentUrl(32)].sort());
  net.release(segmentUrl(30));
  await resumed;
  prefetcher.dispose();
});

test('a slow download that keeps receiving data is kept; one that stops is abandoned', async () => {
  let trickle;
  const prefetcher = new SegmentPrefetcher({
    readAheadSeconds: 8, parallelism: 1, stallTimeoutMs: 40,
    fetchFn: async (resource, init = {}) => {
      const url = typeof resource === 'string' ? resource : resource.url;
      if (url.endsWith('.m3u8')) return new Response(playlist(5), { headers: { 'Content-Type': 'application/x-mpegurl' } });
      if (url === segmentUrl(0)) return new Response(new Uint8Array(1));
      const body = new ReadableStream({ start(controller) { trickle = controller; } });
      init.signal?.addEventListener('abort', () => trickle.error(init.signal.reason));
      return new Response(body, { headers: { 'Content-Type': 'video/mp2t' } });
    },
  });
  await prefetcher.fetch(`${BASE}index.m3u8`);
  prefetcher.activate();
  await prefetcher.fetch(segmentUrl(0));
  // 100 ms in total, but never more than 25 ms without data.
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    trickle.enqueue(new Uint8Array(10));
  }
  trickle.close();
  const served = await prefetcher.fetch(segmentUrl(1));
  assert.equal((await served.arrayBuffer()).byteLength, 40);

  // Segment 2 starts reading ahead now and never sends anything.
  await settle();
  const entry = prefetcher.entries.get(2);
  assert.ok(entry, 'segment 2 is being read ahead');
  // The stall timer doesn't hold the process open, so keep it alive here.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(entry.promise, /stalled/);
  clearTimeout(keepAlive);
  prefetcher.dispose();
});

test('parses segment URLs and durations relative to the playlist', () => {
  const segments = parseMediaPlaylist('#EXTM3U\n#EXTINF:8.008,\n00000.ts\n#EXTINF:4,\nhttps://cdn.example/1.ts\n#EXT-X-ENDLIST', BASE + 'index.m3u8');
  assert.deepEqual(segments, [
    { url: BASE + '00000.ts', duration: 8.008 },
    { url: 'https://cdn.example/1.ts', duration: 4 },
  ]);
  assert.deepEqual(parseMediaPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nbase/index.m3u8', BASE), []);
});

test('downloads ahead two at a time and serves the player from memory', async () => {
  const { net, prefetcher } = await started(32);
  const first = prefetcher.fetch(segmentUrl(0), { headers: { Range: 'bytes=0-' } });
  // The requested segment plus two read-ahead requests run in parallel.
  assert.deepEqual(net.pending(), [segmentUrl(0), segmentUrl(1), segmentUrl(2)].sort());
  net.release(segmentUrl(0));
  await first;
  net.release(segmentUrl(1), 500);
  await settle();
  assert.deepEqual(net.pending(), [segmentUrl(2), segmentUrl(3)].sort());

  const before = net.requests.length;
  const served = await prefetcher.fetch(segmentUrl(1), { headers: { Range: 'bytes=0-' } });
  assert.equal(served.status, 200);
  assert.equal((await served.arrayBuffer()).byteLength, 500);
  assert.equal(net.requests.length, before, 'segment 1 is not downloaded twice');
  assert.equal(net.requests.filter(r => r.url === segmentUrl(1)).length, 1);
});

test('a segment still downloading is awaited rather than requested twice', async () => {
  const { net, prefetcher } = await started(32);
  await serve(net, prefetcher, 0);
  const waiting = prefetcher.fetch(segmentUrl(1));
  await settle();
  assert.equal(net.requests.filter(r => r.url === segmentUrl(1)).length, 1);
  net.release(segmentUrl(1), 42);
  assert.equal((await (await waiting).arrayBuffer()).byteLength, 42);
});

test('read-ahead stops at the time window and the memory cap', async () => {
  const { net, prefetcher } = await started(16);
  await serve(net, prefetcher, 0);
  net.release(segmentUrl(1));
  net.release(segmentUrl(2));
  await settle(); await settle();
  assert.deepEqual(net.pending(), [], 'two 8-second segments fill a 16-second window');

  const capped = await started(600, { maxBytes: 250 });
  await serve(capped.net, capped.prefetcher, 0);
  capped.net.release(segmentUrl(1), 300);
  capped.net.release(segmentUrl(2), 200);
  await settle(); await settle();
  assert.deepEqual(capped.net.pending(), [], 'nothing new starts once held bytes reach the 250-byte cap');
});

test('a seek drops read-ahead outside the new window', async () => {
  const { net, prefetcher } = await started(16);
  await serve(net, prefetcher, 0);
  const seek = prefetcher.fetch(segmentUrl(20));
  await settle();
  const aborted = net.requests.filter(r => r.url === segmentUrl(1) || r.url === segmentUrl(2));
  await Promise.all(aborted.map(r => assert.rejects(r.promise, /Aborted/)));
  assert.deepEqual(net.pending().filter(u => !aborted.some(r => r.url === u)), [segmentUrl(20)],
    'only the segment asked for goes out while the media server catches up with the seek');
  net.release(segmentUrl(20));
  await seek;
  await settle();
  assert.deepEqual(net.pending().filter(u => !aborted.some(r => r.url === u)), [segmentUrl(21), segmentUrl(22)].sort(), 'read-ahead resumes once it has arrived');
});

test('a failed segment is asked for again, so a seek is not an error while the server catches up', async () => {
  let calls = 0;
  const fetchFn = (resource) => {
    const url = typeof resource === 'string' ? resource : resource.url;
    if (url.endsWith('index.m3u8')) return Promise.resolve(new Response(playlist(40), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
    calls += 1;
    return Promise.resolve(calls <= 2 ? new Response('nope', { status: 500 }) : new Response(new Uint8Array(10), { status: 200 }));
  };
  const prefetcher = new SegmentPrefetcher({ readAheadSeconds: 0, fetchFn, retryDelayMs: 1 });
  await prefetcher.fetch(`${BASE}index.m3u8`);
  const response = await prefetcher.fetch(segmentUrl(5));
  assert.equal(response.status, 200);
  assert.equal(calls, 3, 'two failures, then the segment');
  prefetcher.dispose();
});

test('a segment that keeps failing is given up on, and not-found is not retried', async () => {
  let calls = 0;
  const failWith = (status) => (resource) => {
    const url = typeof resource === 'string' ? resource : resource.url;
    if (url.endsWith('index.m3u8')) return Promise.resolve(new Response(playlist(40), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
    calls += 1;
    return Promise.resolve(new Response('x', { status }));
  };
  const broken = new SegmentPrefetcher({ readAheadSeconds: 0, fetchFn: failWith(500), retryDelayMs: 1 });
  await broken.fetch(`${BASE}index.m3u8`);
  assert.equal((await broken.fetch(segmentUrl(5))).status, 500);
  assert.equal(calls, 4, 'the first request and three more');
  calls = 0;
  const missing = new SegmentPrefetcher({ readAheadSeconds: 0, fetchFn: failWith(404), retryDelayMs: 1 });
  await missing.fetch(`${BASE}index.m3u8`);
  assert.equal((await missing.fetch(segmentUrl(5))).status, 404);
  assert.equal(calls, 1);
});

test('a mid-segment resume, unknown URLs and failures go to the network', async () => {
  const { net, prefetcher } = await started(16);
  await serve(net, prefetcher, 0);
  net.release(segmentUrl(1));
  await settle();
  const resumed = prefetcher.fetch(segmentUrl(1), { headers: { Range: 'bytes=50-' } });
  await settle();
  assert.equal(net.requests.filter(r => r.url === segmentUrl(1)).length, 2);
  net.release(segmentUrl(1));
  await resumed;

  const failing = new SegmentPrefetcher({
    readAheadSeconds: 16,
    fetchFn: async (resource) => {
      const url = typeof resource === 'string' ? resource : resource.url;
      if (url.endsWith('.m3u8')) return new Response(playlist(5), { headers: { 'Content-Type': 'application/x-mpegurl' } });
      return new Response('nope', { status: 503 });
    },
  });
  await failing.fetch(`${BASE}index.m3u8`);
  await failing.fetch(segmentUrl(0));
  await settle();
  const fallback = await failing.fetch(segmentUrl(1));
  assert.equal(fallback.status, 503, 'the player sees the real response, not a cached failure');
  failing.dispose();
});

test('it says when everything to the end of the stream has been downloaded', async () => {
  const { net, prefetcher } = await started(8 * 40);
  assert.equal(prefetcher.hasAllAhead(), false, 'nothing is held before playback starts');
  await serve(net, prefetcher, 36); // 37, 38 and 39 are the rest of a 40-segment stream
  await settle();
  assert.equal(prefetcher.hasAllAhead(), false, 'they are still being downloaded');
  for (let round = 0; round < 6 && net.pending().length; round++) {
    for (const url of net.pending()) net.release(url);
    await settle();
  }
  assert.equal(prefetcher.hasAllAhead(), true, 'all of them are held');
  prefetcher.dispose();
  assert.equal(prefetcher.hasAllAhead(), false, 'and not once it has been let go');
});
