import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// Owner-only calls (accounts(), used to personalize Continue Watching) must use the
// signed-in *account's* token, not the Home profile's: a child profile's token is not
// allowed to list every PMS account and the call fails closed. This test uses a
// minimal stand-in resolveServer plugin that resolves to its own connection URI.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-resolve-server-test-'));
const pluginPath = path.join(temporary, 'stub-resolve-server-plugin.js');
writeFileSync(pluginPath, `export default { resolveServer: async () => (
  { ok: true, plexUrl: 'https://alt-connection.example', machineIdentifier: 'test-server' }
) };\n`);
const pluginUrl = new URL(`file://${pluginPath}`).href;
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '', FREESTUFFCRAZY_PLUGIN_MODULES: pluginUrl,
});
writeFileSync(path.join(temporary, '.sessions.json'), '{}', { mode: 0o644 });

const originalFetch = globalThis.fetch;
let pinSequence = 200;
const calls = [];
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  calls.push({ url, options });
  const json = (value, init) => Response.json(value, init);
  if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (url.pathname === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (url.pathname === '/api/v2/pins') return json({ id: ++pinSequence, code: 'test-code' });
  if (/^\/api\/v2\/pins\/\d+$/.test(url.pathname)) return json({ authToken: 'test-account-token' });
  if (url.pathname === '/api/v2/home/users') {
    return json({ users: [{ id: 10, title: 'Owner', admin: true }, { id: 20, title: 'Child' }] });
  }
  if (url.pathname === '/api/home/users/20/switch') return json({ authToken: 'test-child-token' });
  // Deliberately offers a *different* URI than PLEX_URL for the same
  // physical server, same as a real account's own resources listing can.
  if (url.pathname === '/api/v2/resources') {
    return json([{
      clientIdentifier: 'test-server', owned: true, provides: 'server',
      connections: [{ uri: 'https://alt-connection.example', local: false, relay: false }],
    }]);
  }
  if (url.pathname === '/accounts') {
    // Only the account's own token may list every PMS account -- the regression
    // this test guards against sent the signed-in child profile's token instead.
    if (options.headers?.['X-Plex-Token'] !== 'test-account-token') return new Response('restricted', { status: 401 });
    return json({ MediaContainer: { Account: [{ id: 1, name: 'Owner' }, { id: 20, name: 'Child' }] } });
  }
  if (url.pathname === '/status/sessions/history/all') return json({ MediaContainer: { Metadata: [] } });
  if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [] } });
  throw new Error(`Unexpected mocked upstream request: ${url.pathname}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { method = 'GET', body, cookie = '', origin = 'https://dash.example' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    const payload = body === undefined ? null : JSON.stringify(body);
    req.headers = { host: 'dash.example', origin, cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    const res = new ServerResponse(req);
    res.end = function (chunk) {
      const text = chunk ? chunk.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), text, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];

test('a child profile still gets personalized next-up, because owner-only lookups use the account token, not the profile\'s', async () => {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const loginCookie = cookieFrom(start, 'freeStuffCrazyPlayerLogin');
  const picker = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: loginCookie });
  const selection = await request('/api/auth/plex/select-user', {
    method: 'POST', cookie: cookieFrom(picker, 'freeStuffCrazyPlayerLogin'), body: { pinId: start.json.id, userId: '20' },
  });
  assert.equal(selection.status, 200);
  assert.equal(selection.json.authenticated, true);
  const sessionCookie = cookieFrom(selection, 'freeStuffCrazyPlayerSession');

  // Confirm the premise: this session really did resolve to the alternate
  // URI, not PLEX_URL -- otherwise this test isn't exercising the bug.
  const me = await request('/api/auth/me', { cookie: sessionCookie });
  assert.equal(me.status, 200);

  const ondeck = await request('/api/plex/ondeck', { cookie: sessionCookie });
  assert.equal(ondeck.status, 200, `expected personalized ondeck to succeed, got: ${ondeck.text}`);

  const accountsCall = calls.find((call) => call.url.pathname === '/accounts');
  assert.ok(accountsCall, 'expected an /accounts lookup to personalize Continue Watching');
  assert.equal(accountsCall.url.hostname, 'alt-connection.example', 'owner-only /accounts goes to the server the session resolved to');
  assert.equal(accountsCall.options.headers['X-Plex-Token'], 'test-account-token', 'owner-only /accounts must use the account\'s token, not the signed-in profile\'s own token');
  assert.equal(accountsCall.options.headers['X-Plex-Device'], accountsCall.options.headers['X-Plex-Product']);
  assert.equal(accountsCall.options.headers['X-Plex-Device-Name'], accountsCall.options.headers['X-Plex-Product']);
});
