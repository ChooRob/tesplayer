import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// What a stats plugin can observe: sign-ins (not profile switches), watch time
// as it is counted, and who is playing right now. Plex and plex.tv are mocked.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-stats-hooks-'));
const pluginPath = path.join(temporary, 'stats-plugin.js');
writeFileSync(pluginPath, `
globalThis.__events = { signIns: [], usage: [], ctx: null };
export default {
  getQuotaStatus() { return { remainingSeconds: 3600, resetAt: '2026-11-23T00:00:00.000Z' }; },
  recordUsage() {},
  registerRoutes(_app, context) {
    globalThis.__events.ctx = context;
    context.onSignIn(event => globalThis.__events.signIns.push(event));
    context.onUsage((key, seconds) => globalThis.__events.usage.push([key, seconds]));
    context.onSignIn(() => { throw new Error('a broken observer must not break sign-in'); });
  },
};
`);
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: 'owner@example.test',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '',
  FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href, FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: '',
});

const originalFetch = globalThis.fetch;
let pinSequence = 300;
globalThis.fetch = async (value) => {
  const url = new URL(value);
  const p = url.pathname;
  const json = body => Response.json(body);
  if (p === '/identity') return json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (p === '/:/prefs') return json({ MediaContainer: { Setting: [] } });
  if (p === '/api/v2/pins') return json({ id: ++pinSequence, code: 'TEST' });
  if (/^\/api\/v2\/pins\/\d+$/.test(p)) return json({ authToken: 'test-account-token' });
  if (p === '/api/v2/home/users') return json({ users: [{ id: 10, title: 'Owner', admin: true }] });
  if (p === '/api/home/users/10/switch') return json({ authToken: 'switched-token' });
  if (p === '/api/v2/user') return json({ id: 1, username: 'Owner', email: 'Owner@Example.test', confirmed: true });
  if (p === '/api/v2/resources') return json([{ clientIdentifier: 'test-server', provides: 'server', owned: true, accessToken: 'test-server-token' }]);
  if (p === '/library/metadata/5') return json({ MediaContainer: { Metadata: [{ ratingKey: '5', type: 'movie', title: 'Test Movie', duration: 100000 }] } });
  if (p === '/video/:/transcode/universal/decision') return json({ MediaContainer: {} });
  if (p === '/video/:/transcode/universal/start.m3u8') {
    const session = url.searchParams.get('session');
    return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nsession/${session}/base/index.m3u8\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (p === '/video/:/transcode/universal/stop') return new Response('');
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
const events = () => globalThis.__events;

let cookie;
test('a sign-in is reported once, with the backend and an opaque user key', async () => {
  const start = await request('/api/auth/plex/pin', { method: 'POST' });
  const poll = await request(`/api/auth/plex/poll?id=${start.json.id}`, { cookie: cookieFrom(start, 'freeStuffCrazyPlayerLogin') });
  assert.equal(poll.json.authenticated, true);
  cookie = cookieFrom(poll, 'freeStuffCrazyPlayerSession');
  assert.deepEqual(events().signIns, [{ sourceType: 'plex', userKey: 'plex:1' }]);
});

test('switching profile is not a new sign-in', async () => {
  const switched = await request('/api/auth/switch-user', { method: 'POST', body: { userId: '10' }, cookie });
  assert.equal(switched.status, 200, switched.text);
  assert.equal(events().signIns.length, 1);
});

test('watch time and live streams are visible to a plugin', async () => {
  cookie = cookieFrom(await request('/api/auth/switch-user', { method: 'POST', body: { userId: '10' }, cookie }), 'freeStuffCrazyPlayerSession') || cookie;
  const started = await request('/api/start?key=5&quality=low&playbackId=stats-play', { cookie });
  assert.equal(started.status, 200, started.text);
  assert.deepEqual(events().ctx.activeStreams(), [], 'not counted until the player reports it is playing');
  const first = await request('/api/playback/usage', { method: 'POST', body: { playbackId: 'stats-play', state: 'playing' }, cookie });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(events().ctx.activeStreams(), [{ accountKey: 'plex:1' }]);
  await new Promise(resolve => setTimeout(resolve, 2300));
  await request('/api/playback/usage', { method: 'POST', body: { playbackId: 'stats-play', state: 'paused' }, cookie });
  const counted = events().usage.filter(([key]) => key === 'plex:1');
  assert.ok(counted.length >= 1, 'the counted seconds were reported');
  assert.ok(counted.reduce((sum, [, seconds]) => sum + seconds, 0) >= 1.5);
  assert.deepEqual(events().ctx.activeStreams(), [], 'paused is no longer playing');
});
