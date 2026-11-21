import test from 'node:test';
import assert from 'node:assert/strict';
import { titleLines, fallbackArt, showArt } from '../public/artwork.js';

test('a title is broken into short lines, with the last one cut when there are too many', () => {
  assert.deepEqual(titleLines('Trolls', 14), ['Trolls']);
  assert.deepEqual(titleLines('Trolls (Original Motion Picture Soundtrack)', 14), ['Trolls', '(Original', 'Motion Picture', 'Soundtrack)']);
  assert.equal(titleLines('one two three four five six seven eight nine ten', 6, 3).at(-1).endsWith('…'), true);
  assert.deepEqual(titleLines('', 14), []);
});

test('the fallback is a blue tile that names the title, with its text escaped', () => {
  const uri = fallbackArt('A & "B" <3');
  assert.ok(uri.startsWith('data:image/svg+xml'));
  const svg = decodeURIComponent(uri.split(',')[1]);
  assert.match(svg, /#3b82f6/);
  assert.match(svg, /A &amp; &quot;B&quot; &lt;3/);
});

test('missing art shows the tile at once, and a failed picture is swapped for it', () => {
  const img = { dataset: {} };
  showArt(img, '', 'Album');
  assert.ok(img.src.startsWith('data:image/svg+xml'));

  const other = { dataset: {} };
  showArt(other, '/cover.jpg', 'Album');
  assert.equal(other.src, '/cover.jpg');
  other.onerror();
  assert.ok(other.src.startsWith('data:image/svg+xml'));
  // Asked for the same picture again, it stays as the tile instead of trying (and failing) again.
  showArt(other, '/cover.jpg', 'Album');
  assert.ok(other.src.startsWith('data:image/svg+xml'));
});

test('a failed picture tries the artist art before the tile', () => {
  const img = { dataset: {} };
  showArt(img, '/album.jpg', 'Album', '/artist.jpg');
  assert.equal(img.src, '/album.jpg');
  img.onerror();
  assert.equal(img.src, '/artist.jpg');
  img.onerror();
  assert.ok(img.src.startsWith('data:image/svg+xml'));
  img.onerror?.();
  assert.ok(img.src.startsWith('data:image/svg+xml'));
});
