import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSession } from '../public/media-session.js';

function fakeSession() {
  const handlers = {};
  const positions = [];
  return {
    handlers, positions, metadata: null, playbackState: 'none',
    setActionHandler(action, handler) {
      if (action === 'seekto' && this.noSeekTo) throw new TypeError('unsupported');
      if (handler) handlers[action] = handler; else delete handlers[action];
    },
    setPositionState(state) {
      if (state.playbackRate === 0) throw new TypeError('playbackRate must not be 0');
      positions.push(state);
    },
  };
}

function fakeActions() {
  const calls = [];
  return {
    calls,
    actions: {
      play: () => calls.push(['play']),
      pause: () => calls.push(['pause']),
      seekBy: (s) => calls.push(['seekBy', s]),
      seekTo: (s) => calls.push(['seekTo', s]),
    },
  };
}

test('media keys drive the player and default to 30-second skips', () => {
  const session = fakeSession();
  const { calls, actions } = fakeActions();
  createMediaSession({ actions, mediaSession: session });
  session.handlers.play();
  session.handlers.pause();
  session.handlers.seekbackward({});
  session.handlers.seekforward({ seekOffset: 10 });
  session.handlers.seekto({ seekTime: 120 });
  session.handlers.seekto({});
  assert.deepEqual(calls, [['play'], ['pause'], ['seekBy', -30], ['seekBy', 10], ['seekTo', 120]]);
});

test('live playback offers only play and pause, and unsupported actions are skipped', () => {
  const live = fakeSession();
  createMediaSession({ actions: fakeActions().actions, mediaSession: live, isLive: true });
  assert.deepEqual(Object.keys(live.handlers).sort(), ['pause', 'play']);

  const partial = fakeSession();
  partial.noSeekTo = true;
  createMediaSession({ actions: fakeActions().actions, mediaSession: partial });
  assert.equal(partial.handlers.seekto, undefined);
  assert.ok(partial.handlers.seekforward);
});

test('state, position and metadata reach the browser; position updates are throttled', () => {
  const session = fakeSession();
  let time = 0;
  class Metadata { constructor(init) { Object.assign(this, init); } }
  const controls = createMediaSession({ actions: fakeActions().actions, mediaSession: session, MediaMetadataClass: Metadata, now: () => time });

  controls.setMetadata({ title: 'Pilot', artist: 'Show', artwork: [{ src: '/thumb' }] });
  assert.equal(session.metadata.title, 'Pilot');

  controls.update('buffering', { position: 10, duration: 100 });
  assert.equal(session.playbackState, 'playing');
  controls.update('playing', { position: 11, duration: 100 });
  time = 1000;
  controls.update('playing', { position: 12, duration: 100 });
  time = 6000;
  controls.update('playing', { position: 500, duration: 100 });
  assert.deepEqual(session.positions.map(p => p.position), [10, 11, 100]);

  controls.update('paused', { position: 50, duration: 100 });
  assert.equal(session.playbackState, 'paused');
  controls.update('playing', { position: 50, duration: Infinity });
  assert.equal(session.positions.length, 4, 'an unknown duration is not reported');

  controls.dispose();
  assert.equal(session.metadata, null);
  assert.deepEqual(session.handlers, {});
});

test('without the Media Session API nothing happens', () => {
  const controls = createMediaSession({ actions: fakeActions().actions, mediaSession: undefined });
  controls.setMetadata({ title: 'x' });
  controls.update('playing', { position: 1, duration: 2 });
  controls.dispose();
});

test('the keep-alive clip keeps playing while paused so the media session survives', () => {
  const clip = { plays: 0, pauses: 0, play() { this.plays++; return Promise.resolve(); }, pause() { this.pauses++; }, removeAttribute() {} };
  const controls = createMediaSession({
    actions: fakeActions().actions, mediaSession: fakeSession(), keepAlive: true,
    document: { createElement: () => clip },
  });
  controls.update('playing', { position: 1, duration: 100 });
  controls.update('paused', { position: 1, duration: 100 });
  assert.equal(clip.pauses, 0, 'pausing playback must not pause the clip');
  controls.update('playing', { position: 1, duration: 100 });
  controls.update('ended', { position: 100, duration: 100 });
  assert.equal(clip.pauses, 1, 'the clip stops once playback is over');
  controls.dispose();
});

test('a Pause action while already paused resumes, for browsers that only ever send Pause', () => {
  const { actions, calls } = fakeActions();
  const session = fakeSession();
  const controls = createMediaSession({ actions, mediaSession: session });
  controls.update('playing', { position: 1, duration: 100 });
  session.handlers.pause();
  controls.update('paused', { position: 1, duration: 100 });
  session.handlers.pause();
  assert.deepEqual(calls.slice(-2), [['pause'], ['play']]);
  controls.dispose();
});

test('Next and Previous skip 30 seconds, except on live streams', () => {
  const { actions, calls } = fakeActions();
  const session = fakeSession();
  createMediaSession({ actions, mediaSession: session });
  session.handlers.nexttrack();
  session.handlers.previoustrack();
  assert.deepEqual(calls, [['seekBy', 30], ['seekBy', -30]]);
  const live = fakeSession();
  createMediaSession({ actions: fakeActions().actions, isLive: true, mediaSession: live });
  assert.equal(live.handlers.nexttrack, undefined);
  assert.equal(live.handlers.previoustrack, undefined);
});

test('restarting the keep-alive clip reloads and plays it again', () => {
  const clip = { events: [], play() { this.events.push('play'); return Promise.resolve(); }, pause() { this.events.push('pause'); }, load() { this.events.push('load'); }, removeAttribute() {} };
  const controls = createMediaSession({ actions: fakeActions().actions, mediaSession: fakeSession(), keepAlive: true, document: { createElement: () => clip } });
  controls.restartSilentClip();
  assert.deepEqual(clip.events, ['pause', 'load', 'play']);
  controls.dispose();
});

test('the Pause the car sends right after Next or Previous is ignored, a later one still pauses', () => {
  let clock = 1000;
  const calls = [];
  const actions = {
    play: () => calls.push('play'), pause: () => calls.push('pause'),
    seekBy: () => calls.push('seek'), seekTo: () => {},
    nextTrack: () => { calls.push('next'); return true; },
    previousTrack: () => { calls.push('previous'); return true; },
  };
  const session = fakeSession();
  const counted = [];
  createMediaSession({ actions, mediaSession: session, now: () => clock, onAction: name => counted.push(name) });
  session.handlers.nexttrack();
  clock += 100;
  session.handlers.pause();
  clock += 5000;
  session.handlers.previoustrack();
  clock += 100;
  session.handlers.pause();
  assert.deepEqual(calls, ['next', 'previous'], 'neither Pause stopped the music');
  assert.deepEqual(counted, ['nexttrack', 'pause', 'previoustrack', 'pause'], 'the diagnostics still count them');
  clock += 5000;
  session.handlers.pause();
  assert.deepEqual(calls.slice(-1), ['pause'], 'a Pause on its own still pauses');
});
