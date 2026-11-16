import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJsonStore } from '../storage.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tesladash-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('documents round-trip, persist privately, and survive a new store instance', async t => {
  const dir = tempDir(t);
  const items = createJsonStore({ dir }).collection('items');
  assert.equal(await items.get('a'), null);
  await items.set('a', { n: 1 });
  await items.set('b', { n: 2 });
  assert.deepEqual(await items.get('a'), { n: 1 });
  assert.equal(await items.delete('b'), true);
  assert.equal(await items.delete('b'), false);
  const file = path.join(dir, '.items.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: { n: 1 } });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await createJsonStore({ dir }).collection('items').entries(), [['a', { n: 1 }]]);
});

test('callers get copies, so mutating a read value changes nothing', async () => {
  const items = createJsonStore().collection('items');
  const original = { list: [1] };
  await items.set('a', original);
  original.list.push(2);
  const read = await items.get('a');
  read.list.push(3);
  assert.deepEqual(await items.get('a'), { list: [1] });
});

test('update is atomic: concurrent increments are never lost', async () => {
  const counters = createJsonStore().collection('counters');
  await Promise.all(Array.from({ length: 50 }, () => counters.update('hits', async value => {
    await new Promise(resolve => setImmediate(resolve));
    return (value ?? 0) + 1;
  })));
  assert.equal(await counters.get('hits'), 50);
  assert.equal(await counters.update('hits', () => undefined), 50);
  assert.equal(await counters.update('hits', () => null), null);
  assert.equal(await counters.get('hits'), null);
});

test('a failed update leaves the stored value unchanged', async t => {
  const items = createJsonStore({ dir: tempDir(t) }).collection('items');
  await items.set('a', 1);
  await assert.rejects(items.update('a', () => { throw new Error('nope'); }), /nope/);
  assert.equal(await items.get('a'), 1);
  await items.set('a', 2);
  assert.equal(await items.get('a'), 2);
});

test('migrate converts an older layout, and importFrom moves a legacy file in once', async t => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, '.list.json'), JSON.stringify([{ id: 'x', v: 1 }]));
  const list = createJsonStore({ dir }).collection('list', {
    migrate: raw => (Array.isArray(raw) ? Object.fromEntries(raw.map(entry => [entry.id, entry])) : raw),
  });
  assert.deepEqual(await list.get('x'), { id: 'x', v: 1 });

  const legacy = path.join(dir, 'old-place.json');
  writeFileSync(legacy, JSON.stringify({ k: 'v' }));
  const moved = createJsonStore({ dir }).collection('moved', { importFrom: legacy });
  assert.equal(await moved.get('k'), 'v');
  await moved.entries();
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(legacy + '.imported'), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '.moved.json'), 'utf8')), { k: 'v' });
});

test('rejects bad collection names, IDs and empty documents', async () => {
  const store = createJsonStore();
  assert.throws(() => store.collection('../escape'), /Invalid collection name/);
  const items = store.collection('items');
  await assert.rejects(() => items.get(''), TypeError);
  await assert.rejects(() => items.set('a', null), /delete/);
});

test('openStore uses the built-in JSON files unless a plugin supplies a backend', async t => {
  const { openStore } = await import('../storage.js');
  const dir = tempDir(t);
  const json = await openStore({ plugins: [{}], dataDir: dir });
  await json.collection('items').set('a', 1);
  assert.equal(existsSync(path.join(dir, '.items.json')), true);

  const memory = createJsonStore();
  let received;
  const fromPlugin = await openStore({ dataDir: dir, plugins: [{}, { createStore: async options => { received = options; return memory; } }] });
  assert.equal(fromPlugin, memory);
  assert.deepEqual(received, { dataDir: dir });

  await assert.rejects(openStore({ dataDir: dir, plugins: [{ createStore: () => ({}) }] }), /collection\(\)/);
  await assert.rejects(openStore({ dataDir: dir, plugins: [{ createStore: () => ({ collection: () => ({ get() {} }) }) }] }), /missing: entries, set, delete, update/);
});
