import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBrowseView, writeBrowseView, browseUrlFrom, carryBrowseView, idFromKey, browseUrlFor } from '../public/browse-location.js';

test('the tab, show and season are read from an address', () => {
  assert.deepEqual(readBrowseView('?tab=2&show=14146&season=14150'), { tab: '2', view: null, show: '14146', season: '14150' });
  assert.deepEqual(readBrowseView('?tab=2'), { tab: '2', view: null, show: null, season: null });
  assert.deepEqual(readBrowseView(''), { tab: null, view: null, show: null, season: null });
  // Jellyfin IDs and plugin tab names are fine too.
  assert.deepEqual(readBrowseView('?tab=live-tv&show=f137a2dd21bbc1b99aa5c0f6bf02a805'), { tab: 'live-tv', view: null, show: 'f137a2dd21bbc1b99aa5c0f6bf02a805', season: null });
});

test('a library view (artists, albums, tracks) is kept with its library', () => {
  assert.deepEqual(readBrowseView('?tab=5&view=albums'), { tab: '5', view: 'albums', show: null, season: null });
  assert.deepEqual(readBrowseView('?view=albums'), { tab: null, view: null, show: null, season: null }, 'a view needs its library');
  assert.equal(readBrowseView('?tab=5&view=<script>').view, null);
  assert.equal(readBrowseView('?tab=5&view=Albums').view, null, 'lowercase names only');
  assert.equal(readBrowseView(`?tab=5&view=${'a'.repeat(33)}`).view, null);
  assert.equal(writeBrowseView(new URLSearchParams(), { tab: '5', view: 'tracks' }).toString(), 'tab=5&view=tracks');
  assert.equal(writeBrowseView(new URLSearchParams('view=tracks'), { view: 'tracks' }).toString(), '', 'no view without a library');
  assert.equal(browseUrlFrom('?key=9&tab=5&view=tracks&playback=standard'), '/browse?tab=5&view=tracks');
  assert.equal(carryBrowseView('?tab=5&view=albums', new URLSearchParams({ key: '9' })).toString(), 'key=9&tab=5&view=albums');
});

test('anything that is not an ID is ignored', () => {
  assert.deepEqual(readBrowseView('?tab=<script>&show=../../etc&season=a%20b'), { tab: null, view: null, show: null, season: null });
  assert.deepEqual(readBrowseView(`?show=${'x'.repeat(65)}`), { tab: null, view: null, show: null, season: null });
  assert.deepEqual(readBrowseView('?show=&season=&tab='), { tab: null, view: null, show: null, season: null });
});

test('a season without its show is ignored', () => {
  assert.deepEqual(readBrowseView('?tab=2&season=14150'), { tab: '2', view: null, show: null, season: null });
  assert.equal(writeBrowseView(new URLSearchParams(), { tab: '2', season: '14150' }).toString(), 'tab=2');
});

test('writing sets what is given and removes what is not, keeping other parameters', () => {
  const params = new URLSearchParams('quality=low&tab=1&show=5&season=6');
  assert.equal(writeBrowseView(params, { tab: '2' }).toString(), 'quality=low&tab=2');
  assert.equal(writeBrowseView(params, { tab: '2', show: '7' }).toString(), 'quality=low&tab=2&show=7');
  assert.equal(writeBrowseView(params, { tab: '2', show: '7', season: '8' }).toString(), 'quality=low&tab=2&show=7&season=8');
  assert.equal(writeBrowseView(params, {}).toString(), 'quality=low');
});

test('Back returns to the same screen', () => {
  assert.equal(browseUrlFrom('?key=9&tab=2&show=14146&season=14150&playback=standard'), '/browse?tab=2&show=14146&season=14150');
  assert.equal(browseUrlFrom('?key=9&tab=2'), '/browse?tab=2');
  assert.equal(browseUrlFrom('?key=9'), '/browse');
  assert.equal(browseUrlFrom('?tab=%3Cscript%3E'), '/browse', 'an invalid tab is dropped');
});

test('a link to the player or a detail page carries the view, and the next episode drops the season', () => {
  const link = carryBrowseView('?tab=2&show=14146&season=14150', new URLSearchParams({ key: '9' }));
  assert.equal(link.toString(), 'key=9&tab=2&show=14146&season=14150');
  const next = carryBrowseView('?tab=2&show=14146&season=14150', new URLSearchParams({ key: '10' }), { keepSeason: false });
  assert.equal(next.toString(), 'key=10&tab=2&show=14146');
});

// All three pages must use these helpers, or a reload or Back loses the place again.
test('the browse, player and detail pages all keep the view in their links', () => {
  const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
  for (const page of ['browse.html', 'canvas2.html', 'detail.html']) {
    assert.match(read(page), /browse-location\.js/, `${page} imports the helper`);
  }
  assert.match(read('canvas2.html'), /browseUrlFrom\(/, 'the player\'s Back link returns to the view');
  assert.match(read('detail.html'), /browseUrlFrom\(/, 'the detail page\'s Back link returns to the view');
});

test('an item\'s ID is the end of its key, and only if it looks like one', () => {
  assert.equal(idFromKey('/library/metadata/38169'), '38169', 'Plex gives a path');
  assert.equal(idFromKey('38169'), '38169');
  assert.equal(idFromKey('f137a2dd21bbc1b99aa5c0f6bf02a805'), 'f137a2dd21bbc1b99aa5c0f6bf02a805', 'Jellyfin gives the ID');
  assert.equal(idFromKey('/library/metadata/38169/'), '38169');
  for (const bad of [null, undefined, '', '/', '/library/metadata/<script>', `/x/${'a'.repeat(65)}`, '/library/metadata/1 2']) assert.equal(idFromKey(bad), null, String(bad));
});

test('links to an artist and to an album open the browse page on that screen', () => {
  assert.equal(browseUrlFor({ tab: '3', view: 'artists', show: '41730' }), '/browse?tab=3&view=artists&show=41730');
  assert.equal(browseUrlFor({ tab: '3', show: '41730', season: '41731' }), '/browse?tab=3&show=41730&season=41731');
  assert.equal(browseUrlFor({ show: '41730' }), '/browse?show=41730', 'no library known: the first one');
  assert.equal(browseUrlFor(), '/browse');
  assert.deepEqual(readBrowseView(new URL(browseUrlFor({ tab: '3', show: '9', season: '10' }), 'http://x').search), { tab: '3', view: null, show: '9', season: '10' }, 'and the page reads it back');
});
