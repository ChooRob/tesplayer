import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStartupQuality } from '../public/engine/startup-quality.js';

const headers = { 'X-Playback-Bitrates': '4000,2000,1000' };

test('selects the highest tier with room for audio and bandwidth swings', async () => {
  for (const [kbps, quality] of [[7000, 'high'], [6000, 'medium'], [3000, 'low'], [500, 'low']]) {
    let time = 0;
    const fetcher = async () => {
      time = 1000;
      return new Response(new Uint8Array(kbps * 125), { headers });
    };
    assert.equal(await measureStartupQuality({ fetcher, now: () => time }), quality);
  }
});

test('uses bytes received by the deadline and aborts a slow download', async () => {
  let time = 0;
  let aborted = false;
  const fetcher = async (_url, { signal }) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array(500_000));
      signal.addEventListener('abort', () => {
        aborted = true;
        time = 1000;
        stream.error(new Error('aborted'));
      });
    },
  }), { headers });
  assert.equal(await measureStartupQuality({ fetcher, timeoutMs: 20, now: () => time }), 'medium');
  assert.equal(aborted, true);
});

test('keeps the default quality when the probe endpoint is unavailable', async () => {
  assert.equal(await measureStartupQuality({ fetcher: async () => new Response(null, { status: 429 }) }), 'high');
  assert.equal(await measureStartupQuality({ fetcher: async () => new Response('missing bitrate data') }), 'high');
});

test('a server start cap of low skips the speed sample', async () => {
  let response;
  const fetcher = async () => {
    response = new Response(new Uint8Array(1000), { headers: { ...headers, 'X-Playback-Start-Cap': 'low' } });
    return response;
  };
  assert.equal(await measureStartupQuality({ fetcher }), 'low');
  assert.equal(response.bodyUsed, false);
  assert.equal(response.body.locked, false);
});
