import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as musicQueue from '../public/music-queue.js';
import { isResumable, onDeckIndex } from '../public/on-deck.js';

const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start > 0 && end > start, from);
  return html.slice(start, end);
};

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); } };
}

// The browse page's Play and Shuffle, run against stubs. Returns where the page went and the tab's storage.
function browse({ gridItems = [], musicHeld = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden: true, onclick: null, click() { return this.onclick?.(); } });
    return elements.get(id);
  };
  const went = [];
  const heldMusic = [];
  const context = {
    URLSearchParams, Math,
    document: { getElementById: element },
    window: { location: { set href(value) { went.push(new URL(value, 'https://player.example')); } } },
    sessionStorage: memoryStorage(), localStorage: memoryStorage(),
    libraryActionsEl: element('libraryActions'), gridControlsEl: element('gridControls'), viewSwitchEl: { hidden: true },
    gridState: { items: gridItems },
    currentLibraryId: '1', currentView: null, currentShowKey: null, currentSeasonKey: null,
    writeBrowseView: (params, view) => { if (view.tab) params.set('tab', view.tab); },
    musicHost: { supported: () => musicHeld, start: params => heldMusic.push(params) },
    showLoadError: (err) => { throw err; },
    ...musicQueue, isResumable, onDeckIndex,
  };
  vm.runInNewContext(`${section('    // Resume a bit before the stored offset', '    function playItem(')}
    ${section('    // Videos (`video`) play one after another', '    // The list a track was clicked in')}
    ${section('    // Play and Shuffle above a movie library', '    async function openShowSeasons(')}
    globalThis.page = { playQueue, episodeActions, offerLibraryPlay };`, context);
  return { ...context.page, element, went, heldMusic, storage: context.sessionStorage };
}

const episode = (ratingKey, fields = {}) => ({ ratingKey, type: 'episode', title: `Episode ${ratingKey}`, durationMs: 1800000, viewOffset: 0, viewCount: 0, ...fields });
const queueOf = (page) => musicQueue.readQueue(page.storage, page.went[0].searchParams.get('videoQueue'));

test('Play on a show or season starts at the on-deck episode, resuming it, and queues the rest in order', async () => {
  const page = browse({ musicHeld: true });
  const episodes = [episode('1', { viewCount: 1 }), episode('2', { viewOffset: 600000 }), episode('3'), { ratingKey: 'x', type: 'track' }];
  await page.episodeActions('Season 1', async () => episodes).play();
  const target = page.went[0];
  assert.equal(target.pathname, '/canvas2', 'a video goes to the player, never into the music frame');
  assert.equal(page.heldMusic.length, 0);
  assert.equal(target.searchParams.get('key'), '2');
  assert.equal(target.searchParams.get('resume'), '597');
  assert.equal(target.searchParams.get('queue'), null, 'the player would take that for music');
  assert.equal(target.searchParams.get('tab'), '1');
  const queue = queueOf(page);
  assert.deepEqual(queue.items.map(item => item.ratingKey), ['1', '2', '3'], 'only episodes');
  assert.equal(queue.index, 1);
  assert.equal(queue.label, 'Season 1');
});

test('Shuffle mixes every episode and starts the first from its beginning', async () => {
  const page = browse();
  const episodes = ['1', '2', '3', '4'].map(key => episode(key, { viewOffset: 600000 }));
  await page.episodeActions('A Show', async () => episodes).shuffle();
  assert.equal(page.went[0].searchParams.get('resume'), null);
  const queue = queueOf(page);
  assert.equal(queue.shuffled, true);
  assert.deepEqual([...queue.items.map(item => item.ratingKey)].sort(), ['1', '2', '3', '4']);
  assert.equal(page.went[0].searchParams.get('key'), queue.items[0].ratingKey);
});

test('a movie library offers Play and Shuffle for the movies listed, when there is more than one', () => {
  const movies = [{ ratingKey: '7', type: 'movie', title: 'A' }, { ratingKey: '8', type: 'movie', title: 'B' }];
  const page = browse({ gridItems: movies });
  page.offerLibraryPlay({ id: '1', title: 'Music Videos', type: 'movie' });
  assert.equal(page.element('libraryActions').hidden, false);
  assert.equal(page.element('gridControls').hidden, false);
  page.element('libraryPlay').click();
  assert.equal(page.went[0].searchParams.get('key'), '7');
  assert.equal(queueOf(page).label, 'Music Videos');

  for (const [lib, items] of [[{ type: 'show' }, movies], [{ type: 'movie' }, movies.slice(0, 1)]]) {
    const other = browse({ gridItems: items });
    other.offerLibraryPlay({ id: '1', title: 'Other', ...lib });
    assert.equal(other.element('libraryActions').hidden, true);
    assert.equal(other.element('gridControls').hidden, true);
  }
});
