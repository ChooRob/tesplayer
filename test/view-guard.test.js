import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createViewGuard, wasAborted } from '../public/view-guard.js';

test('only the newest view is current, and starting one aborts the previous request', () => {
  const guard = createViewGuard();
  const movies = guard.begin();
  assert.equal(movies.isCurrent(), true);
  assert.equal(movies.signal.aborted, false);
  const tv = guard.begin();
  assert.equal(movies.isCurrent(), false, 'Movies is stale once TV Shows is chosen');
  assert.equal(movies.signal.aborted, true, 'the stale request is cancelled');
  assert.equal(tv.isCurrent(), true);
  assert.equal(tv.signal.aborted, false);
});

test('a slow earlier response is dropped even if it arrives after the newer one', async () => {
  const guard = createViewGuard();
  const grid = [];
  const load = async (name, delay) => {
    const view = guard.begin();
    await new Promise(resolve => setTimeout(resolve, delay));
    if (!view.isCurrent()) return; // what the page does before touching the grid
    grid.push(name);
  };
  const movies = load('Movies', 40);
  const tv = load('TV Shows', 5);
  await Promise.all([movies, tv]);
  assert.deepEqual(grid, ['TV Shows'], 'the slow Movies response never reaches the grid');
});

test('the abort of a replaced request is recognised, other errors are not', () => {
  assert.equal(wasAborted(new DOMException('aborted', 'AbortError')), true);
  assert.equal(wasAborted(new Error('boom')), false);
  assert.equal(wasAborted(undefined), false);
});

// Every loader that fills the shared grid, and every action that replaces it,
// must start a view, or the race comes back.
test('every browse action that changes the grid starts a view', () => {
  const html = readFileSync(new URL('../public/browse.html', import.meta.url), 'utf8');
  const body = name => {
    const start = html.indexOf(`async function ${name}(`) >= 0 ? html.indexOf(`async function ${name}(`) : html.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    return html.slice(start, html.indexOf('\n    }\n', start));
  };
  for (const name of ['openLibrary', 'openShowSeasons', 'openSeason', 'openPluginTab', 'showSearchResults']) {
    assert.match(body(name), /viewGuard\.begin\(\)/, `${name} must start a view`);
  }
  // A search shows its results through showSearchResults, which starts the view; its lists are shared between
  // searches, so a stale answer is dropped rather than cancelled.
  assert.match(body('showSearchResults'), /isCurrent\(\)/, 'a search must drop a stale response');
  assert.match(body('runSearch'), /await showSearchResults\(/, 'a search shows its results through it');
  for (const name of ['openLibrary', 'openShowSeasons', 'openSeason']) {
    const source = body(name);
    assert.match(source, /isCurrent\(\)/, `${name} must drop a stale response`);
    assert.match(source, /signal: view\.signal/, `${name} must cancel a stale request`);
  }
});
