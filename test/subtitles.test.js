import test from 'node:test';
import assert from 'node:assert/strict';
import { toWebVtt, describeTrack, orderTracks, TRACK_ID } from '../subtitles.js';

test('SubRip becomes WebVTT: commas to dots, numbers dropped, blank cues skipped', () => {
  const srt = '﻿1\r\n00:00:01,5 --> 00:00:03,000\r\nHello\r\n\r\n2\r\n00:01:04,000 --> 00:01:05,250\r\nTwo\r\nlines\r\n\r\n3\r\n00:02:00,000 --> 00:02:01,000\r\n\r\n';
  assert.equal(toWebVtt(srt), 'WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello\n\n00:01:04.000 --> 00:01:05.250\nTwo\nlines\n');
});

test('WebVTT passes through with its header, cue IDs, notes and settings removed', () => {
  const vtt = 'WEBVTT - a title\n\nNOTE a comment\n\nintro\n00:00:01.000 --> 00:00:02.000 align:start position:0%\nHi\n\n00:00:03.000 --> 00:00:04.000\nBye\n';
  assert.equal(toWebVtt(vtt), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n\n00:00:03.000 --> 00:00:04.000\nBye\n');
});

test('garbage in gives an empty but valid file', () => {
  assert.equal(toWebVtt('not subtitles at all'), 'WEBVTT\n\n\n');
  assert.equal(toWebVtt(''), 'WEBVTT\n\n\n');
});

test('a track shows only what the page needs, with safe values', () => {
  const track = describeTrack({ id: 12, label: '  Eng\u0000lish\n(SDH)  ', language: 'FRE', kind: 'text', forced: 1, isDefault: 0 });
  assert.deepEqual(track, { id: '12', label: 'Eng lish (SDH)', language: 'fra', kind: 'text', forced: true, default: false });
  assert.equal(describeTrack({ id: 1, label: '', language: 'not a language', kind: 'whatever' }).label, 'Subtitles');
  assert.equal(describeTrack({ id: 1, language: 'not a language' }).language, null);
  assert.equal(describeTrack({ id: 1, label: 'x'.repeat(500) }).label.length, 80);
  assert.equal(describeTrack({ id: 1, language: 'en-US' }).language, 'en-us');
});

test('tracks are ordered text first, full before forced, then by name, and capped', () => {
  const make = (label, kind, forced = false) => describeTrack({ id: label.length, label, kind, forced });
  const ordered = orderTracks([make('Zulu', 'burn'), make('Beta', 'text', true), make('Alpha', 'text'), make('Cee', 'burn')]).map(track => track.label);
  assert.deepEqual(ordered, ['Alpha', 'Beta', 'Cee', 'Zulu']);
  assert.equal(orderTracks(Array.from({ length: 200 }, (_, i) => describeTrack({ id: i, label: `T${i}` }))).length, 60);
});

test('only digits are track IDs', () => {
  for (const good of ['0', '12', '999999']) assert.ok(TRACK_ID.test(good), good);
  for (const bad of ['', '1a', '-1', '1.5', '1234567', '../1', '1\n', ' 1']) assert.ok(!TRACK_ID.test(bad), JSON.stringify(bad));
});
