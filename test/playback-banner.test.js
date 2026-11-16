import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackBanner } from '../public/playback-banner.js';
function setup() {
  const classes = new Set();
  const element = { onclick: null, classList: {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
  } };
  let nextId = 0;
  const timers = new Map();
  const banner = createPlaybackBanner(element, {
    schedule(fn) { const id = ++nextId; timers.set(id, fn); return id; },
    cancel(id) { timers.delete(id); },
  });
  return { element, classes, timers, banner };
}
test('expired resume banner cannot intercept a fullscreen click and restart playback', () => {
  const { element, classes, timers, banner } = setup();
  let restarts = 0;
  banner.show('Resume', { onClick: () => restarts++ });
  assert.equal(classes.has('clickable'), true);
  [...timers.values()][0]();
  assert.equal(classes.has('visible'), false);
  assert.equal(classes.has('clickable'), false);
  assert.equal(element.onclick, null);
  element.onclick?.();
  assert.equal(restarts, 0);
});
test('replacing a resume banner clears its old timer and action', () => {
  const { element, classes, timers, banner } = setup();
  banner.show('Resume', { onClick: () => assert.fail('Stale restart action') });
  banner.show('Reconnecting', { persist: true });
  assert.equal(timers.size, 0);
  assert.equal(element.onclick, null);
  assert.equal(classes.has('visible'), true);
  assert.equal(classes.has('clickable'), false);
  banner.hide();
  assert.equal(classes.has('visible'), false);
});
