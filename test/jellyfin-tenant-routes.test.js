import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCookieSealer, packSession } from '../session-cookie.js';

// A jellyfinServers plugin lets users sign in to their own server by
// address. Core still has its configured server; users' servers are reached
// only through the plugin's fetch, and nothing they report is trusted for
// limits or admin.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-tenant-test-'));
const SECRET = 'test-only-secret-with-at-least-32-characters';
const HOME_SERVER = 'a'.repeat(32);
const ADMIN = 'b'.repeat(32);
const TENANT_USER = 'c'.repeat(32);
const LIB = 'd'.repeat(32);
const MOVIE = '9'.repeat(32);
const PLAY = '8'.repeat(32);
const EVIL = '5'.repeat(32);
const pluginPath = path.join(temporary, 'tenant-plugin.js');
writeFileSync(pluginPath, `
export default {
  jellyfinServers: {
    resolve: async address => {
      if (address === 'linked-name') return 'relay://abc123';
      if (!address.startsWith('https://')) throw new Error('Only https:// Jellyfin servers are allowed.');
      return address;
    },
    fetch: (url, init) => globalThis.__tenantFetch(url, init),
    maxBitrate: url => (url.startsWith('https://capped.example/c/abc') ? 2000 : null),
    displayAddress: url => (url === 'relay://abc123' ? 'linked-name' : null),
    prompt: { hint: 'Enter your server name or address.', label: 'Server name or address', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', extra: 'ignored' },
  },
  getQuotaStatus(key) { globalThis.__keys.push(key); return { remainingSeconds: 60 }; },
  publicPaths: ['/plugin-public', '/api/admin/plugin-public'],
  registerRoutes(app, context) {
    globalThis.__accounts = context.accounts;
    context.admin.registerTab({ id: 'test', label: 'Test', file: ${JSON.stringify(pluginPath)} });
    for (const path of ['/plugin-public', '/plugin-private', '/api/admin/plugin-public']) app.get(path, (_req, res) => res.json({ path }));
  },
};
`);
globalThis.__keys = [];
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: SECRET,
  PLEX_URL: '', EMBY_URL: '', JELLYFIN_URL: 'https://home.example', JELLYFIN_NAME: '',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '',
  FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href,
  FREESTUFFCRAZY_ADMIN: `jellyfin:${ADMIN}:Owner`,
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: createHash('sha256').update('x'.repeat(64)).digest('hex'),
});

// One fake Jellyfin. `id` is what the server claims to be; `user` who signs in.
function jellyfinServer({ name, id, user }) {
  const calls = [];
  const handler = async (value, options = {}) => {
    const url = new URL(value);
    calls.push(url);
    const json = data => Response.json(data);
    const p = url.pathname;
    if (p === '/System/Info/Public') return json({ Id: id, ServerName: name });
    if (p === '/QuickConnect/Enabled') return json(true);
    if (p === '/QuickConnect/Initiate') return json({ Secret: 'secret', Code: '111222' });
    if (p === '/QuickConnect/Connect') return json({ Authenticated: true });
    if (p === '/Users/AuthenticateWithQuickConnect') return json({ AccessToken: `${name}-token`, ServerId: id, User: user });
    if (p === '/Users/Me') return json({ ...user, Policy: { IsAdministrator: true } });
    if (p === '/UserViews') return json({ Items: [{ Id: LIB, Name: `${name} Movies`, CollectionType: 'movies' }] });
    if (p === '/Sessions/Logout' || p === '/Sessions/Playing') return new Response(null, { status: 204 });
    if (p === `/Items/${MOVIE}/PlaybackInfo`) {
      calls.at(-1).body = JSON.parse(options.body);
      return json({ PlaySessionId: PLAY, MediaSources: [{ Id: MOVIE, TranscodingUrl: `/videos/${MOVIE}/master.m3u8?MediaSourceId=${MOVIE}&PlaySessionId=${PLAY}` }] });
    }
    if (p === `/Items/${EVIL}/PlaybackInfo`) {
      return json({ PlaySessionId: PLAY, MediaSources: [{ Id: EVIL, TranscodingUrl: `/videos/${EVIL}/master.m3u8?PlaySessionId=${PLAY}` }] });
    }
    if (p === `/videos/${EVIL}/master.m3u8`) {
      // Points at another server under the same scheme.
      return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nrelay://other/videos/${EVIL}/main.m3u8?PlaySessionId=${PLAY}\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (p === `/videos/${MOVIE}/main.m3u8`) {
      return new Response(`#EXTM3U\n#EXTINF:6,\nhls1/main/0.ts?PlaySessionId=${PLAY}\n#EXT-X-ENDLIST\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (p === `/videos/${MOVIE}/hls1/main/0.ts`) return new Response(new Uint8Array(188), { headers: { 'Content-Type': 'video/mp2t' } });
    if (p === `/videos/${MOVIE}/master.m3u8`) {
      return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nmain.m3u8?PlaySessionId=${PLAY}\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    throw new Error(`Unexpected request to ${name}: ${options.method || 'GET'} ${p}`);
  };
  return { handler, calls };
}
const home = jellyfinServer({ name: 'Home', id: HOME_SERVER, user: { Id: ADMIN, Name: 'Owner' } });
// A user's server that copies the home server's ID and claims to be the admin.
const tenant = jellyfinServer({ name: 'Tenant', id: HOME_SERVER, user: { Id: ADMIN, Name: 'Owner' } });
const honest = jellyfinServer({ name: 'Honest', id: 'e'.repeat(32), user: { Id: TENANT_USER, Name: 'Pat' } });
// Reached at a path (like a relayed server), with a bitrate cap from the plugin.
const capped = jellyfinServer({ name: 'Capped', id: '7'.repeat(32), user: { Id: TENANT_USER, Name: 'Pat' } });
// Signs in normally; then globalThis.__flaky makes every request fail with it.
const flaky = jellyfinServer({ name: 'Flaky', id: '4'.repeat(32), user: { Id: TENANT_USER, Name: 'Pat' } });
globalThis.__flaky = null;
// Named with the plugin's own scheme, which only its fetch can reach.
const linkedServer = jellyfinServer({ name: 'Linked', id: '6'.repeat(32), user: { Id: TENANT_USER, Name: 'Pat' } });

const originalFetch = globalThis.fetch;
globalThis.fetch = (value, options) => {
  const url = new URL(value);
  if (url.origin === 'https://home.example') return home.handler(value, options);
  throw new Error(`Core fetched ${url.origin} directly; users' servers must go through the plugin`);
};
globalThis.__tenantFetch = (value, options) => {
  const url = new URL(value);
  if (url.origin === 'https://tenant.example') return tenant.handler(value, options);
  if (url.origin === 'https://honest.example') return honest.handler(value, options);
  if (url.origin === 'https://flaky.example') {
    return globalThis.__flaky ? Promise.reject(Object.assign(new Error('relay problem'), globalThis.__flaky)) : flaky.handler(value, options);
  }
  if (url.protocol === 'relay:') {
    if (url.host !== 'abc123') return Promise.reject(new Error(`fetched another relay server: ${url.host}`));
    return linkedServer.handler(new URL(url.pathname + url.search, 'https://linked.internal'), options);
  }
  if (url.origin === 'https://capped.example') {
    // Everything for this server must keep its /c/abc path.
    if (!url.pathname.startsWith('/c/abc/')) return Promise.reject(new Error(`lost the server's path: ${url.pathname}`));
    return capped.handler(new URL(url.pathname.slice('/c/abc'.length) + url.search, url.origin), options);
  }
  if (url.origin === 'https://self-signed.example') return Promise.reject(Object.assign(new Error('self-signed certificate'), { userMessage: 'That server’s certificate isn’t trusted.' }));
  if (url.origin === 'https://down.example') return Promise.reject(new Error('connect ECONNREFUSED 203.0.113.9:443'));
  throw new Error(`Unexpected tenant server ${url.origin}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { method = 'GET', body, cookie = '', ip } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    if (ip) Object.defineProperty(socket, 'remoteAddress', { value: ip });
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    const payload = body === undefined ? null : JSON.stringify(body);
    req.headers = { host: 'dash.example', origin: 'https://dash.example', cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    const res = new ServerResponse(req);
    res.end = function (chunk) {
      const text = chunk ? chunk.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];
async function signIn(server, { ip } = {}) {
  const start = await request('/api/auth/jellyfin/start', { method: 'POST', body: server ? { server } : {}, ip });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const poll = await request('/api/auth/jellyfin/poll', { cookie: cookieFrom(start, 'freeStuffCrazyPlayerJellyfinLogin'), ip });
  assert.equal(poll.json.authenticated, true);
  return { cookie: cookieFrom(poll, 'freeStuffCrazyPlayerSession'), start: start.json };
}
const credentialOf = cookie => createCookieSealer(SECRET).open('session', decodeURIComponent(cookie.split('=')[1])).creds.jellyfin;

test('the login page asks for a server address, and only addresses the plugin allows are used', async () => {
  assert.deepEqual((await request('/api/auth/sources')).json, [{ id: 'jellyfin', type: 'jellyfin', name: 'Jellyfin', askServer: true, serverRequired: false,
    serverPrompt: { hint: 'Enter your server name or address.', label: 'Server name or address', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } }]);
  const refused = await request('/api/auth/jellyfin/start', { method: 'POST', body: { server: 'http://tenant.example' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /https/);
});

test('a server reached at a path keeps it for playback, and its bitrate cap is applied', async () => {
  const { cookie } = await signIn('https://capped.example/c/abc', { ip: '203.0.113.20' });
  const started = await request(`/api/start?key=${MOVIE}&quality=ultra&playbackId=capped-play`, { cookie });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const info = capped.calls.find(url => url.pathname === `/Items/${MOVIE}/PlaybackInfo`);
  assert.ok(Number(info.searchParams.get('maxStreamingBitrate')) <= 2_000_000, 'video and audio together stay under the cap');
  const limits = info.body.DeviceProfile.CodecProfiles?.flatMap(profile => profile.Conditions || []) || [];
  const width = limits.find(c => c.Property === 'Width')?.Value;
  assert.equal(width, '1280', 'a capped server streams at most 720p even when Ultra was asked for');
  const master = capped.calls.find(url => url.pathname === `/videos/${MOVIE}/master.m3u8`);
  assert.ok(master, 'the stream request kept the server path');
  assert.ok(Number(master.searchParams.get('VideoBitrate')) <= 2_000_000 - 128_000);
});

test('a server named with a plugin scheme signs in, plays, and keeps its own quota key', async () => {
  globalThis.__keys.length = 0;
  const { cookie } = await signIn('linked-name', { ip: '203.0.113.20' });
  assert.equal(credentialOf(cookie).serverUrl, 'relay://abc123');
  const started = await request(`/api/start?key=${MOVIE}&quality=high&playbackId=linked-play`, { cookie });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.ok(globalThis.__keys.includes(`jellyfin:${'6'.repeat(32)}@abc123`), JSON.stringify(globalThis.__keys));
});

test('the signed-in person sees their server and what to type to sign in to it', async () => {
  const { cookie } = await signIn('linked-name', { ip: '203.0.113.20' });
  const me = (await request('/api/auth/me', { cookie })).json;
  assert.deepEqual(me.server, { name: 'Linked', address: 'linked-name' }, 'what was typed, not the plugin’s internal address');
  assert.equal(credentialOf(cookie).serverAddress, 'linked-name');

  // A session from before the typed address was kept still shows it: the plugin names the server.
  const { serverAddress: _typed, ...older } = credentialOf(cookie);
  const sealer = createCookieSealer(SECRET);
  const olderCookie = `freeStuffCrazyPlayerSession=${encodeURIComponent(sealer.seal('session', packSession({ sid: 'older-session', sourceId: 'jellyfin', credential: older }), 3600000))}`;
  assert.deepEqual((await request('/api/auth/me', { cookie: olderCookie })).json.server, { name: 'Linked', address: 'linked-name' });
});

test('a playlist entry pointing at another server under the same scheme is refused', async () => {
  const { cookie } = await signIn('linked-name', { ip: '203.0.113.20' });
  const started = await request(`/api/start?key=${EVIL}&quality=high&playbackId=evil-play`, { cookie });
  assert.notEqual(started.status, 200);
  assert.ok(!linkedServer.calls.some(url => url.pathname.includes('/main.m3u8') && url.pathname.includes(EVIL)));
});

test('a server the plugin can’t reach is explained, and one that is gone ends the session', async () => {
  const { cookie } = await signIn('https://flaky.example', { ip: '203.0.113.20' });
  try {
    globalThis.__flaky = { status: 503, userMessage: 'Your server isn’t connected right now.' };
    const offline = await request('/api/library/libraries', { cookie });
    assert.equal(offline.status, 503);
    assert.deepEqual(offline.json, { error: 'Your server isn’t connected right now.', code: 'SERVER_UNAVAILABLE' });

    globalThis.__flaky = { status: 410, userMessage: 'That server is no longer linked.', serverGone: true };
    const gone = await request('/api/library/libraries', { cookie });
    assert.equal(gone.status, 401);
    assert.deepEqual(gone.json, { error: 'That server is no longer linked.', code: 'SERVER_GONE' });
    const cleared = [gone.headers['set-cookie'] || []].flat().find(value => value.startsWith('freeStuffCrazyPlayerSession='));
    assert.match(cleared || '', /Expires=Thu, 01 Jan 1970/, 'the session cookie is cleared');
  } finally {
    globalThis.__flaky = null;
  }
});

test('a plugin can make its own pages public, but never admin APIs', async () => {
  assert.equal((await request('/plugin-public')).status, 200);
  assert.equal((await request('/plugin-private')).status, 302, 'other plugin pages still need sign-in');
  assert.equal((await request('/api/admin/plugin-public')).status, 401, 'admin APIs can never be made public');
});

test('a connection failure the plugin explains is shown; other failures stay generic', async () => {
  const explained = await request('/api/auth/jellyfin/start', { method: 'POST', body: { server: 'https://self-signed.example' } });
  assert.equal(explained.status, 400);
  assert.equal(explained.json.error, 'That server’s certificate isn’t trusted.');
  const generic = await request('/api/auth/jellyfin/start', { method: 'POST', body: { server: 'https://down.example' } });
  assert.equal(generic.status, 400);
  assert.equal(generic.json.error, 'Could not reach a Jellyfin server at that address.', 'raw connection errors never reach the page');
});

test('a user signs in to their own server and uses it for the whole session', async () => {
  const { cookie, start } = await signIn('https://honest.example/');
  assert.equal(start.serverName, 'Honest');
  const credential = credentialOf(cookie);
  assert.equal(credential.serverUrl, 'https://honest.example');
  const libraries = await request('/api/library/libraries', { cookie });
  assert.deepEqual(libraries.json.map(library => library.title), ['Honest Movies']);
  assert.ok(honest.calls.some(url => url.pathname === '/UserViews'));
  assert.ok(!home.calls.some(url => url.pathname === '/UserViews'), 'the configured server is not asked');

  // Its limits are keyed by address as well as ID, and admins can find it.
  globalThis.__keys.length = 0;
  await request('/api/auth/me', { cookie });
  assert.deepEqual(globalThis.__keys, [`jellyfin:${'e'.repeat(32)}@honest.example`]);
  const [account] = await globalThis.__accounts.search('honest');
  assert.deepEqual(account, { key: `jellyfin:${'e'.repeat(32)}@honest.example`, label: 'Honest', detail: 'Jellyfin server at https://honest.example', source: 'Jellyfin' });
});

test('a user’s server can’t pose as the configured server or its admin', async () => {
  const { cookie } = await signIn('https://tenant.example');
  globalThis.__keys.length = 0;
  const me = await request('/api/auth/me', { cookie });
  assert.notDeepEqual(globalThis.__keys, [`jellyfin:${HOME_SERVER}`], 'a copied server ID gets its own key');
  assert.deepEqual(globalThis.__keys, [`jellyfin:${HOME_SERVER}@tenant.example`]);
  assert.equal(me.json.adminAvailable, false, 'claiming the admin user ID and name is not enough');
  assert.equal((await request('/api/admin/auth/status', { cookie })).status, 403);
});

test('the configured server shows its name, with nothing to type', async () => {
  const { cookie } = await signIn();
  assert.deepEqual((await request('/api/auth/me', { cookie })).json.server, { name: 'Home', address: null });
});

test('the configured server still works, and its named admin is recognized there', async () => {
  const { cookie } = await signIn();
  assert.equal(credentialOf(cookie).serverUrl, undefined);
  globalThis.__keys.length = 0;
  const me = await request('/api/auth/me', { cookie });
  assert.deepEqual(globalThis.__keys, [`jellyfin:${HOME_SERVER}`]);
  assert.equal(me.json.adminAvailable, true);
  // Typing the configured server's own address is the same as leaving it empty.
  const typed = await signIn('https://home.example/');
  assert.equal(credentialOf(typed.cookie).serverUrl, undefined);
});

test('a password is never sent to the configured server when the sign-in lost track of the server chosen', async () => {
  home.calls.length = 0;
  const lost = await request('/api/auth/jellyfin/password', { method: 'POST', body: { username: 'pat', password: 'secret' } });
  assert.equal(lost.status, 400);
  assert.match(lost.json.error, /start again/);
  assert.equal(home.calls.filter(url => url.pathname === '/Users/AuthenticateByName').length, 0, 'no password reached the configured server');
});
