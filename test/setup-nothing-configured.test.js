import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// No Plex and a malformed JELLYFIN_URL: the server still starts, shows only
// the login page, and that page is told what to fix.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-setup-test-'));
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: 'test-only-secret-with-at-least-32-characters',
  PLEX_TOKEN: '', PLEX_URL: '', JELLYFIN_URL: 'https://admin:hunter2@jellyfin.example.com', JELLYFIN_NAME: '',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '', FREESTUFFCRAZY_PLUGIN_MODULES: '', FREESTUFFCRAZY_ADMIN: '',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (value) => { throw new Error(`Unexpected request to ${value}`); };
const originalError = console.error;
const logged = [];
console.error = (...args) => logged.push(args.join(' '));
const { app } = await import('../server.js');
console.error = originalError;
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = 'GET';
    req.headers = { host: 'dash.example', origin: 'https://dash.example' };
    const res = new ServerResponse(req);
    res.end = function (chunk) {
      const text = chunk ? chunk.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), text, json: /^[[{]/.test(text) ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    req.push(null);
  });
}

test('the problem is logged at startup without the configured value', () => {
  assert.ok(logged.some(line => /Setup: JELLYFIN_URL must be/.test(line)));
  assert.ok(!logged.join('\n').includes('hunter2'));
});

test('the login page loads and is told what to fix; nothing else is served', async () => {
  const login = await request('/login');
  assert.equal(login.status, 200);
  assert.match(String(login.headers['content-type']), /text\/html/);
  const setup = await request('/api/auth/setup');
  assert.equal(setup.json.problems.length, 1);
  assert.match(setup.json.problems[0], /JELLYFIN_URL must be/);
  assert.ok(!JSON.stringify(setup.json).includes('hunter2'), 'the value is never shown');
  assert.deepEqual((await request('/api/auth/sources')).json, []);
  const api = await request('/api/library/libraries');
  assert.equal(api.status, 503);
  assert.equal(api.json.error, 'FreeStuffCrazy Player is not set up yet');
  const page = await request('/browse');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
});
