import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');

// However many libraries and tabs there are, they stay one row that scrolls sideways, rather than wrapping into
// rows that push the page down.
test('the tabs are one row that scrolls sideways at any width, and shrinks to leave room for the search box', () => {
  const rule = html.match(/\n\s*\.libraries \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /flex-wrap: nowrap/);
  assert.match(rule, /overflow-x: auto/);
  assert.match(rule, /min-width: 0/);
  assert.match(rule, /flex: 1 1 0/);
  assert.match(html, /\.libraries button \{[^}]*flex: none; white-space: nowrap;/, 'a tab is never squeezed or wrapped');
});

test('an edge of the tab row with more behind it fades, so it is clear the row goes on', () => {
  assert.match(html, /\.libraries\.fadeEnd \{[^}]*mask-image: linear-gradient\(to right/);
  assert.match(html, /\.libraries\.fadeStart \{[^}]*mask-image: linear-gradient\(to left/);
  assert.match(html, /\.libraries\.fadeStart\.fadeEnd \{/);
  assert.match(html, /librariesEl\.classList\.toggle\('fadeEnd', room > 4 && librariesEl\.scrollLeft < room - 4\)/);
  // It is kept up to date as the row scrolls, the window changes and tabs (or a search's counts) come and go.
  assert.match(html, /librariesEl\.addEventListener\('scroll', updateTabFades/);
  assert.match(html, /window\.addEventListener\('resize', updateTabFades\)/);
  assert.match(html, /new MutationObserver\(updateTabFades\)\.observe\(librariesEl, \{ childList: true, subtree: true, characterData: true \}\)/);
});

test('the tab on screen is scrolled into view wherever it is chosen', () => {
  assert.match(html, /function revealActiveTab\(\)/);
  // Opening a library, a plugin tab, a search's results and a restored show all light a tab.
  const lights = html.match(/btn\.classList\.toggle\('active'/g).length;
  const reveals = html.match(/\n\s*revealActiveTab\(\);/g).length;
  assert.ok(reveals >= lights, `${reveals} reveals for ${lights} places a tab is lit`);
});
