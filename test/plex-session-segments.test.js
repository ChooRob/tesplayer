import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlexSegment } from '../plex-session.js';

const realFetch = globalThis.fetch;
const reply = (status) => new Response(status === 200 ? 'x' : null, { status });
const options = (probe, extra = {}) => ({ headers: {}, probe, session: 's', budgetMs: 800, confirmExpiredMs: 150, retryDelaysMs: [0, 20], ...extra });

test('a segment that arrives after a few 404s is returned', async (t) => {
  let calls = 0;
  globalThis.fetch = async () => reply(++calls < 4 ? 404 : 200);
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await fetchPlexSegment('http://plex/x.ts', options(async () => 'alive'));
  assert.equal(result.response.status, 200);
  assert.equal(result.expired, false);
  assert.equal(calls, 4);
});

test('a session missing for a moment (a transcoder restarting after a seek) is not called expired', async (t) => {
  let calls = 0;
  const started = Date.now();
  globalThis.fetch = async () => reply(calls++ < 5 ? 404 : 200);
  t.after(() => { globalThis.fetch = realFetch; });
  // Missing from Plex's list for the first 60 ms, then back.
  const probe = async () => (Date.now() - started < 60 ? 'expired' : 'alive');
  const result = await fetchPlexSegment('http://plex/x.ts', options(probe));
  assert.equal(result.expired, false);
  assert.equal(result.response.status, 200);
});

test('a session that stays missing is expired', async (t) => {
  globalThis.fetch = async () => reply(404);
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await fetchPlexSegment('http://plex/x.ts', options(async () => 'expired'));
  assert.equal(result.expired, true);
  assert.equal(result.response, null);
});

test('a segment that never appears while the session lives ends as a 404 when the budget is spent', async (t) => {
  globalThis.fetch = async () => reply(404);
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await fetchPlexSegment('http://plex/x.ts', options(async () => 'alive', { budgetMs: 200 }));
  assert.equal(result.expired, false);
  assert.equal(result.response.status, 404);
});
