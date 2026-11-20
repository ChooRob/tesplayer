import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, parsePlain, parseLyricsXml, parseLyrics } from '../lyrics.js';
import { activeLine } from '../public/lyrics-view.js';

test('LRC lines are timed, sorted, may share words, and tags are not lyrics', () => {
  const lrc = `[ar:The Band]\n[ti:Song]\n[00:12.50]Second line\n[00:05.00]First line\n[00:30][01:00.5]Chorus\n\n[length: 03:00]\n`;
  const { timed, lines } = parseLrc(lrc);
  assert.equal(timed, true);
  assert.deepEqual(lines, [
    { startMs: 5000, text: 'First line' },
    { startMs: 12500, text: 'Second line' },
    { startMs: 30000, text: 'Chorus' },
    { startMs: 60500, text: 'Chorus' },
  ]);
});

test('an LRC offset shifts every line, and word stamps inside a line are dropped', () => {
  const { lines } = parseLrc('[offset:+500]\n[00:10.00]<00:10.00>Hello <00:10.40>world\n[00:00.20]Early');
  assert.deepEqual(lines, [{ startMs: 0, text: 'Early' }, { startMs: 9500, text: 'Hello world' }]);
  assert.deepEqual(parseLrc('[offset:garbage]\n[00:01.00]x').lines, [{ startMs: 1000, text: 'x' }]);
  assert.deepEqual(parseLrc('[00:01.5]a\n[00:02:25]b').lines.map(line => line.startMs), [1500, 2250]);
});

test('plain lyrics keep their order and verse breaks, with no times', () => {
  const result = parsePlain('One\r\nTwo\n\nThree');
  assert.equal(result.timed, false);
  assert.deepEqual(result.lines.map(line => line.text), ['One', 'Two', '', 'Three']);
  assert.ok(result.lines.every(line => line.startMs === null));
});

test('Plex\'s lyric XML: lines of spans, timed by their first span, with entities decoded', () => {
  const xml = `<?xml version="1.0"?><MediaContainer><Lyrics><Line startOffset="1000"><Span startOffset="1000" endOffset="2000">Uh-huh, </Span><Span startOffset="2000">life&apos;s like this</Span></Line>
    <Line><Span startOffset="5500">Chill &amp; out</Span></Line><Line><Span>No time</Span></Line></Lyrics></MediaContainer>`;
  const { timed, lines } = parseLyricsXml(xml);
  assert.equal(timed, true);
  assert.deepEqual(lines, [
    { startMs: 1000, text: 'Uh-huh, life\'s like this' },
    { startMs: 5500, text: 'Chill & out' },
    { startMs: null, text: 'No time' },
  ]);
});

test('whatever arrives is read by what it looks like, and bad input is bounded', () => {
  assert.equal(parseLyrics('<?xml version="1.0"?><Lyrics><Line startOffset="0"><Span>Hi</Span></Line></Lyrics>').timed, true);
  assert.equal(parseLyrics('[00:01.00]Hi').lines[0].startMs, 1000);
  assert.deepEqual(parseLyrics('\n\nJust words\n\nMore\n\n').lines.map(line => line.text), ['Just words', '', 'More'], 'blank ends trimmed, inner breaks kept');
  assert.deepEqual(parseLyrics('').lines, []);
  assert.deepEqual(parseLyrics(null).lines, []);
  assert.throws(() => parseLyrics('x'.repeat(600 * 1024)), /too large/);
  const long = parseLyrics(`<Lyrics><Line startOffset="1"><Span>${'a'.repeat(5000)}</Span></Line></Lyrics>`);
  assert.equal(long.lines[0].text.length, 400);
  assert.equal(parsePlain('line\n'.repeat(5000)).lines.length, 2000);
  // Markup in the words is never kept as markup, and control characters go.
  assert.equal(parseLyrics('<Lyrics><Line startOffset="1"><Span>a<b>b</b>\u0007c</Span></Line></Lyrics>').lines[0].text, 'abc');
});

test('the line being sung is the last that has started', () => {
  const lines = [{ startMs: 1000, text: 'a' }, { startMs: 5000, text: 'b' }, { startMs: 9000, text: 'c' }];
  assert.equal(activeLine(lines, 0), -1, 'before the first');
  assert.equal(activeLine(lines, 1000), 0);
  assert.equal(activeLine(lines, 4999), 0);
  assert.equal(activeLine(lines, 5000), 1);
  assert.equal(activeLine(lines, 999999), 2);
  assert.equal(activeLine([], 5000), -1);
  assert.equal(activeLine([{ startMs: null, text: 'x' }], 5000), -1, 'plain lyrics have none');
});

test('a file full of tags that are never closed is read in a moment, not minutes', () => {
  const started = Date.now();
  for (const body of [
    '<Lyrics>' + '<Line>'.repeat(80000),
    '<Lyrics>' + '<Line '.repeat(80000),
    '<Lyrics><Line>' + '<Span>'.repeat(80000) + '</Line>',
    '<Lyrics><Line>' + '<Span '.repeat(80000) + '</Line>',
    '<Lyrics><Line>' + '<'.repeat(400000) + '</Line>',
  ]) parseLyrics(body);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('spans, a self-closing span and tags inside words still read as before', () => {
  const result = parseLyrics('<Lyrics><Line startOffset="1000"><Span startOffset="1000">Hel<b>lo</b> &amp; </Span><Span>world</Span></Line>'
    + '<Line><Span text="Self" startOffset="7000"/></Line><Line>plain <i>words</i></Line></Lyrics>');
  assert.deepEqual(result.lines, [{ startMs: 1000, text: 'Hello & world' }, { startMs: 7000, text: 'Self' }, { startMs: null, text: 'plain words' }]);
});
