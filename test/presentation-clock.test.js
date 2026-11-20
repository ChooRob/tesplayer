import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationClock } from '../public/engine/presentation-clock.js';

const ring = (frames = 0) => ({ consumedFrames: frames });
const clockOn = (fakeRing, mediaTime = 0) => {
  const clock = new PresentationClock();
  clock.useAudioRing(fakeRing, 48000);
  clock.reset(mediaTime);
  return clock;
};

test('time follows the frames the output has played', () => {
  const output = ring();
  const clock = clockOn(output, 10);
  output.consumedFrames = 48000 * 3;
  assert.equal(clock.currentTime, 13);
});

test('when playback crosses into the next track, time starts again from zero without a gap', () => {
  const output = ring();
  const clock = clockOn(output, 0);
  clock.chainAt(48000 * 200); // the first track's audio ends at 200 s
  output.consumedFrames = 48000 * 199.5;
  assert.equal(clock.currentTime, 199.5, 'still the first track');
  assert.equal(clock.takeCrossing(), false);
  output.consumedFrames = 48000 * 201;
  assert.equal(clock.currentTime, 1, 'one second into the next track');
  assert.equal(clock.takeCrossing(), true, 'the crossing is reported once');
  assert.equal(clock.takeCrossing(), false);
  output.consumedFrames = 48000 * 205;
  assert.equal(clock.currentTime, 5);
});

test('a crossing found by reading the time is still reported', () => {
  const output = ring();
  const clock = clockOn(output, 0);
  clock.chainAt(48000 * 10);
  output.consumedFrames = 48000 * 11;
  clock.currentTime; // something else read the clock first
  assert.equal(clock.takeCrossing(), true);
});

test('a seek (reset) cancels a track queued behind this one', () => {
  const output = ring();
  const clock = clockOn(output, 0);
  clock.chainAt(48000 * 10);
  clock.reset(30);
  output.consumedFrames = 48000 * 20;
  assert.equal(clock.currentTime, 50, 'no jump to the next track');
  assert.equal(clock.takeCrossing(), false);
});

test('a missing or invalid boundary is ignored', () => {
  const output = ring(48000);
  const clock = clockOn(output, 0);
  clock.chainAt(NaN);
  clock.chainAt(-5);
  assert.equal(clock.currentTime, 1);
  assert.equal(clock.takeCrossing(), false);
});
