import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePicture, offsetLimit, readPicture, savePicture, PICTURE_KEY, MIN_SCALE } from '../public/picture-layout.js';

test('a full-size picture cannot move, and a smaller one moves to the window edge', () => {
  assert.equal(offsetLimit(1), 0);
  assert.equal(offsetLimit(0.5), 0.25);
  assert.deepEqual(normalizePicture({ scale: 1, x: 0.3, y: -0.3 }), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(normalizePicture({ scale: 0.5, x: 0.9, y: -0.9 }), { scale: 0.5, x: 0.25, y: -0.25 });
});

test('size is held between the minimum and full size', () => {
  assert.equal(normalizePicture({ scale: 5 }).scale, 1);
  assert.equal(normalizePicture({ scale: 0.01 }).scale, MIN_SCALE);
  assert.equal(normalizePicture({ scale: -2 }).scale, MIN_SCALE);
});

test('junk values fall back to a centered, full-size picture', () => {
  for (const junk of [null, undefined, 'x', 7, [], { scale: 'big', x: NaN, y: Infinity }]) {
    assert.deepEqual(normalizePicture(junk), { scale: 1, x: 0, y: 0 });
  }
});

test('a saved picture is read back, and bad or missing storage gives the default', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  savePicture(storage, { scale: 0.6, x: 0.1, y: -0.05 });
  assert.deepEqual(readPicture(storage), { scale: 0.6, x: 0.1, y: -0.05 });
  data.set(PICTURE_KEY, '{not json');
  assert.deepEqual(readPicture(storage), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(readPicture(undefined), { scale: 1, x: 0, y: 0 });
  assert.doesNotThrow(() => savePicture({ setItem() { throw new Error('blocked'); } }, { scale: 0.5 }));
});
