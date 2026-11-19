import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCookieSealer } from '../session-cookie.js';

// In production the server must not log every healthy playback report. The
// real server runs in production mode here; Plex and plex.tv are mocked.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-prod-logging-'));
const SECRET = 'test-only-secret-with-at-least-32-characters';
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'production', SESSION_SECRET: SECRET,
  PLEX_URL: 'https://plex.example', PLEX_CLIENT_ID: 'test-client', PLEX_EMAIL: 'owner@example.test',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '127.0.0.1', FREESTUFFCRAZY_PLUGINS_DIR: '', FREESTUFFCRAZY_PLUGIN_MODULES: '',
  EMBY_URL: '', JELLYFIN_URL: '', FREESTUFFCRAZY_ADMIN: '', FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: '',
});

// The owner has signed in before: the server's address and ID are saved.
writeFileSync(path.join(temporary, '.plex-link.json'), JSON.stringify({ owner: { url: 'https://plex.example', machineIdentifier: 'test-server' } }), { mode: 0o600 });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (value) => {
  const p = new URL(value).pathname;
  if (p === '/identity') return Response.json({ MediaContainer: { machineIdentifier: 'test-server' } });
  if (p === '/:/prefs') return Response.json({ MediaContainer: { Setting: [] } });
  throw new Error(`Unexpected mocked upstream request: ${p}`);
};
const infos = [];
const originalInfo = console.info;
console.info = (...args) => { infos.push(args.join(' ')); };
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; console.info = originalInfo; rmSync(temporary, { recursive: true, force: true }); });

const cookie = `freeStuffCrazyPlayerSession=${createCookieSealer(SECRET).seal('session', {
  v: 3, sid: 'prod-session', accountId: 1, generation: 0, accountToken: 'a', userToken: 'b', title: 'Viewer',
  profileId: '10', plexUrl: 'https://plex.example', machineIdentifier: 'test-server', renewedAt: Date.now(),
}, 60000)}`;

function post(url, body) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new IncomingMessage(socket);
    const payload = JSON.stringify(body);
    req.url = url; req.method = 'POST';
    req.headers = { host: 'dash.example', origin: 'https://dash.example', cookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-forwarded-proto': 'https' };
    const res = new ServerResponse(req);
    res.write = () => true;
    res.end = function () { resolve(res.statusCode); res.emit('finish'); return res; };
    app.handle(req, res, reject);
    req.push(payload);
    req.push(null);
  });
}
const healthFile = path.join(temporary, 'canvas-health.log');
const fileLines = () => (existsSync(healthFile) ? readFileSync(healthFile, 'utf8').trim().split('\n').filter(Boolean) : []);
const report = (state, extra = {}) => post('/api/playback/canvas-health', { playbackId: 'abc-123', state, mediaTime: 10, quality: 'high', ...extra });

test('healthy "playing" reports are not logged in production', async () => {
  for (let i = 0; i < 5; i++) assert.equal(await report('playing'), 204);
  assert.equal(infos.filter(line => line.startsWith('[canvas-health]')).length, 0, 'nothing on the console');
  assert.equal(fileLines().length, 0, 'nothing in the health file');
});

test('a buffering report is kept in the file but not printed', async () => {
  assert.equal(await report('buffering'), 204);
  assert.equal(infos.filter(line => line.startsWith('[canvas-health]')).length, 0);
  assert.equal(fileLines().length, 1);
  assert.match(fileLines()[0], /"state":"buffering"/);
});

test('a failure is printed and kept, with the reason', async () => {
  assert.equal(await report('error', { error: 'EncodingError: truncated packet' }), 204);
  const printed = infos.filter(line => line.startsWith('[canvas-health]'));
  assert.equal(printed.length, 1);
  assert.match(printed[0], /truncated packet/);
  assert.equal(fileLines().length, 2);
});

test('a playing heartbeat leaves a marker a deploy script can read, a paused one does not', async () => {
  const marker = path.join(temporary, '.playback-active');
  assert.equal(existsSync(marker), false);
  assert.equal(await post('/api/playback/usage', { playbackId: 'abc-123', state: 'paused' }), 200);
  assert.equal(existsSync(marker), false, 'paused is not playing');
  assert.equal(await post('/api/playback/usage', { playbackId: 'abc-123', state: 'playing' }), 200);
  assert.equal(existsSync(marker), true);
  const first = statSync(marker).mtimeMs;
  assert.ok(Date.now() - first < 5000, 'the marker is fresh');
  assert.equal(await post('/api/playback/usage', { playbackId: 'abc-123', state: 'playing' }), 200);
  assert.equal(statSync(marker).mtimeMs, first, 'it is not rewritten on every heartbeat');
});
