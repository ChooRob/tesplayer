import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The browser decides whether to defer an image when its src is set, so a
// card image marked lazy after src still loads at once. A large library then
// requests every cover in one burst.
test('browse card images are marked lazy before their src is set', () => {
  const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const cards = [...html.matchAll(/const img = document\.createElement\('img'\);\n([\s\S]*?)\n\s*\w+\.appendChild\(img\)/g)].map(match => match[1]);
  assert.ok(cards.length >= 3, `found ${cards.length} card images`);
  for (const body of cards) {
    const lazy = body.indexOf("img.loading = 'lazy'");
    // setArt() is what sets the src (and swaps in a lettered tile when the art is missing).
    const src = body.search(/img\.src|setArt\(/);
    assert.ok(lazy >= 0 && src > lazy, `loading must come before src:\n${body}`);
  }
});
