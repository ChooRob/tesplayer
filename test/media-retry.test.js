import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetryingFetch, MEDIA_RETRY_BUDGET_MS, HLS_LOAD_POLICIES } from '../public/engine/media-retry.js';

// A fake clock: sleeping moves time on at once.
function clock() {
  let time = 0;
  const waits = [];
  return { waits, now: () => time, sleep: async (ms) => { waits.push(ms); time += ms; } };
}

const slow = (retryAfter = '1') => new Response('{"code":"MEDIA_SERVER_SLOW"}', { status: 503, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
const ok = () => new Response('#EXTM3U\n', { status: 200 });

function upstream(answers) {
  const calls = [];
  return {
    calls,
    fetchFn: async (resource, init) => {
      calls.push({ resource, init });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('a media server waking up is asked again until it answers', async () => {
  const time = clock();
  const server = upstream([slow(), slow(), ok()]);
  const waiting = [];
  const fetch = createRetryingFetch({ fetchFn: server.fetchFn, onWaiting: detail => waiting.push(detail), ...time });
  const response = await fetch('/proxy/index.m3u8');
  assert.equal(response.status, 200);
  assert.equal(server.calls.length, 3);
  assert.deepEqual(time.waits, [1000, 1000], 'Retry-After is followed');
  assert.deepEqual(waiting, [{ attempt: 1, status: 503 }, { attempt: 2, status: 503 }]);
});

test('without Retry-After the wait grows to at most 5 s', async () => {
  const time = clock();
  const server = upstream([...Array(6)].map(() => slow(null)).concat(ok()));
  const fetch = createRetryingFetch({ fetchFn: server.fetchFn, ...time });
  assert.equal((await fetch('/proxy/x')).status, 200);
  assert.deepEqual(time.waits, [1000, 1500, 2250, 3375, 5000, 5000]);
});

test('a gateway error or a dropped request is retried too', async () => {
  const time = clock();
  const server = upstream([new Response('', { status: 502 }), new TypeError('Failed to fetch'), new Response('', { status: 504 }), ok()]);
  const fetch = createRetryingFetch({ fetchFn: server.fetchFn, ...time });
  assert.equal((await fetch('/proxy/x')).status, 200);
  assert.equal(server.calls.length, 4);
});

test('after about a minute the last answer is given back, so the page can say playback failed', async () => {
  const time = clock();
  const answers = [...Array(100)].map(() => slow());
  const server = upstream(answers);
  const fetch = createRetryingFetch({ fetchFn: server.fetchFn, ...time });
  const response = await fetch('/proxy/x');
  assert.equal(response.status, 503);
  assert.ok(time.now() <= MEDIA_RETRY_BUDGET_MS);
  assert.ok(time.now() >= MEDIA_RETRY_BUDGET_MS - 5000);

  const failing = upstream([...Array(100)].map(() => new TypeError('Failed to fetch')));
  await assert.rejects(createRetryingFetch({ fetchFn: failing.fetchFn, ...clock() })('/proxy/x'), /Failed to fetch/);
});

test('answers that are not about waiting are given back at once', async () => {
  for (const status of [200, 206, 403, 404, 410, 500]) {
    const time = clock();
    const server = upstream([new Response('', { status })]);
    const response = await createRetryingFetch({ fetchFn: server.fetchFn, ...time })('/proxy/x');
    assert.equal(response.status, status);
    assert.equal(server.calls.length, 1);
  }
});

test('a request the player cancelled is not retried', async () => {
  const controller = new AbortController();
  controller.abort();
  const server = upstream([new DOMException('aborted', 'AbortError')]);
  await assert.rejects(createRetryingFetch({ fetchFn: server.fetchFn, ...clock() })('/proxy/x', { signal: controller.signal }), /aborted/);
  assert.equal(server.calls.length, 1);
});

test('the request is passed through unchanged', async () => {
  const server = upstream([ok()]);
  const init = { headers: { Range: 'bytes=0-' } };
  await createRetryingFetch({ fetchFn: server.fetchFn, ...clock() })('/proxy/x', init);
  assert.equal(server.calls[0].resource, '/proxy/x');
  assert.equal(server.calls[0].init, init);
});

test('Standard playback waits about as long through hls.js', () => {
  for (const policy of Object.values(HLS_LOAD_POLICIES)) {
    const { maxNumRetry, retryDelayMs, maxRetryDelayMs } = policy.default.errorRetry;
    let total = 0;
    for (let n = 0; n < maxNumRetry; n += 1) total += Math.min(retryDelayMs * 2 ** n, maxRetryDelayMs);
    assert.ok(total >= 45000 && total <= 65000, `about a minute of retries, got ${total} ms`);
  }
});
