import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountDirectory } from '../accounts.js';
import { createPlexAccountDirectory } from '../plex-account-directory.js';

function memoryCollection() {
  const data = new Map();
  return {
    data,
    get: async id => data.get(id) ?? null,
    entries: async () => [...data.entries()],
    update: async (id, change) => { const next = change(data.get(id) ?? null); if (next !== undefined) data.set(id, next); },
  };
}

test('the Plex account directory matches username, ID and exact email without storing the email', async () => {
  const collection = memoryCollection();
  const options = { collection, secret: 'test-secret' };
  const account = { id: '123', username: 'MovieFan' };
  await createPlexAccountDirectory(options).remember({ ...account, confirmedEmail: 'fan@example.test' });
  assert.doesNotMatch(JSON.stringify([...collection.data]), /fan@example\.test/);
  const directory = createPlexAccountDirectory(options);
  for (const query of ['movie', '123', ' FAN@EXAMPLE.TEST ']) {
    assert.deepEqual(await directory.search(query), [account]);
  }
  assert.deepEqual(await directory.search('fan@example'), [], 'only the exact email matches');
  assert.deepEqual(await directory.get('123'), account);
  assert.deepEqual(await directory.list(), [account]);
  assert.equal(await directory.get('999'), null);
});

test('account search and naming span every source, and one failing source does not break the rest', async () => {
  const plex = { name: 'Plex', accounts: {
    search: async query => (query === 'sam' ? [{ key: 'plex:1', label: 'Sam' }] : []),
    describe: async key => (key === 'plex:1' ? { key, label: 'Sam' } : null),
  } };
  const jellyfin = { name: 'Jellyfin', accounts: {
    search: async () => [{ key: 'jellyfin:home', label: 'Home server' }],
    describe: async key => (key === 'jellyfin:home' ? { key, label: 'Home server' } : null),
  } };
  const broken = { name: 'Broken', accounts: { search: async () => { throw new Error('offline'); }, describe: async () => null } };
  const accounts = createAccountDirectory(new Map([['plex', plex], ['jellyfin', jellyfin], ['broken', broken], ['none', { name: 'None' }]]));

  assert.deepEqual(await accounts.search(' sam '), [
    { key: 'plex:1', label: 'Sam', source: 'Plex' },
    { key: 'jellyfin:home', label: 'Home server', source: 'Jellyfin' },
  ]);
  assert.deepEqual(await accounts.search(''), []);
  assert.deepEqual(await accounts.describe('jellyfin:home'), { key: 'jellyfin:home', label: 'Home server', source: 'Jellyfin' });
  assert.equal(await accounts.describe('plex:2'), null);
  assert.equal(await accounts.describe(''), null);
});
