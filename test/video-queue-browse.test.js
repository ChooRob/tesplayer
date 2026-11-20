import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as musicQueue from '../public/music-queue.js';

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
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { id, hidden: true, onclick: null, title: '', textContent: '', click() { return this.onclick?.(); },
        classList: { toggle: (name, on) => { classes[on ? 'add' : 'delete'](name); }, contains: name => classes.has(name) } });
    }
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
    ...musicQueue,
  };
  vm.runInNewContext(`${section('    // Resume a bit before the stored offset', '    function playItem(')}
    ${section('    // Videos (`video`) play one after another', '    // The list a track was clicked in')}
    ${section('    // Above a library of films, its films as listed.', '    async function openShowSeasons(')}
    globalThis.page = { playQueue, offerLibraryPlay };`, context);
  return { ...context.page, element, went, heldMusic, storage: context.sessionStorage };
}

const episode = (ratingKey, fields = {}) => ({ ratingKey, type: 'episode', title: `Episode ${ratingKey}`, durationMs: 1800000, viewOffset: 0, viewCount: 0, ...fields });
const queueOf = (page) => musicQueue.readQueue(page.storage, page.went[0].searchParams.get('videoQueue'));

test('a library of videos has Play (from the top) and Shuffle; it goes to the player and queues every film', () => {
  const films = [{ ratingKey: '7', type: 'movie', title: 'A', viewOffset: 600000, durationMs: 1800000 }, { ratingKey: '8', type: 'movie', title: 'B' }];
  const page = browse({ gridItems: films, musicHeld: true });
  page.offerLibraryPlay({ id: '1', title: 'Music Videos', type: 'video' });
  assert.equal(page.element('libraryActions').hidden, false);
  assert.equal(page.element('gridControls').hidden, false);
  assert.equal(page.element('libraryPlay').hidden, false, 'Play and Shuffle both');
  assert.equal(page.element('libraryShuffleLabel').textContent, 'Shuffle');
  assert.equal(page.element('libraryShuffle').classList.contains('primary'), false);
  page.element('libraryPlay').click();
  const target = page.went[0];
  assert.equal(target.pathname, '/canvas2', 'a video goes to the player, never into the music frame');
  assert.equal(page.heldMusic.length, 0);
  assert.equal(target.searchParams.get('key'), '7');
  assert.equal(target.searchParams.get('resume'), '597', 'in order, the first film resumes where it was left');
  assert.equal(target.searchParams.get('queue'), null, 'the player would take that for music');
  assert.equal(queueOf(page).label, 'Music Videos');
  assert.deepEqual(queueOf(page).items.map(item => item.ratingKey), ['7', '8']);
});

test('a library of movies has one button, Play something, which shuffles them and starts the first from the beginning', () => {
  const films = ['1', '2', '3', '4'].map(key => ({ ratingKey: key, type: 'movie', title: `Film ${key}`, viewOffset: 600000, durationMs: 1800000 }));
  const page = browse({ gridItems: films });
  page.offerLibraryPlay({ id: '1', title: 'Movies', type: 'movie' });
  assert.equal(page.element('libraryActions').hidden, false);
  assert.equal(page.element('libraryPlay').hidden, true, 'no separate Play');
  assert.equal(page.element('libraryShuffleLabel').textContent, 'Play something');
  assert.equal(page.element('libraryShuffle').classList.contains('primary'), true);
  page.element('libraryShuffle').click();
  assert.equal(page.went[0].searchParams.get('resume'), null, 'a shuffle starts each film from its beginning');
  const queue = queueOf(page);
  assert.equal(queue.shuffled, true);
  assert.deepEqual([...queue.items.map(item => item.ratingKey)].sort(), ['1', '2', '3', '4']);
  assert.equal(page.went[0].searchParams.get('key'), queue.items[0].ratingKey);
});

test('nothing is offered above a show library or a library with one film', () => {
  const films = [{ ratingKey: '7', type: 'movie', title: 'A' }, { ratingKey: '8', type: 'movie', title: 'B' }];
  for (const [lib, items] of [[{ type: 'show' }, films], [{ type: 'music' }, films], [{ type: 'movie' }, films.slice(0, 1)], [{ type: 'video' }, films.slice(0, 1)]]) {
    const other = browse({ gridItems: items });
    other.offerLibraryPlay({ id: '1', title: 'Other', ...lib });
    assert.equal(other.element('libraryActions').hidden, true);
    assert.equal(other.element('gridControls').hidden, true);
  }
});

test('every other screen hides the bar (a plugin tab such as Live TV, a show, a search), and the page imports one resume test', () => {
  assert.match(html, /function hideDetailHeader\(\) \{\s+\/\/[^\n]*\n\s+libraryActionsEl\.hidden = true;/);
  assert.match(html, /import \{ createQueue, saveQueue, readQueue, MAX_QUEUE, isResumable \} from "\/music-queue\.js";/);
  assert.doesNotMatch(html, /episodeActions|onDeckIndex|on-deck/, 'no Play and Shuffle for shows and seasons');
});
