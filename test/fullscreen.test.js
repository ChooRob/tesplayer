import test from 'node:test';
import assert from 'node:assert/strict';
import { fullscreenMode, goFullscreen } from '../public/fullscreen.js';
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
    assert.equal(new URL(destination).searchParams.get('q'), url);
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
    assert.equal(new URL(destination).searchParams.get('q'), 'https://example.test/player');
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
  assert.equal(new URL(destination).searchParams.get('q'), url);
});
