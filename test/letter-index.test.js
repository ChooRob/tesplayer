import test from 'node:test';
import assert from 'node:assert/strict';
import { LETTERS, letterOf, orderName, letterIndex, targetIndex, LETTER_BAR_MIN_ITEMS } from '../public/letter-index.js';

test('the bar is # then A to Z', () => {
  assert.equal(LETTERS.length, 27);
  assert.deepEqual([LETTERS[0], LETTERS[1], LETTERS.at(-1)], ['#', 'A', 'Z']);
});

test('a name\'s letter ignores case, accents, a leading article and spaces; digits and symbols are #', () => {
  for (const [name, letter] of [['ABBA', 'A'], ['abba', 'A'], ['Édith Piaf', 'E'], ['Sigur Rós', 'S'], ['The Band', 'B'], ['A Taste of Honey', 'T'], ['An Horse', 'H'],
    ['  Paula Abdul', 'P'], ['311', '#'], ['10cc', '#'], ['(500) Days', '#'], ['!!!', '#'], ['', '#'], [null, '#'], [undefined, '#'], ['The', 'T'], ['A', 'A'], ['Åsa', 'A'], ['Ñandú', 'N']]) {
    assert.equal(letterOf(name), letter, JSON.stringify(name));
  }
  assert.equal(letterOf('東京'), '#', 'letters the bar has no place for');
});

test('albums and tracks are sorted under their artist, artists and movies under their title', () => {
  assert.equal(orderName({ type: 'artist', title: 'ABBA' }), 'ABBA');
  assert.equal(orderName({ type: 'album', title: 'Gold', showTitle: 'ABBA' }, 'albums'), 'ABBA');
  assert.equal(orderName({ type: 'track', title: 'Dancing Queen', artist: 'ABBA', album: 'Gold' }, 'tracks'), 'ABBA');
  assert.equal(orderName({ type: 'track', title: 'Song', showTitle: 'Band' }), 'Band');
  assert.equal(orderName({ type: 'track', title: 'Untitled' }), 'Untitled', 'no artist: its own title');
  assert.equal(orderName({ type: 'movie', title: 'Alien' }), 'Alien');
  assert.equal(orderName({ type: 'album', title: 'Orphan' }), 'Orphan');
});

test('the index finds where each letter begins', () => {
  const items = ['10cc', '311', 'ABBA', 'AC/DC', 'Beck', 'The Band', 'Cher', 'Zed'].map(title => ({ type: 'artist', title }));
  const index = letterIndex(items);
  assert.deepEqual([...index.entries()], [['#', 0], ['A', 2], ['B', 4], ['C', 6], ['Z', 7]], 'the first of each, in order seen');
  assert.deepEqual([...letterIndex([{ type: 'track', artist: 'Zed', title: 'A' }, { type: 'track', artist: 'Abc', title: 'Z' }], 'tracks').keys()], ['Z', 'A'], 'by artist, wherever it falls');
  assert.equal(letterIndex([]).size, 0);
});

test('tapping a letter goes to it, else the next one there is, else the end', () => {
  const index = letterIndex(['ABBA', 'Beck', 'Cher', 'Mika', 'Zed'].map(title => ({ title })));
  assert.equal(targetIndex(index, 'A'), 0);
  assert.equal(targetIndex(index, 'M'), 3);
  assert.equal(targetIndex(index, 'D'), 3, 'nothing under D: the next, M');
  assert.equal(targetIndex(index, '#'), 0, 'nothing numeric: the first section');
  assert.equal(targetIndex(index, 'Z'), 4);
  assert.equal(targetIndex(letterIndex([{ title: 'Alpha' }, { title: 'Beta' }]), 'Z'), 1, 'past the last: the last section');
  assert.equal(targetIndex(new Map(), 'A'), null);
  assert.ok(LETTER_BAR_MIN_ITEMS > 10);
});

test('a list in the order of the server\'s sort names puts each letter where that order has it', () => {
  // Plex keeps artists under the surname, so "Gregory Abbott" sits among the A's and "Paul Davis" among the D's.
  const items = [
    { type: 'artist', title: 'ABBA', sortTitle: 'ABBA' },
    { type: 'artist', title: 'Gregory Abbott', sortTitle: 'Abbott, Gregory' },
    { type: 'artist', title: 'Bryan Adams', sortTitle: 'Adams, Bryan' },
    { type: 'artist', title: 'Paul Davis', sortTitle: 'Davis, Paul' },
    { type: 'artist', title: 'Daft Punk' },
  ];
  assert.equal(orderName(items[1]), 'Abbott, Gregory');
  const index = letterIndex(items);
  assert.equal(index.get('A'), 0);
  assert.equal(index.has('G'), false, 'Gregory is not a G');
  assert.equal(index.has('B'), false, 'Bryan is not a B');
  assert.equal(index.get('D'), 3, 'D begins at Davis, where the list has it');
  assert.equal(targetIndex(index, 'B'), 3, 'a letter with nothing goes on to the next');
});

test('a sort name from the server is taken as it is, so "A Taste of Honey" stays under A', () => {
  const index = letterIndex([
    { type: 'artist', title: 'A Taste of Honey', sortTitle: 'A Taste of Honey' },
    { type: 'artist', title: 'The Band', sortTitle: 'Band' },
    { type: 'artist', title: 'The Cure' },
  ]);
  assert.equal(index.get('A'), 0);
  assert.equal(index.get('B'), 1);
  assert.equal(index.get('C'), 2, 'a title with no sort name still drops its article');
  assert.equal(index.has('T'), false);
});
