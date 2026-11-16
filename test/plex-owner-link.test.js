import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerLink } from '../plex-owner-link.js';

const memory = (initial = {}) => {
  const docs = new Map(Object.entries(initial));
  return { get: async id => docs.get(id), set: async (id, value) => { docs.set(id, value); }, docs };
};
const quiet = { log() {}, warn() {} };
const originalFetch = globalThis.fetch;
const identity = id => async () => Response.json({ MediaContainer: { machineIdentifier: id } });
const resolveTo = url => async () => url;

test('a PLEX_TOKEN in the environment is used as before and never saved', async () => {
  globalThis.fetch = identity('srv');
  try {
    const collection = memory();
    const linked = [];
    const link = createOwnerLink({ env: { PLEX_TOKEN: 'env-token' }, collection, clientId: 'c', productName: 'P',
      resolve: resolveTo('https://plex.example'), onLinked: owner => linked.push({ ...owner }), log: quiet });
    await link.restore();
    assert.deepEqual(link.owner, { token: 'env-token', url: 'https://plex.example', machineIdentifier: 'srv' });
    assert.equal(linked.length, 1);
    assert.equal(collection.docs.size, 0);
    await link.refresh('another-token');
    assert.equal(link.owner.token, 'env-token', 'an environment token is never replaced');
    assert.equal(collection.docs.size, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('an environment token that cannot reach Plex stops startup', async () => {
  const link = createOwnerLink({ env: { PLEX_TOKEN: 'env-token' }, collection: memory(), clientId: 'c', productName: 'P',
    resolve: async () => { throw new Error('No reachable connection found for this Plex server'); }, log: quiet });
  await assert.rejects(() => link.restore(), /No reachable connection/);
});

test('with no token anywhere it waits for the owner, and a sign-in saves the token', async () => {
  globalThis.fetch = identity('srv');
  try {
    const collection = memory();
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P', resolve: resolveTo('https://plex.example'), verifyOwner: async () => true, log: quiet });
    await link.restore();
    assert.equal(link.owner.url, null);
    await link.connect('owner-token', { remember: true });
    assert.equal(link.owner.url, 'https://plex.example');
    assert.equal(collection.docs.get('owner').token, 'owner-token');
    await link.refresh('newer-token');
    assert.equal(link.owner.token, 'newer-token');
    assert.equal(collection.docs.get('owner').token, 'newer-token');
  } finally { globalThis.fetch = originalFetch; }
});

test('a saved token is used on the next start without anyone signing in', async () => {
  globalThis.fetch = identity('srv');
  try {
    const collection = memory({ owner: { token: 'saved-token', savedAt: 1 } });
    const used = [];
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P',
      resolve: async ({ token }) => { used.push(token); return 'https://plex.example'; }, verifyOwner: async () => true, log: quiet });
    await link.restore();
    assert.deepEqual(used, ['saved-token']);
    assert.equal(link.owner.url, 'https://plex.example');
  } finally { globalThis.fetch = originalFetch; }
});

test('a saved token that cannot reach Plex yet is retried until it can', async () => {
  globalThis.fetch = identity('srv');
  try {
    let attempts = 0;
    const link = createOwnerLink({ env: {}, collection: memory({ owner: { token: 'saved-token' } }), clientId: 'c', productName: 'P', retryMs: 5,
      resolve: async () => { if (++attempts < 3) throw new Error('down'); return 'https://plex.example'; }, verifyOwner: async () => true, log: quiet });
    await link.restore();
    assert.equal(link.owner.url, null, 'not linked while Plex is unreachable');
    await new Promise(resolve => { const timer = setInterval(() => { if (link.owner.url) { clearInterval(timer); resolve(); } }, 5); });
    assert.equal(link.owner.url, 'https://plex.example');
    assert.ok(attempts >= 3);
    const before = attempts;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(attempts, before, 'retrying stops once linked');
  } finally { globalThis.fetch = originalFetch; }
});

test('an owner sign-in while a saved token is failing links with the fresh token', async () => {
  globalThis.fetch = identity('srv');
  try {
    const link = createOwnerLink({ env: {}, collection: memory({ owner: { token: 'revoked' } }), clientId: 'c', productName: 'P', retryMs: 5,
      resolve: async ({ token }) => { if (token === 'revoked') throw new Error('unauthorized'); return 'https://plex.example'; }, verifyOwner: async () => true, log: quiet });
    await link.restore();
    await link.connect('fresh-token', { remember: true });
    assert.equal(link.owner.token, 'fresh-token');
    assert.equal(link.owner.url, 'https://plex.example');
  } finally { globalThis.fetch = originalFetch; }
});

test('an account that does not own the server cannot become its credential', async () => {
  globalThis.fetch = identity('srv');
  try {
    const collection = memory();
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P', resolve: resolveTo('https://plex.example'),
      verifyOwner: async (_token, machineIdentifier) => machineIdentifier === 'someone-elses-server', log: quiet });
    await assert.rejects(() => link.connect('friend-token', { remember: true }), /does not own that server/);
    assert.equal(link.owner.url, null);
    assert.equal(collection.docs.size, 0, 'nothing is saved');
  } finally { globalThis.fetch = originalFetch; }
});
