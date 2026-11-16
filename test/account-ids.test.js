import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicAccountIds } from '../account-ids.js';
import { createAccountDirectory } from '../accounts.js';

const secret = 'a-private-installation-secret';

test('a public ID is stable, well formed, and different for each account and install', () => {
  const ids = createPublicAccountIds(secret);
  const id = ids.publicId('plex:12345');
  assert.match(id, /^FSC-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.equal(ids.publicId('plex:12345'), id);
  assert.notEqual(ids.publicId('plex:12346'), id);
  assert.notEqual(createPublicAccountIds('another-private-installation-secret').publicId('plex:12345'), id);
  assert.ok(!id.includes('12345'));
  assert.throws(() => createPublicAccountIds('short'));
});

test('typed or pasted IDs are recognized in any case and spacing, and anything else is not', () => {
  const ids = createPublicAccountIds(secret);
  const id = ids.publicId('jellyfin:abc');
  const body = id.slice(4);
  for (const text of [id, id.toLowerCase(), body.replaceAll('-', ''), ` ${id.replaceAll('-', ' ')} `, 'fsc' + body.replaceAll('-', '').toLowerCase()]) {
    assert.equal(ids.parse(text), id, text);
  }
  assert.equal(ids.parse(id.replace(/0/g, 'O').replace(/1/g, 'l')), id, 'look-alike letters are read as digits');
  for (const text of ['', 'plex:12345', 'FSC-1234', id + 'X', 'FSC-UUUU-UUUU-UUUU-UUUU', null, undefined, 42]) {
    assert.equal(ids.parse(text), null, String(text));
  }
});

test('administrators find accounts by public ID, and the match is flagged exact', async () => {
  const ids = createPublicAccountIds(secret);
  const accounts = [{ key: 'plex:1', label: 'Sam' }, { key: 'plex:2', label: 'Alex' }];
  const plex = { name: 'Plex', accounts: { list: async () => accounts, search: async () => [], describe: async () => null } };
  const noList = { name: 'Other', accounts: { search: async () => [], describe: async () => null } };
  const broken = { name: 'Broken', accounts: { list: async () => { throw new Error('offline'); }, search: async () => [], describe: async () => null } };
  const directory = createAccountDirectory(new Map([['plex', plex], ['other', noList], ['broken', broken]]), { publicIds: ids });

  assert.deepEqual(await directory.search(ids.publicId('plex:2').toLowerCase()), [{ key: 'plex:2', label: 'Alex', source: 'Plex', exact: true }]);
  assert.deepEqual(await directory.search(ids.publicId('plex:999')), [], 'an unknown ID matches nothing');
  // Without public IDs configured, the directory behaves as before.
  assert.deepEqual(await createAccountDirectory(new Map([['plex', plex]])).search(ids.publicId('plex:2')), []);
});
