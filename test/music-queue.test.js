import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, shuffled, saveQueue, readQueue, positionOf, visibleWindow, withIndex, trackSummary, MAX_QUEUE, isResumable, queueWindow, QUEUE_WINDOW, wrapsReshuffled, reshuffledForRepeat } from '../public/music-queue.js';

const tracks = n => Array.from({ length: n }, (_, i) => ({ ratingKey: i + 1, title: `Song ${i + 1}`, artist: 'A', album: 'B', durationMs: 1000 * (i + 1), episode: i + 1, season: 1, thumbnail: '/t', junk: 'dropped' }));
const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };

test('a queue keeps what is needed to list and show a track, as strings for the keys', () => {
  assert.deepEqual(trackSummary(tracks(1)[0]), { ratingKey: '1', title: 'Song 1', artist: 'A', album: 'B', durationMs: 1000, thumbnail: '/t', episode: 1, season: 1 });
  const queue = createQueue({ label: 'Gold', items: tracks(3) });
  assert.deepEqual(queue.items.map(item => item.ratingKey), ['1', '2', '3']);
  assert.equal(queue.index, 0);
  assert.equal(queue.shuffled, false);
  assert.match(queue.id, /^[0-9a-f]{12}$/);
});

test('playing from a track starts there and keeps the whole album in order, as a click on a track does', () => {
  const queue = createQueue({ items: tracks(5), start: 2 });
  assert.equal(queue.index, 2);
  assert.deepEqual(queue.items.map(item => item.ratingKey), ['1', '2', '3', '4', '5'], 'earlier tracks stay for Previous');
  assert.equal(createQueue({ items: tracks(5), start: 99 }).index, 4);
  assert.equal(createQueue({ items: tracks(5), start: -3 }).index, 0);
  assert.equal(createQueue({ items: [], start: 3 }).index, 0);
});

test('Play on an artist shuffles every track and begins at the first of the mix', () => {
  const random = (() => { let n = 0; return () => [0.9, 0.1, 0.5, 0.3][n++ % 4]; })();
  const queue = createQueue({ items: tracks(5), shuffle: true, start: 3, random });
  assert.equal(queue.shuffled, true);
  assert.equal(queue.index, 0);
  assert.deepEqual([...queue.items.map(item => item.ratingKey)].sort(), ['1', '2', '3', '4', '5'], 'every track, once');
  assert.notDeepEqual(queue.items.map(item => item.ratingKey), ['1', '2', '3', '4', '5']);
  const again = shuffled(tracks(8), () => 0.5);
  assert.equal(again.length, 8);
  assert.deepEqual(shuffled([], Math.random), []);
});

test('a queue is capped, and items without a key are dropped', () => {
  assert.equal(createQueue({ items: tracks(MAX_QUEUE + 50) }).items.length, MAX_QUEUE);
  assert.equal(createQueue({ items: [{ title: 'no key' }, null, ...tracks(2)] }).items.length, 2);
});

test('the queue survives a page change through storage, but only for its own id', () => {
  const storage = memory();
  const queue = createQueue({ label: 'Gold', items: tracks(4), start: 1 });
  assert.equal(saveQueue(storage, queue), true);
  assert.deepEqual(readQueue(storage, queue.id), queue);
  assert.equal(readQueue(storage, 'someoneelse0'), null);
  assert.equal(readQueue(memory(), queue.id), null);
  storage.setItem('freeStuffCrazyPlayer.queue', '{not json');
  assert.equal(readQueue(storage, queue.id), null);
  storage.setItem('freeStuffCrazyPlayer.queue', JSON.stringify({ id: 'x', index: 0, items: [{ ratingKey: 5 }] }));
  assert.equal(readQueue(storage, 'x'), null, 'keys are strings');
  assert.equal(saveQueue({ setItem() { throw new Error('full'); } }, queue), false);
});

test('the track being played is found at the saved position, or after it for a repeated track', () => {
  const queue = { id: 'q', index: 1, items: ['a', 'b', 'a', 'c'].map(ratingKey => ({ ratingKey })) };
  assert.equal(positionOf(queue, 'b'), 1);
  assert.equal(positionOf(queue, 'a'), 2, 'the copy after where we are');
  assert.equal(positionOf({ ...queue, index: 3 }, 'a'), 0, 'else any copy');
  assert.equal(positionOf(queue, 'zzz'), -1);
  assert.equal(withIndex(queue, 3).index, 3);
});

test('only a stretch of a long queue is drawn', () => {
  assert.deepEqual(visibleWindow(10, 4), { from: 0, to: 10 });
  assert.deepEqual(visibleWindow(1000, 500), { from: 480, to: 701 });
  assert.deepEqual(visibleWindow(1000, 995), { from: 975, to: 1000 });
});

import { shuffleQueue, unshuffleQueue, nextPosition, nextRepeat, REPEAT_MODES } from '../public/music-queue.js';

test('turning shuffle on keeps the track playing first and mixes the rest; turning it off restores the order', () => {
  const queue = createQueue({ items: tracks(6), start: 2 });
  const random = (() => { let n = 0; return () => [0.2, 0.8, 0.4, 0.6, 0.1][n++ % 5]; })();
  const on = shuffleQueue(queue, random);
  assert.equal(on.shuffled, true);
  assert.equal(on.index, 0);
  assert.equal(on.items[0].ratingKey, '3', 'the one playing carries on');
  assert.deepEqual(on.items.map(item => item.ratingKey).sort(), ['1', '2', '3', '4', '5', '6'], 'every track, once, earlier ones too');
  assert.notDeepEqual(on.items.map(item => item.ratingKey), ['3', '1', '2', '4', '5', '6']);

  const off = unshuffleQueue(on);
  assert.equal(off.shuffled, false);
  assert.deepEqual(off.items.map(item => item.ratingKey), ['1', '2', '3', '4', '5', '6']);
  assert.equal(off.index, 2, 'still on the same track, at its own place');
  assert.deepEqual(unshuffleQueue(createQueue({ items: tracks(5), shuffle: true })).items.map(item => item.ratingKey), ['1', '2', '3', '4', '5'], 'a queue that began shuffled has its order too');
  assert.equal(shuffleQueue({ ...queue, items: [], index: 0 }).shuffled, true, 'an empty queue does not break');
});

test('repeat cycles off, all, one, and decides where a finished or skipped track goes', () => {
  assert.deepEqual(REPEAT_MODES, ['off', 'all', 'one']);
  assert.deepEqual(['off', 'all', 'one', 'off'].map(nextRepeat), ['all', 'one', 'off', 'all']);
  assert.equal(nextRepeat('nonsense'), 'off');
  const at = (index, repeat) => ({ ...createQueue({ items: tracks(3), start: index }), repeat });
  assert.equal(nextPosition(at(0, 'off'), { auto: true }), 1);
  assert.equal(nextPosition(at(2, 'off'), { auto: true }), null, 'the end');
  assert.equal(nextPosition(at(2, 'all'), { auto: true }), 0, 'round again');
  assert.equal(nextPosition(at(1, 'one'), { auto: true }), 1, 'the same track again');
  assert.equal(nextPosition(at(1, 'one'), { auto: false }), 2, 'pressing Next still moves on');
  assert.equal(nextPosition(at(2, 'one'), { auto: false }), 0, 'and wraps at the end');
  assert.equal(nextPosition({ ...at(0, 'all'), items: [] }, { auto: true }), null);
  assert.equal(createQueue({ items: tracks(2), repeat: 'bogus' }).repeat, 'off');
  assert.equal(createQueue({ items: tracks(2), repeat: 'all' }).repeat, 'all');
});

test('a queue saved before repeat existed reads back with it off', () => {
  const storage = memory();
  storage.setItem('freeStuffCrazyPlayer.queue', JSON.stringify({ id: 'old', index: 0, items: [{ ratingKey: '1' }] }));
  assert.equal(readQueue(storage, 'old').repeat, 'off');
});

import { appendTracks, rollRadio } from '../public/music-queue.js';

test('a radio queue remembers its artist, and only a well-formed one', () => {
  assert.deepEqual(createQueue({ items: tracks(2), radio: { artistKey: '100' } }).radio, { artistKey: '100' });
  assert.equal(createQueue({ items: tracks(2) }).radio, null);
  for (const bad of [{ artistKey: '../x' }, { artistKey: '' }, { artistKey: 'a b' }, {}, 'x']) assert.equal(createQueue({ items: tracks(2), radio: bad }).radio, null, JSON.stringify(bad));
  const storage = memory();
  const queue = createQueue({ items: tracks(3), radio: { artistKey: '100' } });
  saveQueue(storage, queue);
  assert.deepEqual(readQueue(storage, queue.id).radio, { artistKey: '100' });
  storage.setItem('freeStuffCrazyPlayer.queue', JSON.stringify({ ...queue, radio: { artistKey: '<b>' } }));
  assert.equal(readQueue(storage, queue.id).radio, null, 'a damaged one is dropped');
});

test('more tracks go on the end of a queue, once each, keeping their place in the order', () => {
  const queue = createQueue({ items: tracks(3), start: 1 });
  const more = appendTracks(queue, [...tracks(5).slice(2), { ratingKey: 'x', title: 'New' }, null, { title: 'no key' }]);
  assert.deepEqual(more.items.map(item => item.ratingKey), ['1', '2', '3', '4', '5', 'x'], 'track 3 was already there');
  assert.deepEqual(more.items.slice(3).map(item => item.at), [3, 4, 5], 'numbered on from the end');
  assert.equal(more.index, 1, 'the position stays');
  assert.equal(unshuffleQueue(shuffleQueue(more, () => 0.3)).items.length, 6, 'and shuffle still works on it');
  // A small library that has run out of new tracks may repeat.
  assert.deepEqual(appendTracks(queue, tracks(2), { allowRepeats: true }).items.map(item => item.ratingKey), ['1', '2', '3', '1', '2']);
  assert.equal(appendTracks(queue, []).items.length, 3);
});

test('a queue grown past its limit drops the oldest and the position moves with them', () => {
  const full = createQueue({ items: tracks(MAX_QUEUE), start: MAX_QUEUE - 2 });
  const grown = appendTracks(full, [{ ratingKey: 'n1' }, { ratingKey: 'n2' }, { ratingKey: 'n3' }]);
  assert.equal(grown.items.length, MAX_QUEUE);
  assert.equal(grown.items.at(-1).ratingKey, 'n3');
  assert.equal(grown.items[grown.index].ratingKey, String(MAX_QUEUE - 1), 'still on the same track');
  assert.equal(grown.items[0].ratingKey, '4', 'the three oldest are gone');
  // A full queue keeps its length when tracks go on, so "was anything added" cannot be read from the length.
  assert.notEqual(grown, full);
  assert.equal(appendTracks(full, [{ ratingKey: '1' }]), full, 'nothing new is the very same queue');
  assert.equal(appendTracks(full, []), full);
});

test('a radio rolls along: the played drop from the front but the last few stay, and the end is topped up to its size', () => {
  const opts = { size: 8, keepPlayed: 3 };
  const pool = [{ ratingKey: 'p1' }, { ratingKey: 'p2' }, { ratingKey: 'p3' }, { ratingKey: 'p4' }, { ratingKey: 'p5' }];
  const start = createQueue({ items: tracks(8), start: 0 });
  assert.equal(rollRadio(start, pool, opts), start, 'nothing played yet and already full: nothing changes');
  const early = withIndex(start, 3);
  assert.equal(rollRadio(early, pool, opts), early, 'three played is within what is kept');
  const rolled = rollRadio(withIndex(start, 5), pool, opts);
  assert.deepEqual(rolled.items.map(item => item.ratingKey), ['3', '4', '5', '6', '7', '8', 'p1', 'p2'], 'two dropped, two added');
  assert.equal(rolled.items.length, 8);
  assert.equal(rolled.index, 3, 'still three behind the current track');
  assert.equal(rolled.items[rolled.index].ratingKey, '6', 'and it is the same track');
  assert.deepEqual(rolled.items.slice(-2).map(item => item.at), [8, 9], 'numbered on from the end');
  // It stays full without a pool; it only gets shorter by what leaves.
  assert.equal(rollRadio(withIndex(start, 5), [], opts).items.length, 6);
  // A track already queued is not added again unless the library has run out.
  assert.deepEqual(rollRadio(withIndex(start, 5), [{ ratingKey: '7' }, { ratingKey: 'p1' }], opts).items.slice(6).map(item => item.ratingKey), ['p1']);
  assert.equal(rollRadio(withIndex(start, 5), [{ ratingKey: '7' }], { ...opts, allowRepeats: true }).items.at(-1).ratingKey, '7');
  // Only what fits is taken from the pool.
  assert.equal(rollRadio(withIndex(start, 4), pool, opts).items.length, 8);
  assert.deepEqual(rollRadio(withIndex(start, 4), pool, opts).items.slice(-1).map(item => item.ratingKey), ['p1']);
});

test('a film or episode is resumed only when it was begun and is not nearly over', () => {
  const film = fields => ({ durationMs: 1800000, viewOffset: 0, ...fields });
  assert.equal(isResumable(film({ viewOffset: 600000 })), true);
  assert.equal(isResumable(film({ viewOffset: 3000 })), false, 'a few seconds in is not begun');
  assert.equal(isResumable(film({ viewOffset: 1790000 })), false, 'the credits are as good as finished');
  assert.equal(isResumable(film({ viewOffset: 600000, durationMs: 0 })), false, 'no length known');
});

test('the panel beside a film lists a window of 40: the one playing, the last 10 before it, and the rest ahead', () => {
  assert.equal(QUEUE_WINDOW, 40);
  assert.deepEqual(queueWindow(646, 0), { from: 0, to: 40 }, 'at the start: the first 40');
  assert.deepEqual(queueWindow(646, 5), { from: 0, to: 40 }, 'fewer than 10 played: from the top');
  assert.deepEqual(queueWindow(646, 24), { from: 14, to: 54 }, 'in the middle: 10 before, the film, 29 after');
  assert.deepEqual(queueWindow(646, 645), { from: 606, to: 646 }, 'at the end the window shifts to still hold 40');
  assert.deepEqual(queueWindow(12, 5), { from: 0, to: 12 }, 'a short queue is all of it');
  assert.deepEqual(queueWindow(0, 0), { from: 0, to: 0 });
  for (const [count, current] of [[100, 50], [100, 99], [41, 0], [41, 40]]) {
    const { from, to } = queueWindow(count, current);
    assert.equal(to - from, 40);
    assert.ok(from <= current && current < to, `${current} of ${count} is in its own window`);
  }
});

test('a shuffled queue that repeats all is mixed again at the end, before it goes round, and never opens on the one just played', () => {
  const films = Array.from({ length: 8 }, (_, i) => ({ ratingKey: String(i + 1), title: `Film ${i + 1}` }));
  const atEnd = (options = {}) => withIndex(createQueue({ items: films, shuffle: true, repeat: 'all', id: 'q', ...options }), 7);
  for (let round = 0; round < 200; round++) {
    const queue = atEnd();
    assert.equal(wrapsReshuffled(queue), true);
    const again = reshuffledForRepeat(queue);
    const justPlayed = queue.items[7].ratingKey;
    assert.equal(again.index, 0, 'standing at the start of the new order');
    assert.notEqual(again.items[0].ratingKey, justPlayed, 'never the one just played');
    assert.deepEqual(again.items.map(item => item.ratingKey).sort(), films.map(item => item.ratingKey).sort(), 'every one, once');
    assert.equal(again.id, 'q');
    assert.equal(again.shuffled, true);
    assert.equal(again.repeat, 'all');
  }
  // It mixes: not the same order every time round.
  const orders = new Set(Array.from({ length: 30 }, () => reshuffledForRepeat(atEnd()).items.map(item => item.ratingKey).join()));
  assert.ok(orders.size > 10, `${orders.size} different orders in 30 tries`);
  // A fixed random that would put the one just played first still does not open on it.
  const stubborn = reshuffledForRepeat(atEnd(), () => 0.999);
  assert.notEqual(stubborn.items[0].ratingKey, atEnd().items[7].ratingKey);
});

test('only a shuffled queue repeating all at its end is mixed again; anything else is left as it was', () => {
  const films = Array.from({ length: 6 }, (_, i) => ({ ratingKey: String(i + 1) }));
  const make = options => createQueue({ items: films, id: 'q', ...options });
  const same = queue => assert.equal(reshuffledForRepeat(queue), queue, 'the very same queue');
  same(withIndex(make({ shuffle: false, repeat: 'all' }), 5));           // in order: goes round in the same order
  same(withIndex(make({ shuffle: true, repeat: 'off' }), 5));            // does not repeat: it ends
  same(withIndex(make({ shuffle: true, repeat: 'one' }), 5));            // repeats the one track
  same(withIndex(make({ shuffle: true, repeat: 'all' }), 4));            // not at the end yet
  same(withIndex(createQueue({ items: films.slice(0, 2), shuffle: true, repeat: 'all' }), 1)); // two: nothing to mix
  assert.equal(wrapsReshuffled(withIndex(make({ shuffle: true, repeat: 'all' }), 5)), true);
  assert.equal(wrapsReshuffled(withIndex(make({ shuffle: true, repeat: 'all' }), 3)), false);
  // Turning shuffle off afterwards still puts the original order back, since each keeps its place in it.
  const mixed = reshuffledForRepeat(withIndex(make({ shuffle: true, repeat: 'all' }), 5));
  assert.deepEqual(unshuffleQueue(mixed).items.map(item => item.ratingKey), films.map(item => item.ratingKey));
});
