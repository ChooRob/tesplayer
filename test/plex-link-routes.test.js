import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCookieSealer } from '../session-cookie.js';

// A new install sets only PLEX_EMAIL. The server finds and saves its Plex
// credential the first time that account signs in. Plex and plex.tv are mocked.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-link-test-'));
const SECRET = 'test-only-secret-with-at-least-32-characters';
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: SECRET,
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: 'owner@example.test',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', FREESTUFFCRAZY_PLUGIN_MODULES: '',
  EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '', FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: '',
});

const originalFetch = globalThis.fetch;
const plex = { pinToken: 'owner-account-token', email: 'Owner@Example.test', ownsServer: true, calls: [] };
let pinSequence = 900;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  const p = url.pathname;
  plex.calls.push({ p, token: options.headers?.['X-Plex-Token'] });
  const json = body => Response.json(body);
  if (p === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (p === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (p === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(p)) return json({ authToken: plex.pinToken });
  if (p === '/api/v2/home/users') return json({ users: [{ id: 10, title: 'Owner', admin: true }] });
  if (p === '/api/v2/user') return json({ id: 1, username: 'Owner', email: plex.email, confirmed: true });
  if (p === '/api/v2/resources') {
    return json(plex.ownsServer ? [{ clientIdentifier: 'test-server', provides: 'server', owned: true, accessToken: 'test-server-token',
      connections: [{ uri: 'https://plex.example', relay: false }] }] : []);
  }
  if (p === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } });
  if (p === '/accounts') return json({ MediaContainer: { Account: [{ id: 1, name: 'Owner' }] } });
  if (p === '/status/sessions/history/all') return json({ MediaContainer: { Metadata: [] } });
  if (p === '/hubs/sections/1/continueWatching' || /^\/hubs\//.test(p)) return json({ MediaContainer: { Hub: [] } });
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
      const text = Buffer.concat(chunks).toString();
      resolve({ status: res.statusCode, headers: res.getHeaders(), text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];
const linkFile = path.join(temporary, '.plex-link.json');
const savedLink = () => JSON.parse(readFileSync(linkFile, 'utf8')).owner;

async function poll() {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  return request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: cookieFrom(start, 'freeStuffCrazyPlayerLogin') });
}

test('before the owner has signed in nothing is linked and no session works', async () => {
  assert.equal(existsSync(linkFile), false);
  const legacy = createCookieSealer(SECRET).seal('session', {
    v: 3, sid: 'early', accountId: 1, generation: 0, accountToken: 'a', userToken: 'b', title: 'Early',
    profileId: '10', plexUrl: 'https://plex.example', machineIdentifier: 'test-server', renewedAt: Date.now(),
  }, 60000);
  assert.equal((await request('/api/auth/me', { cookie: `freeStuffCrazyPlayerSession=${legacy}` })).status, 401);
  assert.equal((await request('/api/library/libraries')).status, 401);
});

test('a different Plex account cannot link the server', async () => {
  plex.email = 'someone-else@example.test';
  plex.pinToken = 'intruder-token';
  const result = await poll();
  assert.equal(result.json.authenticated, false);
  assert.match(result.json.error, /can't sign in/);
  assert.equal(existsSync(linkFile), false, 'nothing is saved for an account that may not sign in');
  plex.email = 'Owner@Example.test';
});

test('the owner signing in with no server on the account is told, and nothing is saved', async () => {
  plex.ownsServer = false;
  plex.pinToken = 'owner-without-server-token';
  const result = await poll();
  assert.equal(result.json.authenticated, false);
  assert.match(result.json.error, /no Plex server/);
  assert.equal(existsSync(linkFile), false);
  plex.ownsServer = true;
});

let sessionCookie;
test('the owner\'s first sign-in links the server, saves its address but not the token, and signs in', async () => {
  plex.pinToken = 'owner-account-token';
  const result = await poll();
  assert.equal(result.json.authenticated, true);
  sessionCookie = cookieFrom(result, 'freeStuffCrazyPlayerSession');
  const saved = savedLink();
  assert.equal(saved.url, 'https://plex.example');
  assert.equal(saved.machineIdentifier, 'test-server');
  assert.ok(!readFileSync(linkFile, 'utf8').includes('owner-account-token'), 'no token reaches storage');
  assert.ok(plex.calls.some(call => call.p === '/:/prefs' && call.token === 'owner-account-token'), 'the server\'s settings were read with the signed-in token');
  const me = await request('/api/auth/me', { cookie: sessionCookie });
  assert.equal(me.status, 200);
  const libraries = await request('/api/library/libraries', { cookie: sessionCookie });
  assert.deepEqual(libraries.json, [{ id: '1', title: 'Movies', type: 'movie' }]);
});

test('owner-only lookups use the signed-in account\'s own token, since none is stored', async () => {
  plex.calls.length = 0;
  const result = await request('/api/library/ondeck', { cookie: sessionCookie });
  assert.equal(result.status, 200, result.text);
  const lookups = plex.calls.filter(call => call.p === '/accounts');
  assert.ok(lookups.length > 0, 'the accounts list was read');
  assert.ok(lookups.every(call => call.token === 'owner-account-token'), 'with the owner\'s own sign-in token');
});

test('a later owner sign-in saves no token either', async () => {
  plex.pinToken = 'newer-owner-token';
  const result = await poll();
  assert.equal(result.json.authenticated, true);
  assert.ok(!readFileSync(linkFile, 'utf8').includes('newer-owner-token'));
  assert.equal(savedLink().machineIdentifier, 'test-server');
});

test('another account still cannot sign in once linked', async () => {
  plex.email = 'someone-else@example.test';
  plex.pinToken = 'intruder-token';
  const result = await poll();
  assert.equal(result.json.authenticated, false);
  assert.ok(!readFileSync(linkFile, 'utf8').includes('intruder-token'), 'nothing of theirs is saved');
});
