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

test('it waits for the owner, and a sign-in saves the server but not the token', async () => {
  globalThis.fetch = identity('srv');
  try {
    const collection = memory();
    const seen = [];
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P', resolve: resolveTo('https://plex.example'), verifyOwner: async () => true,
      onOwnerToken: (_owner, token) => seen.push(token), log: quiet });
    await link.restore();
    assert.equal(link.owner.url, null);
    await link.connect('owner-token', { remember: true });
    assert.deepEqual({ ...link.owner }, { url: 'https://plex.example', machineIdentifier: 'srv' });
    const saved = collection.docs.get('owner');
    assert.equal(saved.url, 'https://plex.example');
    assert.equal(saved.machineIdentifier, 'srv');
    assert.ok(!JSON.stringify(saved).includes('owner-token'), 'the token is not saved');
    assert.deepEqual(seen, ['owner-token'], 'the token is offered once, to use and forget');
    await link.refresh('newer-token');
    assert.equal('token' in link.owner, false, 'a later sign-in does not keep its token either');
    assert.ok(!JSON.stringify(collection.docs.get('owner')).includes('newer-token'));
  } finally { globalThis.fetch = originalFetch; }
});

test('a saved server is used on the next start with no token and no network', async () => {
  globalThis.fetch = async () => { throw new Error('nothing may be contacted'); };
  try {
    const collection = memory({ owner: { url: 'https://plex.example', machineIdentifier: 'srv', savedAt: 1 } });
    const linked = [];
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P', resolve: async () => { throw new Error('nothing may be resolved'); },
      onLinked: owner => linked.push({ ...owner }), log: quiet });
    await link.restore();
    assert.deepEqual({ ...link.owner }, { url: 'https://plex.example', machineIdentifier: 'srv' });
    assert.equal(linked.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('a moved server is followed at the owner\'s next sign-in, and only if it is the same server', async () => {
  globalThis.fetch = async url => Response.json({ MediaContainer: { machineIdentifier: String(url).startsWith('https://moved.example') ? 'srv' : 'other' } });
  try {
    const collection = memory({ owner: { url: 'https://old.example', machineIdentifier: 'srv' } });
    let answer = 'https://moved.example';
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P', resolve: async () => answer, log: quiet });
    await link.restore();
    await link.refresh('owner-token');
    assert.equal(link.owner.url, 'https://moved.example');
    assert.equal(collection.docs.get('owner').url, 'https://moved.example');
    answer = 'https://impostor.example';
    await link.refresh('owner-token');
    assert.equal(link.owner.url, 'https://moved.example', 'an address that is a different server is ignored');
    answer = null;
    await link.refresh('owner-token');
    assert.equal(link.owner.url, 'https://moved.example', 'an unreachable server keeps the saved address');
  } finally { globalThis.fetch = originalFetch; }
});

test('a token saved by an earlier version is used once, then only the server is kept', async () => {
  globalThis.fetch = identity('srv');
  try {
    const collection = memory({ owner: { token: 'saved-token', savedAt: 1 } });
    const used = [];
    const link = createOwnerLink({ env: {}, collection, clientId: 'c', productName: 'P',
      resolve: async ({ token }) => { used.push(token); return 'https://plex.example'; }, verifyOwner: async () => true, log: quiet });
    await link.restore();
    assert.deepEqual(used, ['saved-token']);
    assert.equal(link.owner.url, 'https://plex.example');
    assert.equal('token' in link.owner, false);
    const saved = collection.docs.get('owner');
    assert.ok(!('token' in saved), 'the old token is gone from storage');
    assert.equal(saved.machineIdentifier, 'srv');
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
    assert.equal('token' in link.owner, false);
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
