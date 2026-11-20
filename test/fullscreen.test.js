import test from 'node:test';
import assert from 'node:assert/strict';
import { fullscreenMode, goFullscreen, isTeslaBrowser, looksLikeCarBrowser, teslaOverride, noteTeslaFullscreen, inTeslaFullscreen, TESLA_RETURN_MARK } from '../public/fullscreen.js';
// The address the Tesla way comes back to, without the mark it adds (see noteTeslaFullscreen).
const returnOf = (destination) => { const back = new URL(new URL(destination).searchParams.get('q')); back.searchParams.delete(TESLA_RETURN_MARK); return back.href; };
const base = () => ({ documentElement: {}, fullscreenEnabled: false });
test('ordinary browsers fullscreen the whole page and toggle exit', async () => {
  let calls = 0;
  const doc = { fullscreenEnabled: true, documentElement: { requestFullscreen() { calls++; } }, exitFullscreen() { calls--; } };
  await goFullscreen({ doc, tesla: false, url: 'http://localhost' });
  assert.equal(calls, 1);
  doc.fullscreenElement = doc.documentElement;
  await goFullscreen({ doc, tesla: false, url: 'http://localhost' });
  assert.equal(calls, 0);
});
test('Safari video fallback requires an active, loaded Standard player', () => {
  const video = { hidden: false, style: {}, readyState: 1, webkitSupportsFullscreen: true, webkitEnterFullscreen() {} };
  assert.equal(fullscreenMode(base(), video), 'video');
  video.hidden = true;
  assert.equal(fullscreenMode(base(), video), 'unavailable');
  video.hidden = false; video.readyState = 0;
  assert.equal(fullscreenMode(base(), video), 'unavailable');
});
test('native video fullscreen supports entry and exit', async () => {
  const video = { hidden: false, style: {}, readyState: 1, webkitEnterFullscreen() { this.webkitDisplayingFullscreen = true; }, webkitExitFullscreen() { this.webkitDisplayingFullscreen = false; } };
  const options = { doc: base(), video, tesla: false, url: 'http://localhost' };
  await goFullscreen(options); assert.equal(video.webkitDisplayingFullscreen, true);
  await goFullscreen(options); assert.equal(video.webkitDisplayingFullscreen, false);
});
test('denied or unsupported fullscreen never redirects ordinary browsers', async () => {
  let redirected = false;
  const options = { doc: base(), tesla: false, url: 'http://localhost', navigate() { redirected = true; } };
  await assert.rejects(goFullscreen(options));
  options.doc = { fullscreenEnabled: true, documentElement: { requestFullscreen() { return Promise.reject(new Error('denied')); } } };
  await assert.rejects(goFullscreen(options));
  assert.equal(redirected, false);
});

test('Canvas fullscreens the root even when a hidden native video exists', async () => {
  let rootUsed = false;
  const root = { requestFullscreen() { rootUsed = this === root; } };
  const video = { hidden: true, style: {}, readyState: 1, webkitEnterFullscreen() { throw Error('Hidden video must not fullscreen'); } };
  await goFullscreen({ doc: { documentElement: root, fullscreenEnabled: true }, video, tesla: false, url: 'http://localhost' });
  assert.equal(rootUsed, true);
});

test('Tesla uses its dedicated path with absent or unusable fullscreen APIs', async () => {
  const url = 'https://example.test/canvas2.html?live=1&streamId=123';
  for (const doc of [base(), { fullscreenEnabled: true, documentElement: { requestFullscreen() { return Promise.reject(new Error('denied')); } } }, { webkitFullscreenEnabled: true, documentElement: { webkitRequestFullscreen() { throw Error('denied'); } } }]) {
    let destination;
    await goFullscreen({ doc, tesla: true, url, navigate(value) { destination = value; } });
    assert.equal(new URL(destination).origin, 'https://www.youtube.com');
    assert.equal(returnOf(destination), url);
  }
});

test('Tesla always redirects even with working page or native video fullscreen APIs', async () => {
  let requested = false;
  const doc = { fullscreenEnabled: true, documentElement: { requestFullscreen() { requested = true; } } };
  const video = { hidden: false, style: {}, readyState: 1, webkitEnterFullscreen() { requested = true; } };
  for (const fullscreenElement of [null, doc.documentElement]) {
    doc.fullscreenElement = fullscreenElement;
    let destination;
    assert.equal(fullscreenMode(doc, video, true), 'tesla');
    await goFullscreen({ doc, video, tesla: true, url: 'https://example.test/player', navigate(url) { destination = url; } });
    assert.equal(returnOf(destination), 'https://example.test/player');
  }
  assert.equal(requested, false);
});

test('Tesla redirect carries the current VOD position and paused state', async () => {
  for (const paused of [true, false]) {
    let destination;
    await goFullscreen({ doc: base(), tesla: true,
      url: 'https://example.test/canvas2.html?key=42&resume=10&playback=standard',
      playback: { currentTime: 325.5, paused }, navigate(url) { destination = url; } });
    const returned = new URL(new URL(destination).searchParams.get('q'));
    assert.equal(returned.searchParams.get('resume'), '325.5');
    assert.equal(returned.searchParams.get('paused'), paused ? '1' : '0');
    assert.equal(returned.searchParams.get('key'), '42');
    assert.equal(returned.searchParams.get('playback'), 'standard');
  }
});

test('Tesla live streams rejoin live without adding VOD resume parameters', async () => {
  let destination;
  const url = 'https://example.test/canvas2.html?live=1&streamId=123';
  await goFullscreen({ doc: base(), tesla: true, url,
    playback: { currentTime: 100, paused: false }, navigate(value) { destination = value; } });
  assert.equal(returnOf(destination), url);
});

// What the car in the dev access log sends: Chrome on desktop Linux, no mention of Tesla.
const CAR = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

test('a browser that looks like a car\'s is spotted by its touchscreen, not by its name', () => {
  assert.equal(looksLikeCarBrowser({ userAgent: CAR, touchPoints: 10, coarsePointer: false, noHover: false }), true);
  assert.equal(looksLikeCarBrowser({ userAgent: CAR, touchPoints: 0, coarsePointer: true, noHover: false }), true);
  assert.equal(looksLikeCarBrowser({ userAgent: CAR, touchPoints: 0, coarsePointer: false, noHover: true }), true);
  // The same user agent on a desktop with a mouse is not a car.
  assert.equal(looksLikeCarBrowser({ userAgent: CAR, touchPoints: 0, coarsePointer: false, noHover: false }), false);
  for (const userAgent of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Mobile Safari/537.36',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  ]) assert.equal(looksLikeCarBrowser({ userAgent, touchPoints: 10, coarsePointer: true, noHover: true }), false, userAgent);
});

function carDoc({ takes }) {
  const doc = { fullscreenEnabled: true, documentElement: {} };
  doc.documentElement.requestFullscreen = takes === 'yes'
    ? () => { doc.fullscreenElement = doc.documentElement; return Promise.resolve(); }
    : takes === 'ignores' ? () => Promise.resolve() : () => Promise.reject(new Error('Fullscreen is not allowed'));
  return doc;
}
const carOptions = (doc, urls) => ({ doc, tesla: false, carLike: true, settleMs: 0, url: 'https://player.example/canvas2?key=5&quality=high', playback: { currentTime: 412.5, paused: false }, navigate: url => urls.push(url) });

test('on a car, Canvas fullscreen that the browser refuses or ignores uses the Tesla way, keeping the position', async () => {
  for (const takes of ['refuses', 'ignores']) {
    const urls = [];
    await goFullscreen(carOptions(carDoc({ takes }), urls));
    assert.equal(urls.length, 1, takes);
    assert.match(urls[0], /^https:\/\/www\.youtube\.com\/redirect\?q=/);
    const back = new URL(decodeURIComponent(urls[0].split('?q=')[1]));
    assert.equal(back.searchParams.get('resume'), '412.5', 'the player comes back where it was');
    assert.equal(back.searchParams.get('paused'), '0');
  }
});

test('on a car whose browser does fullscreen properly, nothing is redirected', async () => {
  const urls = [];
  await goFullscreen(carOptions(carDoc({ takes: 'yes' }), urls));
  assert.deepEqual(urls, []);
});

test('a car-like browser in the Standard player is handled the same way', async () => {
  const urls = [];
  const video = { hidden: false, style: {}, readyState: 4 };
  await goFullscreen({ ...carOptions(carDoc({ takes: 'refuses' }), urls), video });
  assert.equal(urls.length, 1);
});

test('an ordinary browser that refuses is still never redirected, even with a touchscreen', async () => {
  const urls = [];
  const options = { ...carOptions(carDoc({ takes: 'refuses' }), urls), carLike: false };
  await assert.rejects(goFullscreen(options));
  assert.deepEqual(urls, []);
});

test('a browser that says it is a Tesla always takes the Tesla way', async () => {
  const urls = [];
  await goFullscreen({ ...carOptions(carDoc({ takes: 'yes' }), urls), tesla: true });
  assert.equal(urls.length, 1);
  assert.equal(isTeslaBrowser('Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/601.1 (KHTML, like Gecko) Tesla/2023.44.30.8 Safari/601.1', { search: '', storage: null }), true);
  assert.equal(isTeslaBrowser(CAR, { search: '', storage: null }), false, 'the real car\'s user agent is not enough on its own');
});

test('?tesla=1 tells the player it is in a Tesla, is remembered, and ?tesla=0 forgets it', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  assert.equal(teslaOverride('', storage), null);
  assert.equal(teslaOverride('?tesla=1', storage), true);
  assert.equal(teslaOverride('', storage), true, 'remembered on later visits');
  assert.equal(isTeslaBrowser(CAR, { search: '', storage }), true);
  assert.equal(teslaOverride('?tesla=0', storage), false);
  assert.equal(teslaOverride('', storage), null, 'forgotten');
  assert.equal(teslaOverride('?tesla=maybe', storage), null, 'anything else is ignored');
  // Storage that throws (private browsing) still honours the address.
  const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
  assert.equal(teslaOverride('?tesla=1', broken), true);
  assert.equal(teslaOverride('', broken), null);
});

function memoryStorage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } };
}

test('the Tesla way marks its return with how tall the window was before', async () => {
  let destination;
  await goFullscreen({ doc: base(), tesla: true, url: 'https://example.test/canvas2?key=5', viewportHeight: () => 620, navigate(url) { destination = url; } });
  assert.equal(new URL(new URL(destination).searchParams.get('q')).searchParams.get(TESLA_RETURN_MARK), '620');
});

test('back in the car\'s fullscreen mode, the button is not offered until the window is shorter again', () => {
  const storage = memoryStorage();
  const replaced = [];
  const history = { state: null, replaceState: (_state, _title, url) => replaced.push(url) };
  noteTeslaFullscreen({ location: { href: `https://example.test/canvas2?key=5&${TESLA_RETURN_MARK}=620` }, history, storage, height: 760 });
  assert.deepEqual(replaced, ['https://example.test/canvas2?key=5'], 'the mark comes off the address');
  assert.equal(inTeslaFullscreen({ storage, height: 760 }), true);
  assert.equal(inTeslaFullscreen({ storage, height: 620 }), false, 'fullscreen left: the button is back');
  assert.equal(inTeslaFullscreen({ storage: memoryStorage(), height: 760 }), false, 'nothing noted, nothing hidden');
});

test('a car not in Park comes back without fullscreen, and the button stays', () => {
  const storage = memoryStorage();
  const history = { state: null, replaceState() {} };
  noteTeslaFullscreen({ location: { href: `https://example.test/browse?${TESLA_RETURN_MARK}=620` }, history, storage, height: 620 });
  assert.equal(inTeslaFullscreen({ storage, height: 620 }), false);
  noteTeslaFullscreen({ location: { href: 'https://example.test/browse' }, history, storage, height: 900 });
  assert.equal(inTeslaFullscreen({ storage, height: 900 }), false, 'an unmarked page notes nothing');
});

test('on a car, fullscreen that the browser says yes to but that does not fill the screen uses the Tesla way', async () => {
  for (const [after, redirected] of [[620, true], [760, false]]) {
    const urls = [];
    const doc = carDoc({ takes: 'yes' });
    let exited = false;
    doc.exitFullscreen = () => { exited = true; doc.fullscreenElement = null; return Promise.resolve(); };
    let calls = 0;
    await goFullscreen({ ...carOptions(doc, urls), viewportHeight: () => (calls++ ? after : 620) });
    assert.equal(urls.length === 1, redirected, `window ${after}px after`);
    assert.equal(exited, redirected, 'the empty fullscreen is left first');
  }
});
