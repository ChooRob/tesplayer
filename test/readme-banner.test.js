import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// The logo's lettering is white, so on GitHub's light theme the README title
// needs an image with its own background.
test('the README title is a banner image with its own navy background', () => {
  const readme = read('README.md');
  assert.match(readme, /^<h1 align="center"><img src="assets\/readme-banner\.svg" alt="FreeStuffCrazy Player"/, 'the title is the banner, with the product name as its text for readers who cannot see it');
  assert.ok(existsSync(new URL('../assets/readme-banner.svg', import.meta.url)));
  const svg = read('assets/readme-banner.svg');
  assert.match(svg, /<rect[^>]*fill="#10254a"/, 'a solid navy background behind the white lettering');
  assert.match(svg, /<title[^>]*>FreeStuffCrazy Player<\/title>/);
  assert.match(svg, />Player<\/text>/);
});

test('the banner is self-contained and safe to show', () => {
  const svg = read('assets/readme-banner.svg');
  assert.ok(!/<script|onload=|onclick=|javascript:/i.test(svg), 'no scripts');
  assert.ok(!/(href|src)=["']https?:/i.test(svg), 'nothing is fetched from elsewhere');
  assert.ok(!/<image\b/.test(svg), 'drawn with shapes, not an embedded picture');
});

test('the banner ships with the release', () => {
  assert.ok(JSON.parse(read('release-manifest.json')).includes('assets/readme-banner.svg'));
});
