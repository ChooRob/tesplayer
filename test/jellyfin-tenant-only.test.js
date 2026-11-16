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

// A jellyfinServers plugin with no JELLYFIN_URL: Jellyfin is offered, but every user
// must give their own server's address -- there is no site server to fall back to.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-tenant-only-'));
const SECRET = 'test-only-secret-with-at-least-32-characters';
const SERVER = 'a'.repeat(32);
const USER = 'b'.repeat(32);
const pluginPath = path.join(temporary, 'tenant-plugin.js');
writeFileSync(pluginPath, `
export default {
  jellyfinServers: {
    resolve: async address => { if (!address.startsWith('https://')) throw new Error('Only https:// Jellyfin servers are allowed.'); return address; },
    fetch: (url, init) => globalThis.__tenantFetch(url, init),
  },
  registerRoutes(_app, context) { context.admin.registerTab({ id: 'test', label: 'Test', file: ${JSON.stringify(pluginPath)} }); },
};
`);
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: SECRET,
  PLEX_TOKEN: '', PLEX_URL: '', JELLYFIN_URL: '', JELLYFIN_NAME: '',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '',
  FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href,
  // Even a named Jellyfin admin is never recognized on users' own servers.
  FREESTUFFCRAZY_ADMIN: `jellyfin:${USER}:Pat`,
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: createHash('sha256').update('x'.repeat(64)).digest('hex'),
});

const originalFetch = globalThis.fetch;
globalThis.fetch = value => { throw new Error(`Core fetched ${value} directly`); };
globalThis.__tenantFetch = async (value, options = {}) => {
  const url = new URL(value);
  if (url.origin !== 'https://mine.example') throw new Error(`Unexpected server ${url.origin}`);
  const json = data => Response.json(data);
  const p = url.pathname;
  if (p === '/System/Info/Public') return json({ Id: SERVER, ServerName: 'Mine' });
  if (p === '/QuickConnect/Enabled') return json(true);
  if (p === '/QuickConnect/Initiate') return json({ Secret: 's', Code: '333444' });
  if (p === '/QuickConnect/Connect') return json({ Authenticated: true });
  if (p === '/Users/AuthenticateWithQuickConnect') return json({ AccessToken: 'mine-token', ServerId: SERVER, User: { Id: USER, Name: 'Pat' } });
  if (p === '/Users/Me') return json({ Id: USER, Name: 'Pat' });
  if (p === '/UserViews') return json({ Items: [{ Id: 'c'.repeat(32), Name: 'My Movies', CollectionType: 'movies' }] });
  throw new Error(`Unexpected request ${options.method || 'GET'} ${p}`);
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

test('Jellyfin is offered with the server address required', async () => {
  assert.deepEqual((await request('/api/auth/sources')).json,
    [{ id: 'jellyfin', type: 'jellyfin', name: 'Jellyfin', askServer: true, serverRequired: true }]);
  const missing = await request('/api/auth/jellyfin/start', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /address/);
  assert.equal((await request('/api/auth/jellyfin/password', { method: 'POST', body: { username: 'pat', password: 'x' } })).status, 400,
    'no password sign-in without a chosen server');
});

test('a user signs in to their own server, and is never the admin', async () => {
  const start = await request('/api/auth/jellyfin/start', { method: 'POST', body: { server: 'https://mine.example' } });
  assert.equal(start.json.code, '333444');
  const poll = await request('/api/auth/jellyfin/poll', { cookie: cookieFrom(start, 'freeStuffCrazyPlayerJellyfinLogin') });
  const cookie = cookieFrom(poll, 'freeStuffCrazyPlayerSession');
  assert.deepEqual((await request('/api/library/libraries', { cookie })).json.map(library => library.title), ['My Movies']);
  assert.equal((await request('/api/auth/me', { cookie })).json.adminAvailable, false);
  assert.equal((await request('/api/admin/auth/status', { cookie })).status, 403);
});

test('a session that names no server is not accepted', async () => {
  const credential = { type: 'jellyfin', serverId: SERVER, userId: USER, name: 'Pat', accessToken: 'mine-token', deviceId: 'd', generation: 0 };
  const forged = createCookieSealer(SECRET).seal('session', packSession({ sid: 'x', sourceId: 'jellyfin', credential, renewedAt: Date.now() }), 60000);
  assert.equal((await request('/api/library/libraries', { cookie: `freeStuffCrazyPlayerSession=${forged}` })).status, 401);
});
