import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// Single tenant with no FREESTUFFCRAZY_ADMIN: the admin is whoever administers the
// configured Jellyfin server, as Jellyfin reports it -- nobody else.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-jf-admin-'));
const SERVER = 'a'.repeat(32);
const USERS = {
  'admin-token': { Id: 'b'.repeat(32), Name: 'Owner', Policy: { IsAdministrator: true } },
  'viewer-token': { Id: 'c'.repeat(32), Name: 'Kid', Policy: { IsAdministrator: false } },
};
let nextToken = 'admin-token';
// The admin area only opens when some plugin has a tab; this one has no limits or server hooks.
const pluginPath = path.join(temporary, 'tab-plugin.js');
writeFileSync(pluginPath, `export default { registerRoutes(_app, context) { context.admin.registerTab({ id: 'test', label: 'Test', file: ${JSON.stringify(pluginPath)} }); } };`);
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: '', PLEX_EMAIL: '', EMBY_URL: '', JELLYFIN_URL: 'https://jf.example', JELLYFIN_NAME: '',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href,
  FREESTUFFCRAZY_ADMIN: '',
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: createHash('sha256').update('x'.repeat(64)).digest('hex'),
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  if (url.origin !== 'https://jf.example') throw new Error(`Unexpected request to ${url.origin}`);
  const json = data => Response.json(data);
  const token = /Token="([^"]+)"/.exec(options.headers?.Authorization || '')?.[1];
  const p = url.pathname;
  if (p === '/System/Info/Public') return json({ Id: SERVER, ServerName: 'Home' });
  if (p === '/QuickConnect/Enabled') return json(true);
  if (p === '/QuickConnect/Initiate') return json({ Secret: 's', Code: '123456' });
  if (p === '/QuickConnect/Connect') return json({ Authenticated: true });
  if (p === '/Users/AuthenticateWithQuickConnect') return json({ AccessToken: nextToken, ServerId: SERVER, User: USERS[nextToken] });
  if (p === '/Users/Me') return json(USERS[token]);
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
      resolve({ status: res.statusCode, headers: res.getHeaders(), json: /^[[{]/.test(text) ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];
async function signInAs(token) {
  nextToken = token;
  const start = await request('/api/auth/jellyfin/start', { method: 'POST', body: {} });
  const poll = await request('/api/auth/jellyfin/poll', { cookie: cookieFrom(start, 'freeStuffCrazyPlayerJellyfinLogin') });
  assert.equal(poll.json.authenticated, true);
  return cookieFrom(poll, 'freeStuffCrazyPlayerSession');
}

test('without FREESTUFFCRAZY_ADMIN, the Jellyfin server’s administrator is the admin', async () => {
  const cookie = await signInAs('admin-token');
  assert.equal((await request('/api/admin/auth/status', { cookie })).status, 200);
});

test('other users of the server are not', async () => {
  const cookie = await signInAs('viewer-token');
  assert.equal((await request('/api/admin/auth/status', { cookie })).status, 403);
});
