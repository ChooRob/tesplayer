import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlexUrl } from '../plex-connection.js';

const originalFetch = globalThis.fetch;
// Probe timeouts don't hold the process open; a running server always does.
const keepAlive = setInterval(() => {}, 50);
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => clearInterval(keepAlive));

// A fake plex.tv plus servers: `answers` maps an address to how many ms it
// takes to answer as this server; any other address never answers.
function fakePlex(connections, answers) {
  const aborted = [];
  globalThis.fetch = async (value, options = {}) => {
    const url = new URL(value);
    if (url.hostname === 'plex.tv') return Response.json([{ provides: 'server', owned: true, clientIdentifier: 'mine', connections }]);
    return new Promise((resolve, reject) => {
      if (url.origin in answers) setTimeout(() => resolve(Response.json({ MediaContainer: { machineIdentifier: 'mine' } })), answers[url.origin]);
      options.signal.addEventListener('abort', () => { aborted.push(url.origin); reject(new Error('aborted')); }, { once: true });
    });
  };
  return aborted;
}
const options = { token: 't', clientId: 'c', productName: 'p', timeoutMs: 500 };
const remote = { uri: 'https://remote.example', local: false, relay: false };
const docker = { uri: 'https://docker.example', local: true, relay: false };
const lan = { uri: 'https://lan.example', local: true, relay: false };
const relay = { uri: 'https://relay.example', local: false, relay: true };

test('direct addresses are tried at once and the first to answer is used, local or remote', async () => {
  fakePlex([remote, docker, lan, relay], { 'https://remote.example': 60, 'https://lan.example': 5, 'https://relay.example': 30 });
  assert.equal(await resolvePlexUrl(options), 'https://lan.example');
  fakePlex([remote, docker, lan, relay], { 'https://remote.example': 5, 'https://lan.example': 60 });
  assert.equal(await resolvePlexUrl(options), 'https://remote.example');
});

test('a faster relay never beats a direct address that answers', async () => {
  fakePlex([relay, remote], { 'https://relay.example': 1, 'https://remote.example': 60 });
  assert.equal(await resolvePlexUrl(options), 'https://remote.example');
});

test('relay is used when no direct address answers', async () => {
  fakePlex([remote, docker, lan, relay], { 'https://relay.example': 5 });
  assert.equal(await resolvePlexUrl(options), 'https://relay.example');
});

test('a dead address listed first holds nothing up, and the losers are cancelled', async () => {
  const aborted = fakePlex([docker, remote, lan], { 'https://lan.example': 5, 'https://remote.example': 200 });
  const started = Date.now();
  assert.equal(await resolvePlexUrl(options), 'https://lan.example');
  assert.ok(Date.now() - started < 150, 'no waiting on dead or slower addresses');
  assert.ok(aborted.includes('https://docker.example'));
  assert.ok(aborted.includes('https://remote.example'));
});

test('PLEX_URL still comes first when it answers', async () => {
  fakePlex([remote, relay], { 'https://configured.example': 50, 'https://remote.example': 1 });
  assert.equal(await resolvePlexUrl({ ...options, preferredUrl: 'https://configured.example' }), 'https://configured.example');
});
