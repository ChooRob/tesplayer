import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForServer } from '../public/engine/server-wait.js';

const reply = status => ({ status, body: { cancel: async () => {} } });
const clock = () => { let time = 0; return { now: () => time, sleep: async ms => { time += ms; } }; };

test('it keeps waiting through refused connections and gateway errors, then reports up', async () => {
  const { now, sleep } = clock();
  const results = [() => { throw new TypeError('Failed to fetch'); }, () => reply(502), () => reply(503), () => reply(200)];
  let calls = 0;
  const fetchImpl = async () => results[calls++]();
  assert.equal(await waitForServer({ fetchImpl, now, sleep }), 'up');
  assert.equal(calls, 4);
});

test('a signed-out answer still means the server is up', async () => {
  const { now, sleep } = clock();
  assert.equal(await waitForServer({ fetchImpl: async () => reply(401), now, sleep }), 'up');
});

test('it gives up after the timeout and backs off to at most five seconds', async () => {
  const { now, sleep } = clock();
  const sleeps = [];
  const result = await waitForServer({
    fetchImpl: async () => reply(502), now, timeoutMs: 30000,
    sleep: async ms => { sleeps.push(ms); await sleep(ms); },
  });
  assert.equal(result, 'timeout');
  assert.deepEqual(sleeps.slice(0, 4), [1000, 1500, 2250, 3375]);
  assert.ok(Math.max(...sleeps) <= 5000);
});

test('it stops at once when the page is being left', async () => {
  let calls = 0;
  const result = await waitForServer({ fetchImpl: async () => { calls++; return reply(502); }, cancelled: () => calls >= 2, sleep: async () => {} });
  assert.equal(result, 'cancelled');
  assert.equal(calls, 2);
});

test('a slow answer is given the full attempt timeout before it counts as down', async () => {
  const { now, sleep } = clock();
  let signalTimeoutSeen = false;
  const fetchImpl = async (url, { signal }) => { signalTimeoutSeen = signal instanceof AbortSignal; return reply(200); };
  assert.equal(await waitForServer({ fetchImpl, now, sleep, attemptTimeoutMs: 12000 }), 'up');
  assert.ok(signalTimeoutSeen);
});
