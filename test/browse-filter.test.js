import test from 'node:test';
import assert from 'node:assert/strict';
import { itemMatches, filterItems, words } from '../public/browse-filter.js';

const items = [
  { type: 'track', title: 'Opening', artist: 'The Band', album: 'First Record', year: 1999 },
  { type: 'track', title: 'Café del Mar', artist: 'Energy 52', album: 'Ibiza Nights' },
  { type: 'album', title: 'First Record', showTitle: 'The Band', year: 1999 },
  { type: 'artist', title: 'Sigur Rós' },
  { type: 'movie', title: 'The Matrix', year: 1999 },
];

test('every word must appear, in any order, across title, artist, album, show and year', () => {
  assert.deepEqual(filterItems(items, 'band').map(item => item.title), ['Opening', 'First Record']);
  assert.deepEqual(filterItems(items, 'record band').map(item => item.title), ['Opening', 'First Record'], 'any order');
  assert.deepEqual(filterItems(items, 'opening band 1999').map(item => item.title), ['Opening']);
  assert.deepEqual(filterItems(items, 'band matrix'), [], 'every word, not any word');
  assert.deepEqual(filterItems(items, '1999').map(item => item.title), ['Opening', 'First Record', 'The Matrix']);
});

test('case and accents do not matter, in the filter or the item', () => {
  assert.deepEqual(filterItems(items, 'CAFE').map(item => item.title), ['Café del Mar']);
  assert.deepEqual(filterItems(items, 'café').map(item => item.title), ['Café del Mar']);
  assert.deepEqual(filterItems(items, 'sigur ros').map(item => item.title), ['Sigur Rós']);
  assert.deepEqual(filterItems(items, 'SIGUR RÓS').map(item => item.title), ['Sigur Rós']);
});

test('an empty filter keeps everything and nothing breaks on missing fields', () => {
  for (const empty of ['', '   ', null, undefined]) assert.equal(filterItems(items, empty), items, `[${empty}]`);
  assert.equal(itemMatches({}, 'x'), false);
  assert.equal(itemMatches({ title: null, year: undefined }, 'x'), false);
  assert.equal(itemMatches(null, ''), true);
  assert.deepEqual(words('  Two   words '), ['two', 'words']);
});
