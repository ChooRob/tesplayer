import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseFiles } from '../scripts/release-files.mjs';
import { loadConfiguredPlugins } from '../plugins.js';
import { sameOriginRequests } from '../security.js';

test('release manifest excludes unreviewed files and rejects private paths and symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-test-'));
  const manifest = files => writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(files));
  try {
    writeFileSync(path.join(root, 'safe.js'), 'export {};');
    writeFileSync(path.join(root, '.private.md'), 'private');
    mkdirSync(path.join(root, 'public'));
    writeFileSync(path.join(root, 'public/.env.local'), 'private');
    manifest(['safe.js']); assert.deepEqual(releaseFiles(root), ['safe.js']);
    for (const file of ['.private.md', 'public/.env.local', '../safe.js', '/safe.js', 'config.json']) {
      manifest([file]); assert.throws(() => releaseFiles(root));
    }
    symlinkSync(path.join(root, 'public'), path.join(root, 'linked'));
    manifest(['linked/.env.local']); assert.throws(() => releaseFiles(root));
    symlinkSync(path.join(root, 'safe.js'), path.join(root, 'alias.js'));
    manifest(['alias.js']); assert.throws(() => releaseFiles(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('plugins are opt-in and configured failures stop loading', async () => {
  let imports = 0;
  assert.deepEqual(await loadConfiguredPlugins({ importModule: async () => { imports++; } }), []);
  assert.equal(imports, 0);
  await assert.rejects(loadConfiguredPlugins({ modules: ['bad'], importModule: async () => { throw new Error('failed'); } }));
  await assert.rejects(loadConfiguredPlugins({ modules: ['bad'], importModule: async () => ({ default: null }) }));
});

test('playback CSRF guard covers Express case, slash and HEAD aliases and late plugin routes', () => {
  const paths = new Set(['/api/start']);
  const guard = sameOriginRequests('https://app.example', paths);
  paths.add('/api/plugin/start');
  for (const route of ['/API/START/', '/api/start', '/API/PLUGIN/START/']) {
    for (const method of ['GET', 'HEAD']) {
      for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-mode': 'navigate' }]) {
        let status;
        guard({ method, path: route, get: key => headers[key] }, { status(code) { status = code; return this; }, json() {} }, () => assert.fail('Request accepted'));
        assert.equal(status, 403);
      }
    }
  }
});

test('legacy watch history binds to configured server before another server can read it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'progress-test-'));
  try {
    writeFileSync(path.join(root, '.local-finished.json'), JSON.stringify({ '1': { show: { ratingKey: '123' } } }));
    const script = `import assert from 'node:assert/strict';
      import * as progress from ${JSON.stringify(new URL('../local-progress.js', import.meta.url).href)};
      await assert.rejects(() => progress.finishedEpisodesForAccount('1', 'other'));
      const { createJsonStore } = await import(${JSON.stringify(new URL('../storage.js', import.meta.url).href)});
      progress.bindLegacyServer('configured', createJsonStore({ dir: process.env.DATA_DIR }));
      assert.deepEqual(await progress.finishedEpisodesForAccount('1', 'other'), {});
      assert.equal((await progress.finishedEpisodesForAccount('1', 'configured')).show.ratingKey, '123');
      await progress.recordFinishedEpisode('1', { grandparentKey: 'other-show', parentKey: 'p', ratingKey: '9' }, 'configured');
      const { readFileSync } = await import('node:fs');
      const saved = JSON.parse(readFileSync(process.env.DATA_DIR + '/.local-finished.json', 'utf8'));
      assert.equal(saved['configured:1'].show.ratingKey, '123');
      assert.equal(saved['configured:1']['other-show'].ratingKey, '9');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: root } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
