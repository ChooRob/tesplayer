import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';

process.env.SESSION_SECRET ||= 'test-only-secret-with-at-least-32-characters';
const { createJellyfinSource } = await import('../jellyfin-source.js');

// A signed-out visitor can type a server address (with a jellyfinServers plugin), so what that
// server answers with, before anyone has signed in, must be read with a limit.
const stats = { chunks: 0, cancelled: false };
const endlessBody = () => new ReadableStream({
  pull(controller) { stats.chunks++; controller.enqueue(new Uint8Array(16 * 1024).fill(32)); },
  cancel() { stats.cancelled = true; },
});
const jellyfinServers = {
  resolve: async address => new URL(address).origin,
  fetch: async () => new Response(endlessBody(), { headers: { 'Content-Type': 'application/json' } }),
};
const store = { collection: () => ({ get: async () => undefined, update: async () => {}, set: async () => {}, entries: async () => [] }) };
const config = { plex: { productName: 'Test Player', videoBitrate: 4000 }, auth: { sessionDays: 1, secureCookies: false } };
const source = await createJellyfinSource({
  config, plugins: [{ jellyfinServers }], store, pipeUpstream() {},
  env: { SESSION_SECRET: process.env.SESSION_SECRET }, // no JELLYFIN_URL: users bring their own server
});

const app = express();
app.use(express.json());
app.use((req, res, next) => source.auth.loadSession(req, res, next));
source.registerRoutes(app, { rateLimit: () => (_req, _res, next) => next() });
const server = await new Promise(resolve => { const s = createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
after(() => server.close());

test('a typed Jellyfin server cannot make sign-in read an unbounded response', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/jellyfin/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server: 'https://huge.example' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Could not reach a Jellyfin server/);
  assert.ok(stats.cancelled, 'the body was dropped');
  assert.ok(stats.chunks < 40, `read ${stats.chunks} chunks of an endless body`);
});
