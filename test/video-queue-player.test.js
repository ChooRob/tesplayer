import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNextCountdown } from '../public/engine/next-countdown.js';
import { carryBrowseView } from '../public/browse-location.js';
import * as musicQueue from '../public/music-queue.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); } };
}

// The player's next-item section, run against stub elements, for a video whose address is `search`
// and a tab whose session storage is `storage`.
function player(search, storage) {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const start = html.indexOf('      // The next episode of a show.');
  const end = html.indexOf('      // Use the supplied title', start);
  assert.ok(start > 0 && end > start);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const listeners = {};
      elements.set(id, {
        id, hidden: true, disabled: false, title: '', textContent: '', attributes: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        firstElementChild: { textContent: '' },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, fn) { listeners[type] = fn; },
        replaceChildren() {}, append() {}, querySelector: () => null,
        click() { listeners.click?.(); },
      });
    }
    return elements.get(id);
  };
  const replaced = [];
  const urlParams = new URLSearchParams(search);
  const context = {
    URL, URLSearchParams, Promise, setTimeout, clearTimeout, console,
    location: { search, origin: 'https://player.example', replace: url => replaced.push(new URL(url)) },
    document: { getElementById: element, createElement: () => element(`new-${Math.random()}`), addEventListener() {} },
    showOverlay() {},
    sessionStorage: storage, localStorage: memoryStorage(),
    urlParams, itemKey: urlParams.get('key'), isLive: false, embedded: false,
    player: { duration: 200, clock: { currentTime: 100 }, seek() {} },
    selection: { mode: 'canvas' },
    titleDisplayEl: element('titleDisplay'),
    iconEl: () => ({}),
    window: { addEventListener() {}, parent: null },
    createNextCountdown, carryBrowseView, ...musicQueue,
  };
  vm.runInNewContext(`${html.slice(start, end)};
    globalThis.page = {
      state: () => ({ queue, queueIndex, nextEpisode, queueData }),
      startVideoQueue, playNextEpisode, startNextCountdown, nextCountdown,
      setTitle: (title) => { videoTitle = title; },
      setNext: (value) => { nextEpisode = value; },
    };`, context);
  return { ...context.page, element, replaced, context };
}

const videos = ['10', '11', '12'].map((ratingKey, at) => ({ ratingKey, title: `Video ${at + 1}`, type: 'movie' }));
function saved(options = {}) {
  const storage = memoryStorage();
  const queue = musicQueue.createQueue({ label: 'Music Videos', items: videos, id: 'q1', ...options });
  musicQueue.saveQueue(storage, queue);
  return storage;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const started = (search, storage, title = 'Video') => {
  const page = player(search, storage);
  page.setTitle(title);
  if (page.state().queueData) page.startVideoQueue(); // as the page does once the video's details arrive
  return page;
};

test('a queued video offers the next one, and Next goes to it with the queue and the screen to go back to', async () => {
  const storage = saved({ start: 1 });
  const page = started('?key=11&videoQueue=q1&tab=2&show=5&season=6&playback=standard', storage, 'Video 2');
  assert.equal(page.element('prevTrackBtn').hidden, false);
  assert.equal(page.element('nextTrackBtn').hidden, false);
  assert.equal(page.element('titleDisplay').textContent, 'Playing · 2 of 3 · Video 2');
  assert.equal(page.state().nextEpisode.ratingKey, '12');
  page.element('nextTrackBtn').click();
  await tick();
  const target = page.replaced[0];
  assert.equal(target.pathname, '/canvas2');
  assert.equal(target.searchParams.get('key'), '12');
  assert.equal(target.searchParams.get('videoQueue'), 'q1');
  assert.equal(target.searchParams.get('queue'), null, 'not taken for music');
  assert.equal(target.searchParams.get('playback'), 'standard');
  assert.equal(target.searchParams.get('tab'), '2');
  assert.equal(musicQueue.readQueue(storage, 'q1').index, 2, 'the position is kept for the next page');
});

test('the countdown at the end of a video moves on through the queue', async () => {
  const page = started('?key=10&videoQueue=q1', saved());
  page.playNextEpisode({ auto: true });
  await tick();
  assert.equal(page.replaced[0].searchParams.get('key'), '11');
});

test('the end of a queue stops, unless it repeats', async () => {
  const last = started('?key=12&videoQueue=q1', saved({ start: 2 }));
  assert.equal(last.state().nextEpisode, null);
  assert.equal(last.element('nextTrackBtn').disabled, true);
  last.startNextCountdown();
  assert.equal(last.nextCountdown.active, false, 'nothing to count down to');

  const round = started('?key=12&videoQueue=q1', saved({ start: 2, repeat: 'all' }));
  assert.equal(round.state().nextEpisode.ratingKey, '10');
  round.playNextEpisode({ auto: true });
  await tick();
  assert.equal(round.replaced[0].searchParams.get('key'), '10');

  const again = started('?key=12&videoQueue=q1', saved({ start: 2, repeat: 'one' }));
  again.playNextEpisode({ auto: true });
  await tick();
  assert.equal(again.replaced[0].searchParams.get('key'), '12', 'one video repeats when it ends by itself');
});

test('Previous restarts a video that has played a while, else goes to the one before', async () => {
  const page = started('?key=11&videoQueue=q1', saved({ start: 1 }));
  const seeks = [];
  page.context.player.seek = (seconds) => seeks.push(seconds);
  page.element('prevTrackBtn').click();
  await tick();
  assert.deepEqual(seeks, [0]);
  assert.equal(page.replaced.length, 0, 'restarted, not moved');
  page.context.player.clock.currentTime = 2;
  page.element('prevTrackBtn').click();
  await tick();
  assert.equal(page.replaced[0].searchParams.get('key'), '10');
});

test('shuffling in the player keeps the video playing and mixes the rest', () => {
  const page = started('?key=10&videoQueue=q1', saved(), 'Video 1');
  page.element('shuffleBtn').click();
  assert.match(page.element('titleDisplay').textContent, /^Shuffled · 1 of 3 · Video 1$/);
  assert.notEqual(page.state().nextEpisode.ratingKey, '10');
});

test('an address whose queue is not this tab\'s plays the video alone', () => {
  for (const search of ['?key=99&videoQueue=q1', '?key=11&videoQueue=other']) {
    const page = started(search, saved());
    assert.equal(page.element('prevTrackBtn').hidden, true, search);
    assert.equal(page.state().queue.length, 0, search);
    assert.equal(page.state().queueData, null, search);
  }
});

test('without a queue, Play Next goes to the show\'s next episode as before', () => {
  const page = player('?key=11&show=5', memoryStorage());
  page.setNext({ ratingKey: '12', title: 'Next One' });
  page.playNextEpisode();
  assert.equal(page.replaced[0].searchParams.get('key'), '12');
  assert.equal(page.replaced[0].searchParams.get('videoQueue'), null);
  assert.equal(page.element('nextTrackBtn').hidden, true);
});
