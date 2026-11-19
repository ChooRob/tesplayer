import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVtt, activeText, pickTrack, preferenceFor, readPreference, writePreference } from '../public/captions.js';

const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map }; };

test('WebVTT is read into timed cues, with markup stripped and entities decoded', () => {
  const cues = parseVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500 align:center\n<i>Hello</i> &amp; <b>bye</b>\nsecond &lt;line&gt;\n\n00:01:00.000 --> 00:01:02.000\nLate\n');
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: 'Hello & bye\nsecond <line>' },
    { start: 60, end: 62, text: 'Late' },
  ]);
});

test('short timestamps, commas, and broken cues are handled', () => {
  assert.deepEqual(parseVtt('00:05.250 --> 00:06.000\nShort\n\n00:00:07,5 --> 00:00:08,0\nComma\n\n00:00:09.000 --> 00:00:08.000\nBackwards\n\nbad --> worse\nNo\n\n00:00:10.000 --> 00:00:11.000\n\n'),
    [{ start: 5.25, end: 6, text: 'Short' }, { start: 7.5, end: 8, text: 'Comma' }]);
  assert.deepEqual(parseVtt(''), []);
});

test('script text can never become markup', () => {
  const [cue] = parseVtt('00:00:01.000 --> 00:00:02.000\n<script>alert(1)</script><img src=x onerror=alert(1)>Safe\n');
  assert.equal(cue.text, 'alert(1)Safe');
});

test('the text at a moment is every cue that has started and not ended', () => {
  const cues = parseVtt('00:00:01.000 --> 00:00:04.000\nA\n\n00:00:02.000 --> 00:00:03.000\nB\n\n00:00:06.000 --> 00:00:07.000\nC\n');
  assert.equal(activeText(cues, 0.5), '');
  assert.equal(activeText(cues, 1), 'A');
  assert.equal(activeText(cues, 2.5), 'A\nB');
  assert.equal(activeText(cues, 4), '', 'a cue ends at its end time');
  assert.equal(activeText(cues, 6.5), 'C');
  assert.equal(activeText(cues, 99), '');
});

test('the remembered choice is a language or Off, and bad values are ignored', () => {
  const storage = memory();
  assert.equal(readPreference(storage), null);
  writePreference({ language: 'eng' }, storage);
  assert.deepEqual(readPreference(storage), { language: 'eng' });
  writePreference({ off: true }, storage);
  assert.deepEqual(readPreference(storage), { off: true });
  writePreference(null, storage);
  assert.equal(readPreference(storage), null);
  storage.setItem('freeStuffCrazyPlayer.captions', '{"language":"<script>"}');
  assert.equal(readPreference(storage), null);
  storage.setItem('freeStuffCrazyPlayer.captions', 'not json');
  assert.equal(readPreference(storage), null);
  assert.equal(readPreference({ getItem() { throw new Error('blocked'); } }), null, 'private browsing');
  writePreference({ language: 'eng' }, { setItem() { throw new Error('blocked'); } });
});

test('a track stands for its language, and Off for Off', () => {
  assert.deepEqual(preferenceFor({ language: 'spa' }), { language: 'spa' });
  assert.deepEqual(preferenceFor(null), { off: true });
  assert.equal(preferenceFor({ language: null }), null, 'a track with no language remembers nothing');
});

test('captions start on only for a language chosen before, preferring full text tracks', () => {
  const tracks = [
    { id: '1', language: 'eng', kind: 'burn', forced: false },
    { id: '2', language: 'eng', kind: 'text', forced: true },
    { id: '3', language: 'eng', kind: 'text', forced: false },
    { id: '4', language: 'spa', kind: 'text', forced: false },
  ];
  assert.equal(pickTrack(tracks, null), null, 'never chosen: off');
  assert.equal(pickTrack(tracks, { off: true }), null);
  assert.equal(pickTrack(tracks, { language: 'eng' }).id, '3', 'full text beats a picture track and a forced one');
  assert.equal(pickTrack(tracks, { language: 'spa' }).id, '4');
  assert.equal(pickTrack(tracks, { language: 'deu' }), null, 'a language this item lacks: off');
  assert.equal(pickTrack(tracks.slice(0, 2), { language: 'eng' }).id, '1', 'a full picture track beats a forced text one');
  assert.equal(pickTrack([{ id: '9', language: 'eng-us', kind: 'text', forced: false }], { language: 'eng' }).id, '9', 'a regional variant still matches its language');
});

// The player page itself cannot run here, so check it is wired to what it needs.
test('the player page has the caption button, menu and routes, and restarts for a burned-in track', () => {
  const page = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  assert.match(page, /id="ccBtn"/);
  assert.match(page, /id="ccPanel"/);
  assert.match(page, /\/captions\.js/);
  assert.match(page, /\/api\/library\/subtitles\//);
  assert.match(page, /\/api\/library\/subtitle\//);
  assert.match(page, /startParams\.set\('subtitle'/);
  assert.match(page, /searchParams\.set\('subtitle'/);
  assert.match(page, /await captionsReady/);
  const icons = readFileSync(new URL('../public/icons.js', import.meta.url), 'utf8');
  assert.match(icons, /\n  cc: '/);
});
