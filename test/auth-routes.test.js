import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// Exercise the actual Express middleware/routes without opening a socket or
// contacting Plex. No real credentials/session files are used by these tests.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-auth-test-'));
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: 'owner@example.test',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '', FREESTUFFCRAZY_PLUGIN_MODULES: new URL('./fixtures/start-cap-plugin.js', import.meta.url).href,
});
writeFileSync(path.join(temporary, '.sessions.json'), JSON.stringify({ legacy: { accountToken: 'old', title: 'untrusted', iat: Date.now() } }), { mode: 0o644 });
const originalFetch = globalThis.fetch;
let failHome = false;
let pinSequence = 100;
let pinToken = 'test-account-token';
const calls = [];
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  calls.push({ url, options });
  const json = value => Response.json(value);
  if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (url.pathname === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (url.pathname === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(url.pathname)) return json({ authToken: pinToken });
  if (url.pathname === '/api/v2/home/users') {
    if (failHome) return new Response('upstream-private-error', { status: 503 });
    return json({ users: [{ id: 10, title: 'Owner', admin: true, protected: true }, { id: 20, title: 'Child' }] });
  }
  if (url.pathname === '/api/home/users/20/switch') return json({ authToken: 'test-child-token' });
  if (url.pathname === '/api/v2/user') {
    const stranger = options.headers?.['X-Plex-Token'] === 'stranger-token';
    return json(stranger ? { id: 9, username: 'Stranger', email: 'someone@else.test', confirmed: true }
      : { id: 1, username: 'Owner', email: 'Owner@Example.test', confirmed: true });
  }
  if (url.pathname === '/api/v2/resources') return json([{ clientIdentifier: 'test-server', provides: 'server', owned: true }]);
  if (url.pathname === '/accounts') return json({ MediaContainer: { Account: [{ id: 1, name: 'Owner' }, { id: 20, name: 'Child' }] } });
  if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [] } });
  if (url.pathname === '/status/sessions/history/all') return json({ MediaContainer: { Metadata: [] } });
  throw new Error(`Unexpected mocked upstream request: ${url.pathname}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { method = 'GET', body, cookie = '', origin = 'https://dash.example', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    const payload = body === undefined ? null : JSON.stringify(body);
    req.headers = { host: 'dash.example', origin, cookie, ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    const res = new ServerResponse(req);
    res.end = function (chunk) {
      const binary = res.getHeader('content-type') === 'application/octet-stream';
      const text = chunk && !binary ? chunk.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), bytes: Buffer.byteLength(chunk ?? ''), text,
        json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];

test('only the PLEX_EMAIL account may sign in with Plex', async () => {
  pinToken = 'stranger-token';
  try {
    const start = await request('/api/auth/plex/pin', { method: 'POST' });
    const poll = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: cookieFrom(start, 'freeStuffCrazyPlayerLogin') });
    assert.equal(poll.json.authenticated, false);
    assert.equal(poll.json.pending, false);
    assert.equal(poll.json.error, 'This Plex account can\'t sign in to this server.');
    assert.doesNotMatch(JSON.stringify(poll.json), /PLEX_EMAIL|owner@example|@/, 'nothing about the allowed account');
    assert.equal(cookieFrom(poll, 'freeStuffCrazyPlayerSession'), undefined);
  } finally { pinToken = 'test-account-token'; }
});

test('actual login routes bind state, fail closed, ignore forged profile data and consume transactions', async () => {
  // The old server-side token store is deleted at startup.
  assert.equal(existsSync(path.join(temporary, '.sessions.json')), false);
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  assert.equal(start.status, 200);
  assert.equal(start.json.code, 'TEST');
  const pinHeaders = calls.find(call => call.url.pathname === '/api/v2/pins').options.headers;
  assert.equal(pinHeaders['X-Plex-Device'], start.json.productName);
  assert.equal(pinHeaders['X-Plex-Device-Name'], start.json.productName);
  assert.match(start.json.qrCode, /^data:image\/gif;base64,R0lGOD/);
  const loginCookie = cookieFrom(start, 'freeStuffCrazyPlayerLogin');
  assert.ok(loginCookie);
  assert.match([start.headers['set-cookie']].flat()[0], /HttpOnly/);
  assert.match([start.headers['set-cookie']].flat()[0], /Secure/);
  const pollUrl = `/api/auth/plex/poll?id=${start.json.id}`;
  const before = calls.length;
  const unbound = await request(pollUrl);
  assert.notEqual(unbound.status, 200);
  assert.equal(calls.length, before);

  failHome = true;
  const failed = await request(pollUrl, { cookie: loginCookie });
  assert.notEqual(failed.status, 200);
  assert.equal(cookieFrom(failed, 'freeStuffCrazyPlayerSession'), undefined);
  assert.doesNotMatch(failed.text, /upstream-private-error|test-account-token/);
  failHome = false;
  const picker = await request(pollUrl, { cookie: loginCookie });
  assert.equal(picker.json.needsUserSelection, true);
  // The picker response re-issues the login cookie carrying the (encrypted) account token.
  const pickerCookie = cookieFrom(picker, 'freeStuffCrazyPlayerLogin');
  assert.ok(pickerCookie);
  const selection = await request('/api/auth/plex/select-user', {
    method: 'POST', cookie: pickerCookie,
    body: { pinId: start.json.id, userId: '20', title: 'Owner', thumb: 'https://evil.example/track', admin: true },
  });
  assert.equal(selection.status, 200);
  assert.equal(selection.json.authenticated, true);
  const sessionCookie = cookieFrom(selection, 'freeStuffCrazyPlayerSession');
  assert.ok(sessionCookie);
  const health = await request('/api/playback/canvas-health', { method: 'POST', cookie: sessionCookie,
    body: { playbackId: 'health-test', state: 'playing', live: false,
      mediaTime: 12, videoQueueLength: 3, videoDropCount: 1 } });
  assert.equal(health.status, 204);
  assert.match(readFileSync(path.join(temporary, 'canvas-health.log'), 'utf8'), /"videoDropCount":1/);
  const invalidHealth = await request('/api/playback/canvas-health', { method: 'POST', cookie: sessionCookie,
    body: { playbackId: 'health-test', state: 'playing', videoDropCount: 'bad' } });
  assert.equal(invalidHealth.status, 400);
  // With no limit plugin nothing is metered, so heartbeats never report an expired session.
  const usage = await request('/api/playback/usage', { method: 'POST', cookie: sessionCookie, body: { playbackId: 'unmetered-test', state: 'playing' } });
  assert.equal(usage.status, 200);
  const me = await request('/api/auth/me', { cookie: sessionCookie });
  assert.equal(me.json.title, 'Child'); assert.equal(me.json.thumb, null);
  assert.equal('accountId' in me.json, false, 'with no limit plugin there is no account ID to show');
  assert.match(me.json.stateScope, /^[0-9a-f]{32}$/, 'a one-way key for what the browser saves for this person');
  // With no limit plugin accountKey is null, so the scope takes the account and server from the session itself.
  assert.match(readFileSync(new URL('../server.js', import.meta.url), 'utf8'), /saved-state:\$\{source\.id\}:\$\{stateServer\}:\$\{stateAccount \|\| ''\}/);
  const beforeProbe = calls.length;
  const probe = await request('/api/playback-speed', { cookie: sessionCookie });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers['content-type'], 'application/octet-stream');
  assert.match(probe.headers['cache-control'], /no-store/);
  const rates = probe.headers['x-playback-bitrates'].split(',').map(Number);
  assert.equal(rates.length, 3);
  assert.ok(rates[0] >= rates[1] && rates[1] >= rates[2] && rates[2] > 0);
  assert.equal(probe.bytes, 1024 * 1024);
  assert.equal(calls.length, beforeProbe);
  assert.equal(probe.headers['x-playback-start-cap'], undefined);
  // A plugin's getStartQualityCap can start a client at low and skip the speed sample.
  const capped = await request('/api/playback-speed', { cookie: sessionCookie, headers: { 'x-test-network': 'slow' } });
  assert.equal(capped.status, 200);
  assert.equal(capped.headers['x-playback-start-cap'], 'low');
  assert.equal(capped.bytes, 0);
  assert.equal(capped.headers['x-playback-bitrates'].split(',').length, 3);
  // Tokens travel only inside the encrypted cookie: never readable in it, never on disk.
  assert.doesNotMatch(decodeURIComponent(sessionCookie), /test-child-token|test-account-token/);
  assert.doesNotMatch(decodeURIComponent(pickerCookie), /test-account-token/);
  for (const file of readdirSync(temporary)) {
    assert.doesNotMatch(readFileSync(path.join(temporary, file), 'utf8'), /test-child-token|test-account-token/, file);
  }
  const history = await request('/api/plex/ondeck', { cookie: sessionCookie });
  assert.equal(history.status, 200);
  const historyCall = calls.find(call => call.url.pathname === '/status/sessions/history/all');
  assert.equal(historyCall.url.searchParams.get('accountID'), '20');
  assert.equal(historyCall.url.searchParams.has('X-Plex-Token'), false);

  const replay = await request(pollUrl, { cookie: loginCookie });
  assert.notEqual(replay.status, 200);
  const proxy = await request('/proxy/identity', { cookie: sessionCookie });
  assert.equal(proxy.status, 403);
  const largeThumb = await request('/api/plex/thumb?path=/library/metadata/1/thumb/1&width=999999', { cookie: sessionCookie });
  assert.equal(largeThumb.status, 400);
  const tampered = sessionCookie.slice(0, -2) + (sessionCookie.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await request('/api/auth/me', { cookie: tampered })).status, 401);
  const asLogin = 'freeStuffCrazyPlayerSession=' + loginCookie.split('=')[1];
  assert.equal((await request('/api/auth/me', { cookie: asLogin })).status, 401);

  // Plain sign-out clears this browser's cookie; a copy of it stays valid
  // until "log out on all devices" revokes every cookie for the account.
  const logout = await request('/api/auth/logout', { method: 'POST', cookie: sessionCookie });
  assert.equal(logout.status, 200);
  assert.match([logout.headers['set-cookie']].flat().join(), /freeStuffCrazyPlayerSession=;/);
  assert.equal((await request('/api/auth/me', { cookie: sessionCookie })).status, 200);
  const everywhere = await request('/api/auth/logout-everywhere', { method: 'POST', cookie: sessionCookie });
  assert.equal(everywhere.status, 200);
  assert.equal((await request('/api/auth/me', { cookie: sessionCookie })).status, 401);
  assert.equal(JSON.parse(readFileSync(path.join(temporary, '.signout-generations.json'))).hasOwnProperty('1'), true);
});

test('a new sign-in after logging out everywhere works', async () => {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const loginCookie = cookieFrom(start, 'freeStuffCrazyPlayerLogin');
  const pickerCookie = cookieFrom(await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: loginCookie }), 'freeStuffCrazyPlayerLogin');
  const selection = await request('/api/auth/plex/select-user', {
    method: 'POST', cookie: pickerCookie, body: { pinId: start.json.id, userId: '20' },
  });
  const sessionCookie = cookieFrom(selection, 'freeStuffCrazyPlayerSession');
  assert.equal((await request('/api/auth/me', { cookie: sessionCookie })).status, 200);
  // The picker can't proceed with the first login cookie, which never held the account token.
  const start2 = await request('/api/auth/plex/pin', { method: 'POST' });
  const bare = cookieFrom(start2, 'freeStuffCrazyPlayerLogin');
  const refused = await request('/api/auth/plex/select-user', { method: 'POST', cookie: bare, body: { pinId: start2.json.id, userId: '20' } });
  assert.notEqual(refused.status, 200);
});

test('a signed-in viewer who opens the sign-in page goes on to the player', async () => {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const loginCookie = cookieFrom(start, 'freeStuffCrazyPlayerLogin');
  const pickerCookie = cookieFrom(await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: loginCookie }), 'freeStuffCrazyPlayerLogin');
  const selection = await request('/api/auth/plex/select-user', {
    method: 'POST', cookie: pickerCookie, body: { pinId: start.json.id, userId: '20' },
  });
  const cookie = cookieFrom(selection, 'freeStuffCrazyPlayerSession');
  for (const [url, location] of [['/login', '/browse'], ['/login.html', '/browse'],
    ['/login?return=%2Fcanvas2%3Fkey%3D7', '/canvas2?key=7'], ['/login?return=https%3A%2F%2Fevil.example%2Fbrowse', '/browse'],
    ['/login?return=%2Fadmin', '/browse']]) {
    const page = await request(url, { cookie });
    assert.equal(page.status, 302, url);
    assert.equal(page.headers.location, location, url);
  }
  assert.equal((await request('/login')).status, 200, 'signed out, the sign-in page loads');
  assert.equal((await request('/login', { cookie: 'freeStuffCrazyPlayerSession=%zz' })).status, 200, 'and so with a bad cookie');
});

test('auth namespace is not generally public and malformed cookies are harmless', async () => {
  assert.equal((await request('/api/auth/home-users')).status, 401);
  assert.equal((await request('/api/playback-speed')).status, 401);
  assert.equal((await request('/api/playback-speed', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/auth/switch-user', { method: 'POST', body: { userId: '20' } })).status, 401);
  assert.equal((await request('/api/plex/libraries', { cookie: 'freeStuffCrazyPlayerSession=%zz' })).status, 401);
  assert.equal((await request('/api/auth/plex/pin', { method: 'POST', origin: 'https://evil.example' })).status, 403);
});
