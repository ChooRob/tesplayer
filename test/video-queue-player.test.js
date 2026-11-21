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
        replaceChildren(...kids) { this.children = kids; }, append(...kids) { (this.children ??= []).push(...kids); },
        querySelector: () => null, listeners,
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

const filmsOf = count => Array.from({ length: count }, (_, at) => ({ ratingKey: String(100 + at), title: `Film ${at + 1}`, type: 'movie', durationMs: 5400000 }));
const longQueue = (count, start) => {
  const storage = memoryStorage();
  musicQueue.saveQueue(storage, musicQueue.createQueue({ label: 'Movies', items: filmsOf(count), id: 'q1', start }));
  return storage;
};
const rowsOf = page => page.element('videoQueueList').children;

test('the queue button appears with a film queue and opens a window of 40 around the film playing', () => {
  const page = started('?key=130&videoQueue=q1', longQueue(100, 30), 'Film 31');
  assert.equal(page.element('queueBtn').hidden, false);
  assert.equal(page.element('videoQueue').hidden, true, 'closed until it is asked for');
  page.element('queueBtn').click();
  assert.equal(page.element('videoQueue').hidden, false);
  assert.equal(page.element('queueBtn').attributes['aria-pressed'], 'true');
  const rows = rowsOf(page);
  const films = rows.filter(row => /^q( |$)/.test(row.className));
  assert.equal(films.length, 40);
  assert.deepEqual(rows.filter(row => row.className === 'qNote').map(row => row.textContent), ['20 earlier', '40 more']);
  assert.equal(films.filter(row => row.className.includes('played')).length, 10, 'the last 10 played, dimmed');
  assert.equal(films.findIndex(row => row.className.includes('current')), 10);
  assert.equal(page.element('videoQueueLabel').textContent, 'Playing in order · 100 films');
  assert.equal(page.element('videoQueueName').textContent, 'Movies');
});

test('tapping a film in the queue plays it, with the queue; tapping the one playing closes the panel', async () => {
  const storage = longQueue(100, 30);
  const page = started('?key=130&videoQueue=q1&tab=1', storage, 'Film 31');
  page.element('queueBtn').click();
  const films = rowsOf(page).filter(row => /^q( |$)/.test(row.className));
  films[12].children[0].listeners.click(); // two films ahead of the current one (index 10)
  await tick();
  const target = page.replaced[0];
  assert.equal(target.searchParams.get('key'), '132');
  assert.equal(target.searchParams.get('videoQueue'), 'q1');
  assert.equal(target.searchParams.get('tab'), '1');
  assert.equal(musicQueue.readQueue(storage, 'q1').index, 32, 'the position is kept for the next page');
  films[10].children[0].listeners.click();
  assert.equal(page.element('videoQueue').hidden, true, 'the film playing closes it');
});

test('the panel stays open from one film to the next, and Escape or the button closes it', () => {
  const storage = longQueue(100, 5);
  const first = started('?key=105&videoQueue=q1', storage, 'Film 6');
  first.element('queueBtn').click();
  const stored = first.context.sessionStorage.getItem('freeStuffCrazyPlayer.queueOpen');
  assert.equal(stored, '1', 'remembered for the next page');
  const next = started('?key=106&videoQueue=q1', first.context.sessionStorage, 'Film 7');
  assert.equal(next.element('videoQueue').hidden, false, 'open on the next film without being asked');
  next.element('queueBtn').click();
  assert.equal(next.element('videoQueue').hidden, true);
  assert.equal(next.context.sessionStorage.getItem('freeStuffCrazyPlayer.queueOpen'), '0');
});

test('a shuffled queue that repeats goes round again in a new order, never opening on the film just played', async () => {
  const films = Array.from({ length: 6 }, (_, at) => ({ ratingKey: String(200 + at), title: `Film ${at + 1}`, type: 'movie' }));
  for (let round = 0; round < 40; round++) {
    const storage = memoryStorage();
    const queue = musicQueue.createQueue({ label: 'Movies', items: films, shuffle: true, repeat: 'all', id: 'q1' });
    musicQueue.saveQueue(storage, musicQueue.withIndex(queue, 5));
    const last = queue.items[5].ratingKey;
    const page = started(`?key=${last}&videoQueue=q1`, storage, 'The last');
    page.playNextEpisode({ auto: true });
    await tick();
    const target = page.replaced[0];
    assert.notEqual(target.searchParams.get('key'), last, 'not the one just played');
    const again = musicQueue.readQueue(storage, 'q1');
    assert.equal(again.index, 0);
    assert.equal(again.items[0].ratingKey, target.searchParams.get('key'), 'it opens on the first of the new order');
    assert.deepEqual(again.items.map(item => item.ratingKey).sort(), films.map(item => item.ratingKey).sort());
    assert.equal(again.shuffled, true);
  }
});

test('an in-order queue that repeats goes round in the same order, and a shuffled one that does not repeat stops', async () => {
  const films = Array.from({ length: 4 }, (_, at) => ({ ratingKey: String(300 + at), title: `Film ${at + 1}`, type: 'movie' }));
  const storage = memoryStorage();
  musicQueue.saveQueue(storage, musicQueue.withIndex(musicQueue.createQueue({ label: 'Movies', items: films, repeat: 'all', id: 'q1' }), 3));
  const inOrder = started('?key=303&videoQueue=q1', storage, 'The last');
  inOrder.playNextEpisode({ auto: true });
  await tick();
  assert.equal(inOrder.replaced[0].searchParams.get('key'), '300', 'back to the first');
  assert.deepEqual(musicQueue.readQueue(storage, 'q1').items.map(item => item.ratingKey), ['300', '301', '302', '303'], 'the same order');

  const stopped = memoryStorage();
  const shuffled = musicQueue.createQueue({ label: 'Movies', items: films, shuffle: true, id: 'q2' });
  musicQueue.saveQueue(stopped, musicQueue.withIndex(shuffled, 3));
  const end = started(`?key=${shuffled.items[3].ratingKey}&videoQueue=q2`, stopped, 'The last');
  end.playNextEpisode({ auto: true });
  await tick();
  assert.equal(end.replaced.length, 0, 'without repeat it ends');
});

test('the adjustments and captions panels come above the music screen while they are open, so their sliders take taps', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /#musicCover \{ position: fixed; z-index: 5;/);
  assert.match(html, /body:has\(#dimPanel:not\(\[hidden\]\)\) #overlay, body:has\(#ccPanel:not\(\[hidden\]\)\) #overlay \{ z-index: 6; \}/);
});

test('music has no Size or Move controls, and a size saved for films is not applied to it', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /id="sizeRow"/);
  assert.match(html, /id="moveRow"/);
  assert.match(html, /const musicPage = new URLSearchParams\(location\.search\)\.has\('queue'\);\s+setupFullscreenButton/);
  assert.match(html, /if \(musicPage\) document\.getElementById\('fullscreenBtn'\)\.hidden = true;/, 'no fullscreen button for music');
  assert.match(html, /body:has\(#musicCover:not\(\[hidden\]\)\) #dimLayer \{ z-index: 5; \}/, 'dim covers the whole music screen');
  assert.match(html, /if \(musicPage\) \{ document\.getElementById\('sizeRow'\)\.hidden = true; document\.getElementById\('moveRow'\)\.hidden = true; \}/);
  assert.match(html, /const shown = musicPage \? CENTERED : picture;/);
  assert.doesNotMatch(html, /layer === '1'/, 'the repaint experiment is gone');
});

test('an MCU3 reads further ahead of a film, and may hold more of it; other devices keep the usual amounts', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /const READ_AHEAD_SECONDS = \{ low: 60, medium: 30, high: 0 \};/, 'the usual amounts');
  assert.match(html, /const MCU3_READ_AHEAD_SECONDS = \{ low: 90, medium: 60, high: 60, ultra: 30 \};/);
  assert.match(html, /const MCU2_READ_AHEAD_SECONDS = \{ \.\.\.READ_AHEAD_SECONDS, high: 10 \};/, 'an MCU2 gets only a little, at High');
  assert.match(html, /const filmReadAhead = \{ mcu3: MCU3_READ_AHEAD_SECONDS, mcu2: MCU2_READ_AHEAD_SECONDS \}\[thisDevice\(\)\] \|\| READ_AHEAD_SECONDS;/);
  assert.match(html, /const readAheadMaxBytes = !queueData && isMcu3\(\) \? MCU3_READ_AHEAD_MAX_BYTES : undefined;/, 'music keeps its own limit');
  const player = readFileSync(new URL('../public/engine/player.js', import.meta.url), 'utf8');
  assert.match(player, /new SegmentPrefetcher\(\{ readAheadSeconds, maxBytes: readAheadMaxBytes,/);
});

test('a queue of videos moves on at the end with no countdown; only a show\'s episodes count down', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  // A track or a queued video is followed at once.
  assert.match(html, /function startNextCountdown\(\) \{\s*if \(queue\.length && !movingOn\) \{ goNext\(\{ auto: true \}\); return; \}/);
  // ...and has no Play Next button, since the controls have Next.
  assert.match(html, /if \(isMusic \|\| queue\.length\) \{ playNextBtn\.hidden = true; return; \}/);
});
