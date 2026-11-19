import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The player lowers its quality (which restarts the stream) when frames are dropped
// for long enough. That is only right when the device can't decode fast enough.
function health() {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  const start = html.indexOf('      const DROP_RATE_SAMPLE_MS =');
  const end = html.indexOf('      // Reload the originating browse tab', start);
  assert.ok(start > 0 && end > start);
  let now = 0;
  const downgrades = [];
  const context = {
    performance: { now: () => now },
    streamLimitHandled: false, isLive: false, downgrading: false, playbackStarted: true,
    watchForStall() {},
    downgradeQuality: () => { downgrades.push(now); return true; },
  };
  vm.runInNewContext(`${html.slice(start, end)}; globalThis.check = watchPlaybackHealth;`, context);
  let drops = 0;
  // One second of playback: `dropped` frames dropped, `queue` decoded frames waiting.
  return { downgrades, second({ dropped, queue, state = 'playing' }) {
    now += 1000;
    drops += dropped;
    context.check({ state, videoDropCount: drops, videoQueueLength: queue, audioAvailableSeconds: 10 });
  } };
}

test('frames dropped while the decoder keeps a queue ready do not restart the stream', () => {
  // What a car's slow display produced: about 3 frames a second skipped for minutes, with 4 or 5
  // decoded frames always waiting. Lowering the quality changed nothing, so the player went from high to low.
  const monitor = health();
  for (let second = 0; second < 120; second++) monitor.second({ dropped: 3, queue: 4 + (second % 2) });
  assert.deepEqual(monitor.downgrades, []);
});

test('frames dropped while the decoder is behind still lower the quality', () => {
  const monitor = health();
  for (let second = 0; second < 5; second++) monitor.second({ dropped: 3, queue: 0 });
  assert.equal(monitor.downgrades.length, 0, 'not for a brief hiccup');
  for (let second = 0; second < 3; second++) monitor.second({ dropped: 3, queue: 1 });
  assert.equal(monitor.downgrades.length, 1);
});

test('a queue that recovers resets the struggle timer', () => {
  const monitor = health();
  for (let second = 0; second < 5; second++) monitor.second({ dropped: 3, queue: 0 });
  monitor.second({ dropped: 3, queue: 4 });
  for (let second = 0; second < 5; second++) monitor.second({ dropped: 3, queue: 0 });
  assert.equal(monitor.downgrades.length, 0);
});

test('without a queue length in the report the old behavior holds', () => {
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(html, /typeof stats\.videoQueueLength !== 'number' \|\| stats\.videoQueueLength < DECODER_BEHIND_QUEUE/);
});
