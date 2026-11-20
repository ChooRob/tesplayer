import test from 'node:test';
import assert from 'node:assert/strict';
import { isResumable, onDeckIndex } from '../public/on-deck.js';

const episode = (fields = {}) => ({ durationMs: 1800000, viewOffset: 0, viewCount: 0, ...fields });

test('an episode is resumed only when it was begun and is not nearly over', () => {
  assert.equal(isResumable(episode({ viewOffset: 600000 })), true);
  assert.equal(isResumable(episode({ viewOffset: 3000 })), false, 'a few seconds in is not begun');
  assert.equal(isResumable(episode({ viewOffset: 1790000 })), false, 'the credits are as good as finished');
  assert.equal(isResumable(episode({ viewOffset: 600000, durationMs: 0 })), false, 'no length known');
});

test('Play starts at a begun episode, else after the last watched, else at the first', () => {
  assert.equal(onDeckIndex([episode({ viewCount: 1 }), episode(), episode({ viewOffset: 600000 })]), 2, 'begun comes first');
  assert.equal(onDeckIndex([episode({ viewCount: 1 }), episode(), episode({ viewCount: 1 }), episode()]), 3, 'after the last watched, gaps and all');
  assert.equal(onDeckIndex([episode(), episode()]), 0, 'nothing watched');
  assert.equal(onDeckIndex([episode({ viewCount: 1 }), episode({ viewCount: 2 })]), 0, 'all watched: from the start again');
  assert.equal(onDeckIndex([]), 0);
});
