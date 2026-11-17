import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBrowseView, writeBrowseView, browseUrlFrom, carryBrowseView } from '../public/browse-location.js';

test('the tab, show and season are read from an address', () => {
  assert.deepEqual(readBrowseView('?tab=2&show=14146&season=14150'), { tab: '2', show: '14146', season: '14150' });
  assert.deepEqual(readBrowseView('?tab=2'), { tab: '2', show: null, season: null });
  assert.deepEqual(readBrowseView(''), { tab: null, show: null, season: null });
  // Jellyfin IDs and plugin tab names are fine too.
  assert.deepEqual(readBrowseView('?tab=live-tv&show=f137a2dd21bbc1b99aa5c0f6bf02a805'), { tab: 'live-tv', show: 'f137a2dd21bbc1b99aa5c0f6bf02a805', season: null });
});

test('anything that is not an ID is ignored', () => {
  assert.deepEqual(readBrowseView('?tab=<script>&show=../../etc&season=a%20b'), { tab: null, show: null, season: null });
  assert.deepEqual(readBrowseView(`?show=${'x'.repeat(65)}`), { tab: null, show: null, season: null });
  assert.deepEqual(readBrowseView('?show=&season=&tab='), { tab: null, show: null, season: null });
});

test('a season without its show is ignored', () => {
  assert.deepEqual(readBrowseView('?tab=2&season=14150'), { tab: '2', show: null, season: null });
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
