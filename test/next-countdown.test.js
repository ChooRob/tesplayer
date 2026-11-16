import test from 'node:test';
import assert from 'node:assert/strict';
import { createNextCountdown, NEXT_COUNTDOWN_SECONDS } from '../public/engine/next-countdown.js';

function fakeTimers() {
  let callback = null;
  return {
    setIntervalFn: fn => { callback = fn; return 1; },
    clearIntervalFn: () => { callback = null; },
    tick: () => callback?.(),
    get running() { return callback !== null; },
  };
}

test('counts down once a second and then moves on', () => {
  const timers = fakeTimers();
  const ticks = [];
  let done = 0;
  const countdown = createNextCountdown({ seconds: 3, onTick: n => ticks.push(n), onDone: () => { done += 1; }, ...timers });
  assert.equal(countdown.start(), true);
  assert.equal(countdown.active, true);
  timers.tick(); timers.tick();
  assert.deepEqual(ticks, [3, 2, 1]);
  assert.equal(done, 0);
  timers.tick();
  assert.equal(done, 1);
  assert.equal(countdown.active, false);
  assert.equal(timers.running, false);
});

test('cancel stops the countdown without moving on', () => {
  const timers = fakeTimers();
  let done = 0;
  const countdown = createNextCountdown({ seconds: 5, onDone: () => { done += 1; }, ...timers });
  countdown.start();
  assert.equal(countdown.cancel(), true);
  timers.tick();
  assert.equal(done, 0);
  assert.equal(countdown.active, false);
  assert.equal(countdown.cancel(), false);
});

test('a second start while counting does not restart it', () => {
  const timers = fakeTimers();
  const countdown = createNextCountdown({ seconds: 5, ...timers });
  assert.equal(countdown.start(), true);
  assert.equal(countdown.start(), false);
});

test('can start again after cancelling', () => {
  const timers = fakeTimers();
  const countdown = createNextCountdown({ seconds: 2, ...timers });
  countdown.start();
  countdown.cancel();
  assert.equal(countdown.start(), true);
});

test('the default wait is a few seconds', () => {
  assert.ok(NEXT_COUNTDOWN_SECONDS >= 3 && NEXT_COUNTDOWN_SECONDS <= 10);
});
