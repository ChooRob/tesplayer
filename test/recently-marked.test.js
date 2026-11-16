import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentlyMarked } from '../recently-marked.js';

test('an item marked watched or unwatched is remembered for 30 seconds, per viewer', () => {
  let time = 1000;
  const marked = createRecentlyMarked({ now: () => time });
  marked.mark('plex:1', '158805');
  assert.equal(marked.isRecent('plex:1', '158805'), true);
  assert.equal(marked.isRecent('plex:2', '158805'), false, 'another viewer is not affected');
  assert.equal(marked.isRecent('plex:1', '999'), false, 'another item is not affected');
  time += 29_999;
  assert.equal(marked.isRecent('plex:1', '158805'), true);
  time += 1;
  assert.equal(marked.isRecent('plex:1', '158805'), false, 'forgotten after 30 seconds');
});

test('old entries are pruned', () => {
  let time = 0;
  const marked = createRecentlyMarked({ now: () => time });
  marked.mark('a', '2');
  time += 60_000;
  marked.mark('a', '3');
  assert.equal(marked.isRecent('a', '2'), false);
  assert.equal(marked.isRecent('a', '3'), true);
});
