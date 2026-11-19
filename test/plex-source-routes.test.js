import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCookieSealer } from '../session-cookie.js';

// Drive the real server through the Plex source end to end: sign-in,
// browsing, playback, the media proxy, watch state and the account key
// handed to limit plugins. Plex and plex.tv are mocked; nothing leaves the process.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-source-test-'));
const SECRET = 'test-only-secret-with-at-least-32-characters';
const pluginPath = path.join(temporary, 'limits-plugin.js');
writeFileSync(pluginPath, `
export default {
  getQuotaStatus(key) {
    globalThis.__limitKeys.push(['quota', key]);
    return { remainingSeconds: 3600, resetAt: '2026-11-16T00:00:00.000Z', internalLedger: 'kept on the server',
      breakdown: [{ label: 'Allowance', seconds: 3000 }, { label: '', seconds: 5 }, { label: 'No seconds' }] };
  },
  getAccountKey(session, key) {
    globalThis.__limitKeys.push(['account', session.sourceType, session.accountId, key, typeof session.accountToken]);
    return key;
  },
  registerRoutes(_app, context) { globalThis.__accounts = context.accounts; },
};
`);
globalThis.__limitKeys = [];
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: SECRET,
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: 'owner@example.test',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '',
  FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href,
  // With the admin area configured, sign-ins are recorded for account search.
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: 'a'.repeat(64),
});

const originalFetch = globalThis.fetch;
const calls = [];
let pinSequence = 500;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  calls.push({ url, options });
  const json = body => Response.json(body);
  const p = url.pathname;
  if (p === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (p === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (p === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(p)) return json({ authToken: 'test-account-token' });
  if (p === '/api/v2/home/users') return json({ users: [{ id: 10, title: 'Owner', admin: true }] });
  if (p === '/api/v2/user') return json({ id: 1, username: 'Owner', email: 'Owner@Example.test', confirmed: true });
  if (p === '/api/v2/resources') return json([{ clientIdentifier: 'test-server', provides: 'server', owned: true, accessToken: 'test-server-token' }]);
  if (p === '/accounts') return json({ MediaContainer: { Account: [{ id: 1, name: 'Owner' }] } });
  if (p === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } });
  if (p === '/library/metadata/5') return json({ MediaContainer: { Metadata: [{ ratingKey: '5', type: 'movie', title: 'Test Movie', year: 2020, duration: 100000, thumb: '/library/metadata/5/thumb/1' }] } });
  if (p === '/video/:/transcode/universal/decision') return json({ MediaContainer: {} });
  if (p === '/video/:/transcode/universal/start.m3u8') {
    const session = url.searchParams.get('session');
    return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nsession/${session}/base/index.m3u8\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (/^\/video\/:\/transcode\/universal\/session\/[^/]+\/base\/index\.m3u8$/.test(p)) {
    return new Response('#EXTM3U\n#EXTINF:8.0,\n00000.ts\n#EXT-X-ENDLIST\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (/^\/video\/:\/transcode\/universal\/session\/[^/]+\/base\/00000\.ts$/.test(p)) {
    return new Response(new Uint8Array(188), { headers: { 'Content-Type': 'video/mp2t' } });
  }
  if (p === '/video/:/transcode/universal/stop') return new Response('');
  if (p === '/:/progress' || p === '/:/scrobble' || p === '/:/unscrobble') return new Response('');
  if (p === '/photo/:/transcode') return new Response(new Uint8Array(10), { headers: { 'Content-Type': 'image/jpeg' } });
  throw new Error(`Unexpected mocked upstream request: ${p}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { method = 'GET', body, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    const payload = body === undefined ? null : JSON.stringify(body);
    req.headers = { host: 'dash.example', origin: 'https://dash.example', cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = function (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    res.end = function (chunk) {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      const type = String(res.getHeader('content-type') || '');
      const text = /json|text|mpegurl/.test(type) ? buffer.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), bytes: buffer.length, text,
        json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];
const callsTo = pathname => calls.filter(call => call.url.pathname === pathname);

async function signIn() {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const poll = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: cookieFrom(start, 'freeStuffCrazyPlayerLogin') });
  assert.equal(poll.json.authenticated, true);
  return cookieFrom(poll, 'freeStuffCrazyPlayerSession');
}

test('the session cookie stores the Plex credential under its source, and pre-upgrade cookies still work', async () => {
  const cookie = await signIn();
  const payload = createCookieSealer(SECRET).open('session', decodeURIComponent(cookie.split('=')[1]));
  assert.equal(payload.v, 4);
  assert.equal(payload.active, 'plex');
  assert.equal(payload.creds.plex.type, 'plex');
  assert.equal(payload.creds.plex.userToken, 'test-server-token');
  assert.equal(payload.creds.plex.accountId, '1');
  assert.equal(payload.userToken, undefined, 'tokens live only inside the source credential');

  // A v3 cookie issued before this change opens as the Plex credential.
  const legacy = createCookieSealer(SECRET).seal('session', {
    v: 3, sid: 'legacy-session', accountId: 1, generation: 0, accountToken: 'test-account-token',
    userToken: 'test-server-token', title: 'Before upgrade', profileId: '10', plexUrl: 'https://plex.example',
    machineIdentifier: 'test-server', renewedAt: Date.now(),
  }, 60000);
  const me = await request('/api/auth/me', { cookie: `freeStuffCrazyPlayerSession=${legacy}` });
  assert.equal(me.status, 200);
  assert.equal(me.json.title, 'Before upgrade');
});

test('browsing, playback, the media proxy and watch state go through the Plex source', async () => {
  const cookie = await signIn();

  const libraries = await request('/api/library/libraries', { cookie });
  assert.deepEqual(libraries.json, [{ id: '1', title: 'Movies', type: 'movie' }]);
  const alias = await request('/api/plex/libraries', { cookie });
  assert.deepEqual(alias.json, libraries.json, 'the original /api/plex path still works');
  assert.equal((await request('/api/library/item/not-a-key', { cookie })).status, 400);

  const item = await request('/api/library/item/5', { cookie });
  assert.equal(item.json.title, 'Test Movie');
  assert.match(item.json.thumbnail, /^\/api\/library\/thumb\?/);
  const thumb = await request(item.json.thumbnail, { cookie });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers['content-type'], 'image/jpeg');

  const direct = await request('/api/playback/direct-capable', { cookie });
  assert.equal(typeof direct.json.capable, 'boolean');

  // Start a stream: the playlist comes back rewritten through /proxy/.
  const started = await request('/api/start?key=5&quality=low&playbackId=test-play', { cookie });
  assert.equal(started.status, 200, started.text);
  const variant = started.text.split('\n').find(line => line.startsWith('/proxy/'));
  assert.match(variant, /^\/proxy\/video\/:\/transcode\/universal\/session\/[\w-]+\/base\/index\.m3u8$/);
  const sessionId = /session\/([\w-]+)\//.exec(variant)[1];
  const decision = callsTo('/video/:/transcode/universal/decision').at(-1);
  assert.equal(decision.url.searchParams.get('path'), '/library/metadata/5');
  assert.equal(decision.options.headers['X-Plex-Token'], 'test-server-token', 'playback uses the profile token');

  const media = await request(variant, { cookie });
  assert.equal(media.status, 200);
  const segment = media.text.split('\n').find(line => line.startsWith('/proxy/'));
  assert.match(segment, new RegExp(`session/${sessionId}/base/00000\\.ts$`));
  const bytes = await request(segment, { cookie });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers['content-type'], 'video/mp2t');
  assert.equal(bytes.bytes, 188);

  // Another stream's segments are refused.
  assert.equal((await request('/proxy/video/:/transcode/universal/session/someone-else/base/00000.ts', { cookie })).status, 403);

  // Watch state.
  assert.equal((await request('/api/library/progress', { method: 'POST', cookie, body: { ratingKey: '5', timeMs: 30000, durationMs: 100000, state: 'paused' } })).status, 200);
  const progress = callsTo('/:/progress').at(-1);
  assert.equal(progress.url.searchParams.get('key'), '5');
  assert.equal(progress.url.searchParams.get('state'), 'paused');
  assert.equal((await request('/api/library/progress', { method: 'POST', cookie, body: { ratingKey: 'x', timeMs: 1 } })).status, 400);
  assert.equal((await request('/api/library/watched/5', { method: 'POST', cookie })).status, 200);
  assert.equal(callsTo('/:/scrobble').at(-1).url.searchParams.get('key'), '5');
  assert.equal((await request('/api/plex/unwatched/5', { method: 'POST', cookie })).status, 200);
  assert.equal(callsTo('/:/unscrobble').at(-1).url.searchParams.get('key'), '5');

  // Signing out stops the transcode the source started.
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie })).status, 200);
  assert.equal(callsTo('/video/:/transcode/universal/stop').at(-1).url.searchParams.get('session'), sessionId);
});

test('limit plugins receive the source-derived account key', async () => {
  globalThis.__limitKeys.length = 0;
  const cookie = await signIn();
  const me = await request('/api/auth/me', { cookie });
  assert.deepEqual(me.json.quota, { remainingSeconds: 3600, resetAt: '2026-11-16T00:00:00.000Z', breakdown: [{ label: 'Allowance', seconds: 3000 }] },
    'only the documented quota fields and well-formed breakdown rows reach the browser');
  assert.match(me.json.accountId, /^FSC-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/, 'a public code, not the Plex account ID');
  assert.doesNotMatch(me.json.accountId, /plex/i);
  assert.deepEqual(globalThis.__limitKeys, [
    ['account', 'plex', '1', 'plex:1', 'string'],
    ['quota', 'plex:1'],
  ]);
});

test('plugins find and name accounts through core, including by exact email', async () => {
  await signIn();
  const accounts = globalThis.__accounts;
  const owner = { key: 'plex:1', label: 'Owner', detail: 'Plex account 1', source: 'Plex' };
  assert.deepEqual(await accounts.search('owner@example.test'), [owner]);
  assert.deepEqual(await accounts.search('own'), [owner]);
  assert.deepEqual(await accounts.search('owner@example'), [], 'only the exact email matches');
  // An ID that hasn't signed in yet can still be chosen.
  assert.deepEqual(await accounts.search('999'), [{ key: 'plex:999', label: 'Plex account 999', detail: 'Plex account 999', source: 'Plex' }]);
  // The raw key still works for an administrator who has it.
  assert.deepEqual(await accounts.search('plex:1'), [owner]);
  assert.deepEqual(await accounts.search('PLEX:999'), [{ key: 'plex:999', label: 'Plex account 999', detail: 'Plex account 999', source: 'Plex' }]);
  assert.deepEqual(await accounts.search('plex:'), []);
  assert.deepEqual(await accounts.describe('plex:1'), owner);
  assert.equal(await accounts.describe('jellyfin:elsewhere'), null);
  assert.equal(await accounts.describe('1'), null);
});
