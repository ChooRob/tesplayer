import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// An account with several Plex servers chooses one after signing in, and can change
// later. The real server runs with a stand-in plugin that lists servers; plex.tv and
// the servers are mocked.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-server-choice-'));
const pluginPath = path.join(temporary, 'chooser-plugin.js');
writeFileSync(pluginPath, `
export default {
  async listServers(token) {
    globalThis.__lists.push(token);
    if (globalThis.__listFails) throw new Error('plex.tv hiccup');
    return { ok: true, servers: globalThis.__servers };
  },
  async resolveServer(token, options = {}) {
    globalThis.__resolves.push({ token, options });
    const servers = globalThis.__servers;
    const pick = options.serverId ? servers.find(s => s.id === options.serverId)
      : options.machineIdentifier ? servers.find(s => s.id === options.machineIdentifier)
      : servers.find(s => s.online);
    if (!pick) return { ok: false, error: options.serverId ? 'That server is not available to this account' : 'None of your Plex servers are reachable right now' };
    return { ok: true, plexUrl: 'https://' + pick.id + '.example', machineIdentifier: pick.id, accessToken: 'token-for-' + pick.id, serverName: pick.name };
  },
};
`);
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: '',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '',
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: '', FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href,
});
const one = { id: 'one', name: 'Server One', owned: true, sharedBy: null, online: true, relayOnly: false };
const two = { id: 'two', name: 'Server Two', owned: false, sharedBy: 'Sam', online: true, relayOnly: false };
const three = { id: 'three', name: 'Server Three', owned: false, sharedBy: 'Jo', online: false, relayOnly: false };
Object.assign(globalThis, { __lists: [], __resolves: [], __servers: [one, two], __listFails: false, __users: [{ id: 10, title: 'Owner', admin: true }] });

const originalFetch = globalThis.fetch;
let pinSequence = 1000;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  const p = url.pathname;
  const json = body => Response.json(body);
  if (p === '/identity') return json({ MediaContainer: { machineIdentifier: 'startup-server' } });
  if (p === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (p === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(p)) return json({ authToken: 'account-token' });
  if (p === '/api/v2/home/users') return json({ users: globalThis.__users });
  if (p === '/api/v2/user') return json({ id: 1, username: 'Owner', email: 'owner@example.test', confirmed: true });
  if (/^\/api\/home\/users\/\d+\/switch$/.test(p)) return json({ authToken: `switched-${p.split('/')[4]}` });
  // Each server answers its library with its own name, so the test can see which one was used.
  if (p === '/library/sections' && url.hostname.endsWith('.example') && url.hostname !== 'plex.example') {
    return json({ MediaContainer: { Directory: [{ key: '1', title: `Movies on ${url.hostname.split('.')[0]}`, type: 'movie' }] } });
  }
  if (p === '/accounts' || p === '/status/sessions/history/all') return json({ MediaContainer: { Account: [], Metadata: [] } });
  throw new Error(`Unexpected mocked upstream request: ${url.hostname}${p}`);
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
const reset = ({ servers = [one, two], users = [{ id: 10, title: 'Owner', admin: true }], listFails = false } = {}) => {
  Object.assign(globalThis, { __lists: [], __resolves: [], __servers: servers, __users: users, __listFails: listFails });
};
async function poll() {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const loginCookie = cookieFrom(start, 'freeStuffCrazyPlayerLogin');
  const result = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: loginCookie });
  return { pinId: String(start.json.id), result, loginCookie: cookieFrom(result, 'freeStuffCrazyPlayerLogin') || loginCookie };
}
const libraryTitle = async cookie => (await request('/api/library/libraries', { cookie })).json?.[0]?.title;

test('an account with several servers online is asked to choose, and sees only what it needs', async () => {
  reset();
  const { pinId, result } = await poll();
  assert.equal(result.json.authenticated, false);
  assert.equal(result.json.needsServerSelection, true);
  assert.equal(result.json.pinId, pinId);
  assert.deepEqual(result.json.servers, [one, two]);
  assert.equal(cookieFrom(result, 'freeStuffCrazyPlayerSession'), undefined, 'no session until a server is chosen');
  assert.ok(!result.text.includes('account-token') && !result.text.includes('token-for-'), 'no token reaches the page');
});

test('choosing a server finishes the sign-in on that server, which is then shown in the menu', async () => {
  reset();
  const { pinId, loginCookie } = await poll();
  const picked = await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId, serverId: 'two' }, cookie: loginCookie });
  assert.equal(picked.json.authenticated, true, picked.text);
  const cookie = cookieFrom(picked, 'freeStuffCrazyPlayerSession');
  assert.equal(await libraryTitle(cookie), 'Movies on two', 'the library comes from the chosen server');
  const me = await request('/api/auth/me', { cookie });
  assert.deepEqual(me.json.server, { name: 'Server Two', switchable: true });
  assert.equal(globalThis.__resolves.at(-1).options.serverId, 'two');
  // The same sign-in cannot be used again.
  const again = await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId, serverId: 'one' }, cookie: loginCookie });
  assert.equal(again.json.authenticated, undefined);
  assert.equal(again.status, 502);
});

test('a choice needs a sign-in that is waiting for one, and can only be one of the account\'s servers', async () => {
  reset();
  const first = await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId: '1', serverId: 'one' } });
  assert.equal(first.status, 502, 'no sign-in in progress');
  assert.equal((await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId: '1' } })).status, 400);
  const { pinId, loginCookie } = await poll();
  const stranger = await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId, serverId: 'someone-elses' }, cookie: loginCookie });
  assert.equal(stranger.json.authenticated, false);
  assert.equal(stranger.json.error, 'That server is not available to this account');
});

test('with only one server answering there is nothing to choose, and with none there is a clear message', async () => {
  reset({ servers: [one, { ...two, online: false }] });
  const only = await poll();
  assert.equal(only.result.json.authenticated, true, 'went straight to the one that answers');
  assert.equal(await libraryTitle(cookieFrom(only.result, 'freeStuffCrazyPlayerSession')), 'Movies on one');

  reset({ servers: [{ ...one, online: false }, { ...three }] });
  const none = await poll();
  assert.equal(none.result.json.authenticated, false);
  assert.equal(none.result.json.error, 'None of your Plex servers are reachable right now');
});

test('an account with one server, or a listing that fails, signs in as before', async () => {
  reset({ servers: [one] });
  const single = await poll();
  assert.equal(single.result.json.authenticated, true);
  const me = await request('/api/auth/me', { cookie: cookieFrom(single.result, 'freeStuffCrazyPlayerSession') });
  assert.equal(me.json.server.switchable, false, 'nothing to switch to');

  reset({ listFails: true });
  const failing = await poll();
  assert.equal(failing.result.json.authenticated, true, 'a failed listing never blocks sign-in');
  assert.equal(globalThis.__resolves.at(-1).options.serverId, undefined, 'no server was chosen: the first one that answers is used');
});

test('a Home profile is chosen first, and the servers shown are that profile\'s', async () => {
  reset({ users: [{ id: 10, title: 'Owner', admin: true }, { id: 20, title: 'Kid' }] });
  const { pinId, result, loginCookie } = await poll();
  assert.equal(result.json.needsUserSelection, true, 'profiles come before servers');
  const picked = await request('/api/auth/plex/select-user', { method: 'POST', body: { pinId, userId: '20' }, cookie: loginCookie });
  assert.equal(picked.json.needsServerSelection, true);
  assert.deepEqual(globalThis.__lists.at(-1), 'switched-20', 'the servers listed are those the Kid profile can reach');
  const chosen = await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId, serverId: 'one' }, cookie: cookieFrom(picked, 'freeStuffCrazyPlayerLogin') });
  assert.equal(chosen.json.authenticated, true, chosen.text);
  const cookie = cookieFrom(chosen, 'freeStuffCrazyPlayerSession');
  const me = await request('/api/auth/me', { cookie });
  assert.equal(me.json.title, 'Kid', 'signed in as the profile that was picked');
  assert.equal(globalThis.__resolves.at(-1).token, 'switched-20', 'with that profile\'s own token');
});

test('a signed-in profile lists its servers, and switching moves the session without a new sign-in', async () => {
  reset();
  const { pinId, loginCookie } = await poll();
  const cookie = cookieFrom(await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId, serverId: 'one' }, cookie: loginCookie }), 'freeStuffCrazyPlayerSession');
  assert.equal((await request('/api/auth/plex/servers')).status, 401, 'signed out: nothing is listed');
  const listed = await request('/api/auth/plex/servers', { cookie });
  assert.deepEqual(listed.json, { servers: [one, two], current: 'one' });

  const switched = await request('/api/auth/plex/switch-server', { method: 'POST', body: { serverId: 'two' }, cookie });
  assert.equal(switched.json.ok, true, switched.text);
  const moved = cookieFrom(switched, 'freeStuffCrazyPlayerSession');
  assert.equal(await libraryTitle(moved), 'Movies on two');
  assert.deepEqual((await request('/api/auth/me', { cookie: moved })).json.server, { name: 'Server Two', switchable: true });

  const refused = await request('/api/auth/plex/switch-server', { method: 'POST', body: { serverId: 'not-mine' }, cookie: moved });
  assert.equal(refused.status, 502);
  assert.equal(refused.json.error, 'That server is not available to this account', 'a fixed message, never plugin internals');
  assert.equal((await request('/api/auth/plex/switch-server', { method: 'POST', body: {}, cookie: moved })).status, 400);
  assert.equal((await request('/api/auth/plex/switch-server', { method: 'POST', body: { serverId: 'two' } })).status, 401);
});

test('switching profile later stays on the server that was chosen', async () => {
  reset({ users: [{ id: 10, title: 'Owner', admin: true }, { id: 20, title: 'Kid' }] });
  const { pinId, loginCookie } = await poll();
  const picked = await request('/api/auth/plex/select-user', { method: 'POST', body: { pinId, userId: '10' }, cookie: loginCookie });
  const chosen = await request('/api/auth/plex/select-server', { method: 'POST', body: { pinId, serverId: 'two' }, cookie: cookieFrom(picked, 'freeStuffCrazyPlayerLogin') });
  const cookie = cookieFrom(chosen, 'freeStuffCrazyPlayerSession');
  const changed = await request('/api/auth/switch-user', { method: 'POST', body: { userId: '20' }, cookie });
  assert.equal(changed.json.ok, true, changed.text);
  const kid = cookieFrom(changed, 'freeStuffCrazyPlayerSession');
  assert.equal(await libraryTitle(kid), 'Movies on two');
  const me = await request('/api/auth/me', { cookie: kid });
  assert.deepEqual(me.json.server, { name: 'Server Two', switchable: true });
  assert.equal(me.json.title, 'Kid');
});

// The pages cannot be run here, so check they are wired to the routes the server offers.
test('the login page and the user menu use the server-choice routes', async () => {
  const { readFileSync } = await import('node:fs');
  const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  const login = read('login.html');
  assert.match(login, /needsServerSelection/);
  assert.match(login, /\/api\/auth\/plex\/select-server/);
  assert.match(login, /Remember on this device/);
  const badge = read('user-badge.js');
  assert.match(badge, /\/api\/auth\/plex\/servers/);
  assert.match(badge, /\/api\/auth\/plex\/switch-server/);
  assert.match(badge, /Switch server/);
});
