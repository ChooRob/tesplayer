import test from 'node:test';
import assert from 'node:assert/strict';
import { mixRadio, RADIO_SIZE, OWN_TRACKS, PER_SIMILAR } from '../public/music-radio.js';

const tracks = (prefix, n) => Array.from({ length: n }, (_, i) => ({ ratingKey: `${prefix}${i + 1}`, title: `${prefix} ${i + 1}`, type: 'track' }));
const fixed = () => { let n = 0; return () => [0.31, 0.77, 0.05, 0.52, 0.93, 0.18, 0.64, 0.41][n++ % 8]; };

test('radio begins with a track by the artist and mixes in tracks by similar artists', () => {
  const list = mixRadio({ artistTracks: tracks('a', 20), similarTracks: [tracks('b', 10), tracks('c', 10), tracks('d', 10)], random: fixed() });
  assert.ok(list[0].ratingKey.startsWith('a'), 'the first is the artist\'s own');
  assert.ok(list.length > 20 && list.length <= RADIO_SIZE);
  const bySource = prefix => list.filter(track => track.ratingKey.startsWith(prefix)).length;
  assert.ok(bySource('a') <= OWN_TRACKS + 1, 'the artist is not the whole station');
  for (const prefix of ['b', 'c', 'd']) {
    assert.ok(bySource(prefix) > 0 && bySource(prefix) <= PER_SIMILAR, `${prefix}: some, but not all of a similar artist`);
  }
});

test('each track appears once, even when artists share tracks', () => {
  const shared = tracks('a', 5);
  const list = mixRadio({ artistTracks: shared, similarTracks: [shared, tracks('b', 3)], random: fixed() });
  assert.equal(new Set(list.map(track => track.ratingKey)).size, list.length);
});

test('radio is only as long as the size asked for, and copes with little to play', () => {
  assert.equal(mixRadio({ artistTracks: tracks('a', 50), similarTracks: Array.from({ length: 20 }, (_, i) => tracks(`s${i}`, 10)), size: 10 }).length, 10);
  assert.deepEqual(mixRadio({ artistTracks: [], similarTracks: [] }), []);
  const onlySimilar = mixRadio({ artistTracks: [], similarTracks: [tracks('b', 3)], random: fixed() });
  assert.equal(onlySimilar.length, 3, 'with no tracks of its own, the similar artists\' alone');
  assert.deepEqual(mixRadio({ artistTracks: tracks('a', 1), similarTracks: [] }).map(track => track.ratingKey), ['a1']);
  assert.equal(mixRadio({ artistTracks: [{ title: 'no key' }, ...tracks('a', 2)], similarTracks: [null] .filter(Boolean) }).length, 2, 'items without a key are skipped');
});

test('a different roll gives a different station', () => {
  const a = mixRadio({ artistTracks: tracks('a', 20), similarTracks: [tracks('b', 10)], random: () => 0.1 });
  const b = mixRadio({ artistTracks: tracks('a', 20), similarTracks: [tracks('b', 10)], random: () => 0.9 });
  assert.notDeepEqual(a.map(track => track.ratingKey), b.map(track => track.ratingKey));
});

import { gatherRadio, RADIO_KEEP_PLAYED } from '../public/music-radio.js';

test('radio can be told which tracks not to play again', () => {
  const list = mixRadio({ artistTracks: tracks('a', 20), similarTracks: [tracks('b', 6)], exclude: ['a1', 'a2', 'b1', 'b2', 'b3'], random: fixed() });
  assert.ok(list.every(track => !['a1', 'a2', 'b1', 'b2', 'b3'].includes(track.ratingKey)));
  assert.ok(list.length > 5);
  assert.deepEqual(mixRadio({ artistTracks: tracks('a', 2), exclude: ['a1', 'a2'] }), [], 'nothing new to add');
  assert.deepEqual(mixRadio({ artistTracks: tracks('a', 2), exclude: [1] }).map(track => track.ratingKey).sort(), ['a1', 'a2'], 'keys compared as text');
});

test('gathering a radio reads the artist and its similar artists through the pages\' routes', async () => {
  const asked = [];
  const fetchJson = async url => {
    asked.push(url);
    if (url === '/api/library/show/100/episodes') return tracks('a', 8);
    if (url === '/api/library/similar/100') return { sections: [{ title: 'Similar', items: [{ ratingKey: '101' }, { ratingKey: '102' }] }, { title: 'Sonic', items: [{ ratingKey: '103' }] }] };
    if (url === '/api/library/show/101/episodes') return tracks('b', 5);
    if (url === '/api/library/show/102/episodes') throw new Error('gone');
    if (url === '/api/library/show/103/episodes') return [{ ratingKey: 'm1', type: 'movie' }, ...tracks('c', 3)];
    throw new Error(`unexpected ${url}`);
  };
  const list = await gatherRadio({ fetchJson, artistKey: '100', random: fixed() });
  assert.ok(list[0].ratingKey.startsWith('a'));
  assert.ok(list.some(track => track.ratingKey.startsWith('b')) && list.some(track => track.ratingKey.startsWith('c')), 'similar artists are in');
  assert.ok(!list.some(track => track.ratingKey === 'm1'), 'only tracks');
  assert.deepEqual(asked.sort(), ['/api/library/show/100/episodes', '/api/library/show/101/episodes', '/api/library/show/102/episodes', '/api/library/show/103/episodes', '/api/library/similar/100']);
  // The artist alone, when the similar artists cannot be read.
  const alone = await gatherRadio({ fetchJson: async url => { if (url.includes('similar')) throw new Error('no'); return tracks('a', 4); }, artistKey: '100' });
  assert.equal(alone.length, 4);
  // And a top-up skips what is queued.
  const more = await gatherRadio({ fetchJson, artistKey: '100', exclude: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'], size: RADIO_SIZE, random: fixed() });
  assert.ok(more.every(track => !/^a[1-7]$/.test(track.ratingKey)));
  assert.equal(RADIO_SIZE, 40);
  assert.equal(RADIO_KEEP_PLAYED, 10);
});
