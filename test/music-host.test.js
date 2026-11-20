import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_MESSAGE, fromFrame, fromParent, cleanState, cleanCommand, keepsMusicPlaying, clock, COMMANDS } from '../public/music-host.js';

const state = extra => ({ type: MUSIC_MESSAGE, event: 'state', state: 'playing', key: '300', title: 'Dancing Queen', artist: 'ABBA', album: 'Gold', thumbnail: '/api/library/thumb?path=%2Flibrary%2Fmetadata%2F200%2Fthumb%2F2&width=128&height=128', position: 12.5, duration: 233, hasNext: true, hasPrevious: false, ...extra });

test('only messages from our own frame, or our own parent, on this site, are listened to', () => {
  const frame = {}; const parent = {};
  assert.equal(fromFrame({ source: frame, origin: 'https://dash.example' }, frame, 'https://dash.example'), true);
  assert.equal(fromFrame({ source: {}, origin: 'https://dash.example' }, frame, 'https://dash.example'), false, 'another window');
  assert.equal(fromFrame({ source: frame, origin: 'https://evil.example' }, frame, 'https://dash.example'), false, 'another site');
  assert.equal(fromFrame({ source: frame, origin: 'https://dash.example' }, null, 'https://dash.example'), false, 'no frame');
  assert.equal(fromParent({ source: parent, origin: 'https://dash.example' }, parent, 'https://dash.example'), true);
  assert.equal(fromParent({ source: frame, origin: 'https://dash.example' }, parent, 'https://dash.example'), false);
  assert.equal(fromParent({ source: parent, origin: 'null' }, parent, 'https://dash.example'), false);
});

test('what the player reports is cleaned, and anything else is refused', () => {
  const clean = cleanState(state());
  assert.deepEqual(clean, { state: 'playing', playing: false, key: '300', queue: null, title: 'Dancing Queen', artist: 'ABBA', album: 'Gold', thumbnail: state().thumbnail, position: 12.5, duration: 233, hasNext: true, hasPrevious: false, skipping: null });
  for (const bad of [null, undefined, 'x', {}, { type: 'other', event: 'state' }, { type: MUSIC_MESSAGE, event: 'command' }]) assert.equal(cleanState(bad), null, JSON.stringify(bad));
  assert.equal(cleanState(state({ state: 'exploding' })).state, 'idle');
  assert.equal(cleanState(state({ playing: true })).playing, true);
  assert.equal(cleanState(state({ playing: 'yes' })).playing, false, 'only true counts');
  assert.equal(cleanState(state({ key: '../x' })).key, null);
  assert.equal(cleanState(state({ thumbnail: 'https://evil.example/x.png' })).thumbnail, null, 'only a picture from this site\'s own route');
  assert.equal(cleanState(state({ thumbnail: '/api/library/thumb?x=<script>' })).thumbnail, null);
  assert.equal(cleanState(state({ thumbnail: '//evil.example/a' })).thumbnail, null);
  assert.equal(cleanState(state({ title: 'a'.repeat(900) })).title.length, 200);
  assert.equal(cleanState(state({ title: 'Line\u0000break\u0007' })).title, 'Line break');
  assert.equal(cleanState(state({ title: { toString: () => 'x' } })).title, '', 'text only');
  for (const bad of [-1, NaN, Infinity, 'a', 1e9]) assert.equal(cleanState(state({ position: bad })).position, 0, String(bad));
  assert.equal(cleanState(state({ hasNext: 'yes' })).hasNext, false);
});

test('a skip in progress is passed on only as next or previous', () => {
  assert.equal(cleanState(state({ skipping: 'next' })).skipping, 'next');
  assert.equal(cleanState(state({ skipping: 'previous' })).skipping, 'previous');
  assert.equal(cleanState(state({ skipping: '<b>' })).skipping, null);
  assert.equal(cleanState(state()).skipping, null);
});

test('only the listed commands are obeyed, and a seek needs a sensible position', () => {
  for (const name of COMMANDS) {
    const command = cleanCommand({ type: MUSIC_MESSAGE, event: 'command', name, seconds: 5 });
    assert.equal(command.name, name);
  }
  assert.deepEqual(cleanCommand({ type: MUSIC_MESSAGE, event: 'command', name: 'seek', seconds: 42 }), { name: 'seek', seconds: 42 });
  assert.deepEqual(cleanCommand({ type: MUSIC_MESSAGE, event: 'command', name: 'toggle', seconds: 'x' }), { name: 'toggle' }, 'extra fields are dropped');
  for (const bad of [null, {}, { type: MUSIC_MESSAGE, event: 'command', name: 'eval' }, { type: MUSIC_MESSAGE, event: 'command', name: 'seek' },
    { type: MUSIC_MESSAGE, event: 'command', name: 'seek', seconds: -2 }, { type: MUSIC_MESSAGE, event: 'command', name: 'seek', seconds: 'x' }, { type: MUSIC_MESSAGE, event: 'state', name: 'toggle' }]) {
    assert.equal(cleanCommand(bad), null, JSON.stringify(bad));
  }
});

test('music carries on among music and playlists, and stops for movies, shows and plugin tabs', () => {
  assert.equal(keepsMusicPlaying({ type: 'music' }), true);
  assert.equal(keepsMusicPlaying({ type: 'playlists' }), true);
  for (const other of [{ type: 'movie' }, { type: 'show' }, null, undefined, { id: 'live-tv' }]) assert.equal(keepsMusicPlaying(other), false, JSON.stringify(other));
});

test('times are shown as minutes and seconds', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65.9), '1:05');
  assert.equal(clock(3725), '62:05');
});

test('the queue a player is playing from is passed on, only if it is a plain id', () => {
  assert.equal(cleanState(state({ queue: 'ab22d7405fc3' })).queue, 'ab22d7405fc3');
  assert.equal(cleanState(state({ queue: '../x' })).queue, null);
  assert.equal(cleanState(state()).queue, null);
});
