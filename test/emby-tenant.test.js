import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';

process.env.SESSION_SECRET ||= 'test-only-secret-with-at-least-32-characters';
const { createEmbySource } = await import('../emby-source.js');
const { checkSourceConfig, sourceProblems } = await import('../sources.js');
const { bundledSources } = await import('../bundled-sources.js');

// Users' own Emby servers, through an embyServers plugin: the sign-in asks which server,
// and every request to it goes through the plugin's fetch, never core's own.
const OTHER_ID = 'e'.repeat(32);
const USER_ID = 'b'.repeat(32);
const PLAY = 'c'.repeat(32);
const TOKEN = 'tenant-token';
const pluginCalls = [];
const coreCalls = [];

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
// A response that never ends, counting what was read from it.
const endless = { chunks: 0, cancelled: false };
const endlessBody = () => new ReadableStream({
  pull(controller) { endless.chunks++; controller.enqueue(new Uint8Array(16 * 1024).fill(32)); },
  cancel() { endless.cancelled = true; },
});
async function tenantFetch(input, init = {}) {
  const url = new URL(String(input));
  pluginCalls.push({ host: url.host, path: url.pathname, params: url.searchParams, method: init.method || 'GET', headers: init.headers, body: init.body && JSON.parse(init.body) });
  if (url.host === 'down.example') throw Object.assign(new Error('connect failed'), { userMessage: 'That server’s certificate isn’t trusted (it may be self-signed).' });
  if (url.host === 'huge.example') return new Response(endlessBody(), { headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/System/Info/Public') return json({ Id: OTHER_ID, ServerName: 'Friend Emby' });
  if (url.pathname === '/Users/AuthenticateByName') return JSON.parse(init.body).Pw === 'right' ? json({ AccessToken: TOKEN, ServerId: OTHER_ID, User: { Id: USER_ID, Name: 'Pat' } }) : new Response('', { status: 401 });
  if (url.pathname === `/Users/${USER_ID}/Views`) return json({ Items: [{ Id: '3', Name: 'Movies', CollectionType: 'movies' }] });
  const playSession = url.host === 'twin.example' ? 'd'.repeat(32) : PLAY;
  if (url.pathname === '/Items/7/PlaybackInfo') return json({ PlaySessionId: playSession, MediaSources: [{ Id: 'mediasource_7', TranscodingUrl: `/videos/7/master.m3u8?PlaySessionId=${playSession}&api_key=K` }] });
  if (url.host === 'bigplaylist.example' && url.pathname === '/videos/7/master.m3u8') return new Response(`#EXTM3U\n${'#EXT-X-X:0\n'.repeat(500_000)}`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (url.pathname === '/videos/7/master.m3u8') return new Response(`#EXTM3U\nmain.m3u8?PlaySessionId=${playSession}\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  return new Response(null, { status: 204 });
}
const embyServers = {
  async resolve(address) {
    if (!/^https:\/\//.test(address)) throw new TypeError('Enter the full https:// address, like https://emby.example.com');
    return new URL(address).origin;
  },
  fetch: tenantFetch,
  maxBitrate: url => (url.includes('slow.example') ? 1000 : url.includes('tiny.example') ? 300 : null),
  displayAddress: async () => null,
  prompt: { hint: 'Enter your server’s https:// address.', label: 'Server address', placeholder: 'https://emby.example.com' },
};
const plugins = [{ embyServers }];
const store = { collection: () => ({ get: async () => undefined, update: async () => {}, set: async () => {}, entries: async () => [] }) };
const config = { plex: { productName: 'Test Player', videoBitrate: 4000 }, auth: { sessionDays: 1, secureCookies: false } };
const source = await createEmbySource({
  config, plugins, store, pipeUpstream: (upstream, res) => Readable.fromWeb(upstream.body).pipe(res),
  env: { SESSION_SECRET: process.env.SESSION_SECRET }, // no EMBY_URL: every user brings their own server
  fetchImpl: async (...args) => { coreCalls.push(args); throw new Error('core must not fetch a user\'s server'); },
});

const app = express();
app.use(express.json());
app.use((req, res, next) => source.auth.loadSession(req, res, next));
source.registerRoutes(app, { rateLimit: () => (_req, _res, next) => next() });
app.get('/api/start', async (req, res) => {
  const state = {};
  try { await source.playback.start(req, res, { itemId: req.query.key, state, stopState: async () => {} }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/who', async (req, res) => res.json({
  key: await source.auth.getSessionAccountKey(req), server: await source.auth.getSessionServer(req), admin: await source.auth.getAdminIdentity(req),
}));
app.get('/libraries', async (req, res) => { try { res.json(await source.library(req).libraries()); } catch { res.status(401).end(); } });
app.post('/progress', async (req, res) => { await source.watchState.reportProgress(req, req.body); res.json({ ok: true }); });
const server = await new Promise(resolve => { const s = createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
after(() => server.close());
const at = path => `http://127.0.0.1:${server.address().port}${path}`;
let cookie = '';
const send = (path, body) => fetch(at(path), { method: body ? 'POST' : 'GET', headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
// Keep the newest value of each cookie, the way a browser does.
const keepCookies = response => {
  const jar = new Map(cookie.split('; ').filter(Boolean).map(pair => [pair.split('=')[0], pair]));
  for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0]; jar.set(pair.split('=')[0], pair); }
  cookie = [...jar.values()].join('; ');
};

test('an embyServers plugin turns Emby on without EMBY_URL, and the source meets the contract', () => {
  assert.deepEqual(checkSourceConfig({}, [plugins[0]]).configured, [{ id: 'emby', type: 'emby' }]);
  assert.deepEqual(checkSourceConfig({}, []).configured, []);
  assert.equal(bundledSources.sources.emby.configure({}, { plugins: [{ embyServers: { resolve() {} } }] }), null, 'a plugin without fetch does not count');
  assert.deepEqual(sourceProblems(source, { id: 'emby', type: 'emby' }), []);
  const options = source.signInOptions;
  assert.equal(options.askServer, true);
  assert.equal(options.serverRequired, true, 'with no configured server an address is required');
  assert.equal(options.serverPrompt.label, 'Server address');
});

test('the sign-in step for a server refuses what the plugin refuses and explains what it can', async () => {
  let response = await send('/api/auth/emby/start', { server: '' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /https:\/\/ address/);
  response = await send('/api/auth/emby/start', { server: 'http://friend.example' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /full https:\/\/ address/);
  response = await send('/api/auth/emby/start', { server: 'https://down.example' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /certificate/);
  assert.equal((await send('/api/auth/emby/password', { username: 'pat', password: 'right' })).status, 400, 'no server chosen yet');
});

test('a user\'s own server: sign in, browse and stream through the plugin only', async () => {
  let response = await send('/api/auth/emby/start', { server: 'https://friend.example/' });
  assert.deepEqual(await response.json(), { serverName: 'Friend Emby' });
  keepCookies(response);
  assert.equal((await send('/api/auth/emby/password', { username: 'pat', password: 'wrong' })).status, 401);
  response = await send('/api/auth/emby/password', { username: 'pat', password: 'right' });
  assert.equal(response.status, 200);
  keepCookies(response);

  const who = await (await send('/who')).json();
  assert.equal(who.key, `emby:${OTHER_ID}@friend.example`, 'keyed by address, since a server reports its own ID');
  assert.deepEqual(who.server, { name: 'Friend Emby', address: 'https://friend.example/' }, 'shows what they typed');
  assert.equal(who.admin, null, 'a user\'s own server never makes an admin');
  assert.deepEqual(await (await send('/libraries')).json(), [{ id: '3', title: 'Movies', type: 'movie' }]);

  const playlist = await (await send('/api/start?key=7&quality=ultra')).text();
  assert.match(playlist, /^\/proxy\/videos\/7\/main\.m3u8\?.*PlaySessionId=c{32}/m);
  assert.ok(!playlist.includes('api_key'));
  assert.ok(pluginCalls.every(call => ['friend.example', 'down.example'].includes(call.host)), 'only the typed servers were contacted');
  assert.equal(coreCalls.length, 0, 'core never fetched a user\'s server itself');
  const info = pluginCalls.findLast(call => call.path === '/Items/7/PlaybackInfo');
  assert.equal(info.params.get('MaxStreamingBitrate'), String(6000 * 1000 + 128000), 'no cap on an ordinary server');
});

test('a server the plugin caps never streams more than the cap', async () => {
  let response = await send('/api/auth/emby/start', { server: 'https://slow.example' });
  keepCookies(response);
  response = await send('/api/auth/emby/password', { username: 'pat', password: 'right' });
  keepCookies(response);
  await send('/api/start?key=7&quality=ultra');
  const info = pluginCalls.findLast(call => call.path === '/Items/7/PlaybackInfo');
  const asked = Number(info.params.get('MaxStreamingBitrate'));
  assert.ok(asked <= 1000 * 1000, `capped to 1000 kbps, asked for ${asked}`);
});

test('a cap below the minimum supported stream rate refuses playback', async () => {
  let response = await send('/api/auth/emby/start', { server: 'https://tiny.example' });
  keepCookies(response);
  response = await send('/api/auth/emby/password', { username: 'pat', password: 'right' });
  keepCookies(response);
  const before = pluginCalls.filter(call => call.path === '/Items/7/PlaybackInfo').length;
  response = await send('/api/start?key=7&quality=low');
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /bitrate cap is too low/);
  assert.equal(pluginCalls.filter(call => call.path === '/Items/7/PlaybackInfo').length, before);
});

test('progress stays with each viewer and server when IDs match', async () => {
  let response = await send('/api/auth/emby/start', { server: 'https://friend.example' });
  keepCookies(response);
  response = await send('/api/auth/emby/password', { username: 'pat', password: 'right' });
  keepCookies(response);
  await send('/api/start?key=7');
  const friendCookie = cookie;

  response = await send('/api/auth/emby/start', { server: 'https://twin.example' });
  keepCookies(response);
  response = await send('/api/auth/emby/password', { username: 'pat', password: 'right' });
  keepCookies(response);
  await send('/api/start?key=7');
  const twinCookie = cookie;

  cookie = friendCookie;
  await send('/progress', { itemId: '7', timeMs: 1000, state: 'playing' });
  assert.equal(pluginCalls.findLast(call => call.path === '/Sessions/Playing/Progress').body.PlaySessionId, PLAY);
  cookie = twinCookie;
  await send('/progress', { itemId: '7', timeMs: 1000, state: 'playing' });
  assert.equal(pluginCalls.findLast(call => call.path === '/Sessions/Playing/Progress').body.PlaySessionId, 'd'.repeat(32));
});

test('a typed server cannot make sign-in read an unbounded response', async () => {
  const response = await send('/api/auth/emby/start', { server: 'https://huge.example' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Could not reach an Emby server/);
  assert.ok(endless.cancelled, 'the body was dropped');
  assert.ok(endless.chunks < 40, `read ${endless.chunks} chunks of an endless body`);
});

test('a playlist larger than the limit is refused', async () => {
  let response = await send('/api/auth/emby/start', { server: 'https://bigplaylist.example' });
  keepCookies(response);
  response = await send('/api/auth/emby/password', { username: 'pat', password: 'right' });
  keepCookies(response);
  response = await send('/api/start?key=7');
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /too large/);
});

test('a session on a server whose plugin is gone stops working', async () => {
  const without = await createEmbySource({ config, plugins: [], store, pipeUpstream() {}, env: { SESSION_SECRET: process.env.SESSION_SECRET, EMBY_URL: 'http://home.test:8096' }, fetchImpl: async () => json({ Id: 'a'.repeat(32), ServerName: 'Home' }) });
  const request = { headers: { cookie } };
  await new Promise(resolve => without.auth.loadSession(request, {}, resolve));
  assert.equal(without.auth.getSessionId(request), null);
});
