import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// recovery: false, true (the old recovery=1), or a query string such as
// `recovery=<ms>`.
function watchdog(recovery = false) {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const start = html.indexOf('      const STALL_TIMEOUT_MS =');
  const end = html.indexOf('      // Sample the Canvas player', start);
  assert.ok(start > 0 && end > start);
  let now = 0;
  const reloads = [];
  const banners = [];
  const context = {
    performance: { now: () => now },
    isLive: false, downgrading: false, currentQuality: 'low',
    urlParams: new URLSearchParams(typeof recovery === 'string' ? recovery : recovery ? 'recovery=1' : ''),
    downgradeQuality: () => false,
    reloadPlayback: (...args) => reloads.push(args),
    showBanner: message => banners.push(message),
  };
  vm.runInNewContext(`${html.slice(start, end)}; globalThis.check = watchForStall;`, context);
  return { context, reloads, banners, tick(time, state, mediaTime = 0) {
    now = time;
    context.check({ state, mediaTime });
  } };
}

test('startup buffering does not reload away the accumulating audio buffer', () => {
  const monitor = watchdog();
  monitor.tick(0, 'buffering');
  monitor.tick(30000, 'buffering');
  monitor.tick(60000, 'buffering');
  assert.equal(monitor.reloads.length, 0);
});

test('a later stall retries once at the lowest tier', () => {
  const monitor = watchdog();
  monitor.tick(0, 'playing', 1);
  monitor.tick(21000, 'buffering', 1);
  assert.equal(monitor.reloads.length, 1);
  assert.equal(monitor.reloads[0][0], 'low');
  assert.equal(monitor.reloads[0][1].recovery, true);

  const retry = watchdog(true);
  retry.tick(0, 'playing', 1);
  retry.tick(21000, 'buffering', 1);
  assert.equal(retry.reloads.length, 0);
  assert.match(retry.banners[0], /stalled/);
});

test('a recovery long ago does not stop a new stall from retrying', () => {
  const recent = watchdog(`recovery=${Date.now() - 10000}`);
  recent.tick(0, 'playing', 1);
  recent.tick(21000, 'buffering', 1);
  assert.equal(recent.reloads.length, 0, 'a failure right after a recovery stops instead of looping');

  const old = watchdog(`recovery=${Date.now() - 600000}`);
  old.tick(0, 'playing', 1);
  old.tick(21000, 'buffering', 1);
  assert.equal(old.reloads.length, 1, 'a failure ten minutes after a recovery gets its own retry');
});

// The error handler from canvas2.html, with the page's helpers replaced.
function errorRecovery({ directAttempt = false, recentlyRecovered = false } = {}) {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const start = html.indexOf('      // Set once the page starts navigating away');
  const end = html.indexOf('      const READ_AHEAD_SECONDS', start);
  assert.ok(start > 0 && end > start);
  const listeners = {};
  const calls = { reloads: [], banners: [], proxy: 0 };
  const context = {
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    directAttempt, currentQuality: 'high',
    recentlyRecovered: () => recentlyRecovered,
    fallbackToProxy: () => { calls.proxy += 1; },
    reloadPlayback: (...args) => calls.reloads.push(args),
    showBanner: message => calls.banners.push(message),
  };
  vm.runInNewContext(`${html.slice(start, end)}; globalThis.recover = recoverFromError;`, context);
  return { recover: context.recover, calls, leave: () => listeners.beforeunload() };
}

test('an on-demand stream that errors after starting is restarted where it was', () => {
  const { recover, calls } = errorRecovery();
  recover();
  // JSON, since the object was created inside the vm context.
  assert.equal(JSON.stringify(calls.reloads), JSON.stringify([['high', { recovery: true }]]));
  assert.match(calls.banners[0], /Reconnecting/);
  assert.equal(calls.proxy, 0);
});

test('error recovery falls back to the relay for direct playback, and gives up after a recent retry', () => {
  const direct = errorRecovery({ directAttempt: true });
  direct.recover();
  assert.equal(direct.calls.proxy, 1);
  assert.equal(direct.calls.reloads.length, 0);

  const retried = errorRecovery({ recentlyRecovered: true });
  retried.recover();
  assert.equal(retried.calls.reloads.length, 0);
  assert.match(retried.calls.banners[0], /Leave and reopen/);
});

test('an error while leaving the page never pulls the viewer back into the player', () => {
  const { recover, calls, leave } = errorRecovery();
  leave();
  recover();
  assert.equal(calls.reloads.length, 0);
  assert.equal(calls.banners.length, 0);
});
