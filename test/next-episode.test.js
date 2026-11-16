import test from 'node:test';
import assert from 'node:assert/strict';
import { nextEpisodeAfter, showIdFromKey } from '../next-episode.js';

const show = [
  { ratingKey: 1, title: 'Special', season: 0, episode: 1 },
  { ratingKey: 2, title: 'Pilot', season: 1, episode: 1 },
  { ratingKey: 3, title: 'Second', season: 1, episode: 2 },
  { ratingKey: 4, title: 'Premiere', season: 2, episode: 1 },
];

test('the next episode follows in order, across a season boundary', () => {
  assert.deepEqual(nextEpisodeAfter(show, '2'), { ratingKey: '3', title: 'Second', season: 1, episode: 2 });
  assert.equal(nextEpisodeAfter(show, 3).title, 'Premiere');
});

test('the last episode has no next one', () => {
  assert.equal(nextEpisodeAfter(show, 4), null);
});

test('specials are skipped, unless the viewer is in them', () => {
  const withSpecialLast = [...show, { ratingKey: 5, title: 'Bonus', season: 0, episode: 2 }];
  assert.equal(nextEpisodeAfter(withSpecialLast, 4), null);
  assert.equal(nextEpisodeAfter(withSpecialLast, 1).title, 'Pilot');
  const specials = [{ ratingKey: 1, season: 0, episode: 1, title: 'A' }, { ratingKey: 2, season: 0, episode: 2, title: 'B' }];
  assert.equal(nextEpisodeAfter(specials, 1).title, 'B');
});

test('an unknown episode or a bad list gives nothing', () => {
  assert.equal(nextEpisodeAfter(show, 99), null);
  assert.equal(nextEpisodeAfter(null, 1), null);
});

test('a show id comes out of a Plex key path or a plain Jellyfin id', () => {
  assert.equal(showIdFromKey('/library/metadata/1234'), '1234');
  assert.equal(showIdFromKey('abc123def'), 'abc123def');
  assert.equal(showIdFromKey(null), null);
  assert.equal(showIdFromKey('/'), null);
});
