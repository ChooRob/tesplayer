import test from 'node:test';
import assert from 'node:assert/strict';
import { orderLibraries, readTabMemory, writeTabMemory, startingTab } from '../public/browse-memory.js';

const memory = (initial = null) => {
  let value = initial;
  return { getItem: () => value, setItem: (_key, next) => { value = next; }, get value() { return value; } };
};

test('music libraries come first, the rest keep the order they came in', () => {
  const libraries = [
    { id: '1', type: 'movie' }, { id: '2', type: 'show' }, { id: '5', type: 'music' }, { id: '3', type: 'movie' }, { id: '6', type: 'music' },
  ];
  assert.deepEqual(orderLibraries(libraries).map(library => library.id), ['5', '6', '1', '2', '3']);
  assert.deepEqual(libraries.map(library => library.id), ['1', '2', '5', '3', '6'], 'the list given is not changed');
  assert.deepEqual(orderLibraries([]), []);
  assert.deepEqual(orderLibraries([{ id: '1', type: 'movie' }]).map(library => library.id), ['1']);
});

test('the tab and each library\'s view are remembered and read back', () => {
  const storage = memory();
  assert.deepEqual(readTabMemory(storage), { tab: null, views: {} });
  writeTabMemory(storage, { tab: '5', view: 'albums' });
  writeTabMemory(storage, { tab: '1' });
  assert.deepEqual(readTabMemory(storage), { tab: '1', views: { 5: 'albums' } }, 'the music library keeps its view while another is open');
  writeTabMemory(storage, { tab: '5', view: 'tracks' });
  assert.deepEqual(readTabMemory(storage), { tab: '5', views: { 5: 'tracks' } });
  writeTabMemory(storage, { tab: 'live-tv' });
  assert.equal(readTabMemory(storage).tab, 'live-tv', 'a plugin tab too');
});

test('nothing bad is remembered or read back, and a broken store is just empty', () => {
  const storage = memory();
  writeTabMemory(storage, { tab: '<script>', view: 'x' });
  writeTabMemory(storage, { tab: '', view: 'x' });
  writeTabMemory(storage, { tab: null });
  assert.equal(storage.value, null);
  writeTabMemory(storage, { tab: '5', view: 'Not Valid' });
  assert.deepEqual(readTabMemory(storage), { tab: '5', views: {} });
  for (const bad of ['{not json', 'null', '"text"', '[1]', JSON.stringify({ tab: 5, views: 'x' }), JSON.stringify({ tab: '../x', views: { '../': 'a', 5: '<b>', 6: 'ok' } })]) {
    const stored = readTabMemory(memory(bad));
    assert.ok(stored.tab === null || /^[A-Za-z0-9-]+$/.test(stored.tab));
    assert.ok(Object.values(stored.views).every(view => /^[a-z0-9-]+$/.test(view)), bad);
  }
  assert.deepEqual(readTabMemory(memory(JSON.stringify({ tab: '../x', views: { '../': 'a', 5: '<b>', 6: 'ok' } }))), { tab: null, views: { 6: 'ok' } });
  // Storage that throws (private browsing) is survived both ways.
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readTabMemory(broken), { tab: null, views: {} });
  assert.doesNotThrow(() => writeTabMemory(broken, { tab: '5' }));
});

test('the page opens on the remembered tab if it is still there, else the first', () => {
  assert.equal(startingTab({ tab: '3' }, ['5', '3', 'live-tv']), '3');
  assert.equal(startingTab({ tab: 'live-tv' }, ['5', '3', 'live-tv']), 'live-tv');
  assert.equal(startingTab({ tab: '99' }, ['5', '3']), '5', 'a library that is gone, or from another server');
  assert.equal(startingTab({ tab: null }, ['5', '3']), '5');
  assert.equal(startingTab({ tab: '3' }, []), null);
});
