import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accessLog, worthLogging } from '../security.js';

const dir = mkdtempSync(path.join(tmpdir(), 'tesladash-access-log-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function hit(middleware, { method = 'GET', url = '/', status = 200, query = {}, ip = '203.0.113.9' } = {}) {
  const req = { method, originalUrl: url, url, ip, query, get: () => 'test-agent' };
  const res = new EventEmitter();
  res.statusCode = status;
  middleware(req, res, () => {});
  res.emit('finish');
}

test('in production only errors, page loads, playback starts and deliberate actions are logged', () => {
  const kept = [
    { method: 'GET', path: '/login', status: 200 },
    { method: 'GET', path: '/canvas2', status: 200 },
    { method: 'GET', path: '/api/start', status: 200 },
    { method: 'POST', path: '/api/auth/plex/pin', status: 200 },
    { method: 'POST', path: '/api/playback/stop', status: 200 },
    { method: 'GET', path: '/api/library/thumb', status: 404 },
    { method: 'POST', path: '/api/playback/usage', status: 403 },
  ];
  const dropped = [
    { method: 'GET', path: '/api/library/thumb', status: 200 },
    { method: 'GET', path: '/api/plex/thumb', status: 304 },
    { method: 'GET', path: '/proxy/video/:/transcode/universal/session/abc/base/00001.ts', status: 200 },
    { method: 'GET', path: '/api/auth/plex/poll', status: 200 },
    { method: 'GET', path: '/icons.js', status: 304 },
    { method: 'POST', path: '/api/playback/usage', status: 200 },
    { method: 'POST', path: '/api/playback/canvas-health', status: 204 },
    { method: 'POST', path: '/api/plex/progress', status: 200 },
    { method: 'POST', path: '/api/library/progress', status: 200 },
    { method: 'POST', path: '/progress', status: 200 },
  ];
  for (const entry of kept) assert.equal(worthLogging(entry), true, JSON.stringify(entry));
  for (const entry of dropped) assert.equal(worthLogging(entry), false, JSON.stringify(entry));
});

test('production skips the noise and masks the stream session in what it keeps', async () => {
  const file = path.join(dir, 'production.log');
  const log = accessLog(file, { production: true });
  hit(log, { url: '/api/library/thumb?url=%2Flibrary%2F1', status: 200 });
  hit(log, { method: 'POST', url: '/api/playback/usage', status: 200 });
  hit(log, { url: '/login' });
  hit(log, { url: '/api/start?key=5&quality=ultra', query: { key: '5', quality: 'ultra' } });
  hit(log, { url: '/proxy/video/:/transcode/universal/session/1234-secret-id/base/00007.ts', status: 502 });
  await log.close();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], / GET \/login 200 /);
  assert.match(lines[1], / GET \/api\/start 200 .*quality=ultra/);
  assert.ok(!lines[1].includes('key=5'), 'the query string is never logged');
  assert.match(lines[2], /\/session\/-\/base\/00007\.ts 502/);
  assert.ok(!lines.join('').includes('1234-secret-id'));
});

test('outside production everything is logged, with the full path', async () => {
  const file = path.join(dir, 'development.log');
  const log = accessLog(file, { production: false });
  hit(log, { url: '/api/library/thumb?url=x' });
  hit(log, { method: 'POST', url: '/api/playback/usage' });
  await log.close();
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], / GET \/api\/library\/thumb 200 /);
});

test('the log rotates when full and never grows without bound', async () => {
  const file = path.join(dir, 'rotating.log');
  const rotated = path.join(dir, 'rotating.1.log');
  const log = accessLog(file, { production: false, maxBytes: 600 });
  for (let i = 0; i < 40; i++) { hit(log, { url: `/page-${i}` }); await new Promise(resolve => setTimeout(resolve, 3)); }
  await log.close();
  assert.ok(existsSync(rotated), 'the full file was kept as the previous log');
  assert.ok(statSync(file).size <= 600 + 200, 'the current file stays near the cap');
  assert.ok(statSync(rotated).size <= 600 + 200);
  const newest = readFileSync(file, 'utf8').trim().split('\n').at(-1);
  assert.match(newest, /\/page-39 200/);
});

test('an existing large log is rotated on the next write, not appended to forever', async () => {
  const file = path.join(dir, 'existing.log');
  const first = accessLog(file, { production: false, maxBytes: 300 });
  for (let i = 0; i < 12; i++) { hit(first, { url: `/before-${i}` }); await new Promise(resolve => setTimeout(resolve, 3)); }
  await first.close();
  const restarted = accessLog(file, { production: false, maxBytes: 300 });
  hit(restarted, { url: '/after-restart' });
  await restarted.close();
  assert.ok(existsSync(path.join(dir, 'existing.1.log')));
  assert.ok(statSync(file).size < 300);
});
