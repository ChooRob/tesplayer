import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// With a plugin that chooses each viewer's server the install has no server of its
// own and the owner link must stay out of the way: anyone with access can sign in,
// the plugin's server is used, and nothing is saved.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-multitenant-link-test-'));
const pluginPath = path.join(temporary, 'chooser-plugin.js');
writeFileSync(pluginPath, `export default { resolveServer: async (userToken) => (
  { ok: true, plexUrl: 'https://chosen.example', machineIdentifier: 'chosen-server', accessToken: 'token-for-' + userToken }
) };\n`);
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: '',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '',
  FREESTUFFCRAZY_PLUGIN_MODULES: new URL(`file://${pluginPath}`).href,
});

const originalFetch = globalThis.fetch;
const calls = [];
let pinSequence = 700;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  calls.push({ url, token: options.headers?.['X-Plex-Token'] });
  const json = body => Response.json(body);
  const p = url.pathname;
  if (p === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (p === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (p === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(p)) return json({ authToken: 'stranger-token' });
  if (p === '/api/v2/home/users') return json({ users: [{ id: 30, title: 'Stranger' }] });
  if (p === '/api/v2/user') return json({ id: 9, username: 'Stranger', email: 'stranger@example.test', confirmed: true });
  if (p === '/library/sections') return json({ MediaContainer: { Directory: [] } });
  throw new Error(`Unexpected mocked upstream request: ${url.hostname}${p}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { cookie = '', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    req.headers = { host: 'dash.example', origin: 'https://dash.example', cookie };
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = function (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    res.end = function (chunk) {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      resolve({ status: res.statusCode, headers: res.getHeaders(), json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];

test('nothing is looked up for a server of the install\'s own at startup', () => {
  assert.equal(calls.filter(call => call.url.hostname === 'plex.example').length, 0);
});

test('any account can sign in, the plugin chooses the server, and nothing is saved', async () => {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const poll = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: cookieFrom(start, 'freeStuffCrazyPlayerLogin') });
  assert.equal(poll.json.authenticated, true);
  const cookie = cookieFrom(poll, 'freeStuffCrazyPlayerSession');
  assert.equal((await request('/api/auth/me', { cookie })).status, 200);
  assert.equal(existsSync(path.join(temporary, '.plex-link.json')), false, 'nothing is saved');
  assert.ok(!calls.some(call => call.token === 'stranger-token' && call.url.pathname === '/:/prefs'));
});
