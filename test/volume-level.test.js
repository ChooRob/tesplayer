import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVolume, readVolume, saveVolume, VOLUME_KEY } from '../public/volume-level.js';

test('volume is held between silence and the boost limit', () => {
  assert.equal(normalizeVolume(1.5), 1.5);
  assert.equal(normalizeVolume(9), 4);
  assert.equal(normalizeVolume(-1), 0);
  assert.equal(normalizeVolume(1.5, 1), 1, 'the browser video volume cannot exceed 1');
  for (const junk of [NaN, Infinity, '2', null, undefined]) assert.equal(normalizeVolume(junk), 1);
});

test('a saved volume is read back, and bad or missing storage gives the original level', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.equal(readVolume(storage), 1);
  saveVolume(storage, 1.4);
  assert.equal(readVolume(storage), 1.4);
  assert.equal(readVolume(storage, 1), 1, 'Standard playback caps a saved boost');
  data.set(VOLUME_KEY, 'loud');
  assert.equal(readVolume(storage), 1);
  assert.equal(readVolume(undefined), 1);
  assert.doesNotThrow(() => saveVolume({ setItem() { throw new Error('blocked'); } }, 1.2));
});

test('music keeps its own volume, apart from video', async () => {
  const { MUSIC_VOLUME_KEY } = await import('../public/volume-level.js');
  const store = new Map();
  const storage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) };
  saveVolume(storage, 4);
  assert.equal(readVolume(storage, 4, MUSIC_VOLUME_KEY), 1, 'a film\'s boost does not reach music');
  saveVolume(storage, 0.5, MUSIC_VOLUME_KEY);
  assert.equal(readVolume(storage, 4), 4, 'and music does not change the film\'s');
  assert.equal(readVolume(storage, 4, MUSIC_VOLUME_KEY), 0.5);
});
