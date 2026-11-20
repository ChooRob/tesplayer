import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLoginTransactions, parseCookies, rateLimit, readBodyText, sameOriginRequests, securityHeaders, avatarUrl, fetchAvatar, mediaProxyPath, safeError } from '../security.js';
import { safeReturnPath } from '../public/safe-navigation.js';
import { renderMetadata } from '../public/metadata.js';
import { resolveAccountId, authorizedNextUp } from '../profile-identity.js';
import { rewriteManifest } from '../plex-manifest.js';
import { createPlaybackSessions } from '../playback-sessions.js';

test('login destinations reject executable, external, protocol-relative and unrecognized URLs', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', '//evil.example/a', 'https://evil.example', '/\\evil.example', '/api/start?key=1', 'https://user:pass@app.example/browse']) {
    assert.equal(safeReturnPath(value, 'https://app.example'), '/browse');
  }
  assert.equal(safeReturnPath('/canvas2?key=1&resume=30', 'https://app.example'), '/canvas2?key=1&resume=30');
});

test('login transactions reject different browsers, concurrent completion, replay and expiration', async () => {
  let time = 0;
  const logins = createLoginTransactions({ now: () => time, ttl: 100 });
  logins.issue(1, 'browser-one');
  await assert.rejects(logins.run(1, 'browser-two', () => assert.fail()), /invalid/);
  let release;
  const pending = logins.run(1, 'browser-one', async (_entry, consume) => {
    await new Promise(resolve => { release = resolve; }); consume(); return 'signed in';
  });
  await assert.rejects(logins.run(1, 'browser-one', () => assert.fail()), /invalid/);
  release(); assert.equal(await pending, 'signed in');
  await assert.rejects(logins.run(1, 'browser-one', () => assert.fail()), /invalid/);
  logins.issue(2, 'browser-one'); time = 101;
  await assert.rejects(logins.run(2, 'browser-one', () => assert.fail()), /invalid/);
});

test('malformed cookie encoding does not crash authentication', () => {
  assert.equal(parseCookies('bad=%zz; good=hello').good, 'hello');
  assert.equal(parseCookies('bad=%zz').bad, undefined);
});

test('rate limiting caps requests and expires old buckets', () => {
  let time = 0; let calls = 0; let status;
  const limit = rateLimit({ maximum: 2, windowMs: 100, now: () => time });
  const res = { set() {}, status(code) { status = code; return this; }, json() {} };
  for (let i = 0; i < 3; i++) limit({ ip: 'one' }, res, () => calls++);
  assert.equal(calls, 2); assert.equal(status, 429);
  time = 101; limit({ ip: 'one' }, res, () => calls++); assert.equal(calls, 3);
});

test('cross-origin state changes are denied while Tesla document returns remain allowed', () => {
  let allowed = 0; let status;
  const guard = sameOriginRequests('https://app.example');
  const res = { status(code) { status = code; return this; }, json() {} };
  guard({ method: 'POST', path: '/api/auth/switch-user', get: key => key === 'origin' ? 'https://evil.example' : undefined }, res, () => allowed++);
  assert.equal(status, 403);
  guard({ method: 'GET', path: '/canvas2', get: () => 'cross-site' }, res, () => allowed++);
  guard({ method: 'POST', path: '/api/auth/plex/pin', get: key => key === 'origin' ? 'https://app.example' : undefined }, res, () => allowed++);
  assert.equal(allowed, 2);
});

function cspFor(reqPath) {
  const headers = {};
  securityHeaders(new URL('../public', import.meta.url).pathname)(
    { secure: true, path: reqPath },
    { set(key, value) { if (typeof key === 'object') Object.assign(headers, key); else headers[key] = value; } },
    () => {},
  );
  return headers;
}

test('CSP permits exact app scripts, local canvas workers, and no inline event handlers', () => {
  const headers = cspFor('/canvas2');
  const policy = headers['Content-Security-Policy'];
  assert.match(policy, /worker-src 'self' blob:/);
  assert.doesNotMatch(policy.split('script-src')[1].split(';')[0], /unsafe-inline/);
  const html = readFileSync(new URL('../public/canvas2.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.ok(policy.includes(crypto.createHash('sha256').update(match[1]).digest('base64')));
  }
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN', 'the browse page holds the music player in a frame');
  assert.match(policy, /frame-ancestors 'self'/);
  for (const page of ['/browse', '/login', '/detail']) {
    const other = cspFor(page);
    assert.equal(other['X-Frame-Options'], 'DENY', `${page} cannot be framed`);
    assert.match(other['Content-Security-Policy'], /frame-ancestors 'none'/, page);
  }
  assert.equal(cspFor('/api/library/libraries')['X-Frame-Options'], 'DENY');
  assert.ok(headers['Strict-Transport-Security']);
});

test('CSP script hashes are scoped to the page actually being served, re-read fresh each request', () => {
  // A request for one page must not carry another page's hash -- each
  // response only needs to permit its own inline script, and this also
  // proves the hash is recomputed per-request (so an edit on disk takes
  // effect on the next reload) rather than cached once at startup.
  const canvas2Policy = cspFor('/canvas2')['Content-Security-Policy'];
  const loginHtml = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  for (const match of loginHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) assert.ok(!canvas2Policy.includes(crypto.createHash('sha256').update(match[1]).digest('base64')));
  }

  // Requests that aren't for a known HTML page (API calls, assets,
  // proxied segments) get the hash-free baseline -- they never need to
  // run an inline script, so there's nothing to permit.
  const apiPolicy = cspFor('/api/plex/libraries')['Content-Security-Policy'];
  assert.doesNotMatch(apiPolicy.split('script-src')[1].split(';')[0], /sha256/);
});

test('metadata payloads remain text and are never parsed as HTML', () => {
  const children = [];
  const element = {
    ownerDocument: { createElement() { return {}; } },
    replaceChildren() { children.length = 0; }, append(child) { children.push(child); },
    set innerHTML(_) { assert.fail('HTML injection'); },
  };
  renderMetadata(element, { year: '<img onerror=alert(1)>', contentRating: '<svg onload=alert(1)>', audienceRating: 'invalid' });
  assert.equal(children.length, 2);
  assert.equal(children[1].textContent, '<svg onload=alert(1)>');
});

test('profile mapping requires stable IDs or explicit mappings', () => {
  const accounts = [{ id: '1', name: 'Owner' }, { id: '2', name: 'Child' }];
  assert.equal(resolveAccountId({ id: '2', title: 'Owner' }, accounts), '2');
  assert.equal(resolveAccountId({ id: 'cloud-owner', title: 'Owner' }, accounts), null);
  assert.equal(resolveAccountId({ id: 'cloud-owner', title: 'Owner' }, [...accounts, { id: '3', name: 'Owner' }]), null);
  assert.equal(resolveAccountId({ id: 'cloud-owner' }, accounts, { 'cloud-owner': '1' }), '1');
  assert.equal(resolveAccountId(null, accounts), null);
});

test('admin-derived next-up data is filtered and replaced by profile-authorized metadata', async () => {
  const results = await authorizedNextUp([{ ratingKey: '1', title: 'private' }, { ratingKey: '2' }], {
    async itemDetails(id) { if (id === '1') throw new Error('Forbidden'); return { ratingKey: id, title: 'allowed' }; },
  }, new Set());
  assert.deepEqual(results, [{ ratingKey: '2', title: 'allowed', viewOffset: 0 }]);
});

test('avatar proxy rejects non-HTTPS, arbitrary ports, paths and redirect destinations', async () => {
  for (const url of ['http://plex.tv/users/1/avatar', 'https://plex.tv:8443/users/1/avatar', 'https://plex.tv/users/1', 'https://127.0.0.1/users/1/avatar']) assert.throws(() => avatarUrl(url, true));
  let calls = 0;
  await assert.rejects(fetchAvatar('https://plex.tv/users/1/avatar', async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }));
  assert.equal(calls, 1);
  await assert.rejects(fetchAvatar('https://plex.tv/users/1/avatar', async () => new Response('<script>', { headers: { 'content-type': 'text/html' } })));
  await assert.rejects(fetchAvatar('https://plex.tv/users/1/avatar', async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })), /too large/);
});

test('media proxy permits only the owned session path and manifests strip credentials', () => {
  const base = 'https://plex.example/video/:/transcode/universal/session/abc/base/index.m3u8';
  assert.equal(mediaProxyPath('video/:/transcode/universal/session/abc/base/0.ts', 'abc'), true);
  for (const path of ['identity', 'video/:/transcode/universal/stop', 'video/:/transcode/universal/session/other/base/0.ts', 'video/:/transcode/universal/session/abc/../other/0.ts', 'video/:/transcode/universal/session/abc/%2e%2e/0.ts']) assert.equal(mediaProxyPath(path, 'abc'), false);
  const result = rewriteManifest('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?X-Plex-Token=secret"\n0.ts?X-Plex-Token=secret\n', base, 'abc');
  assert.doesNotMatch(result, /secret|Token/);
  assert.match(result, /URI="\/proxy\/video/);
  assert.throws(() => rewriteManifest('https://evil.example/file.ts', base, 'abc'));
});

test('viewers cannot access or stop each other’s playback sessions', async () => {
  const stopped = [];
  const sessions = createPlaybackSessions({ stop: async (...args) => stopped.push(args) });
  await sessions.run('one', state => { state.active = { sessionId: 'a', token: 'one-token' }; });
  await sessions.run('two', state => { state.active = { sessionId: 'b', token: 'two-token' }; });
  assert.equal(sessions.owns('one', 'b'), false);
  await sessions.stopOwner('one');
  assert.deepEqual(stopped, [[{ sessionId: 'a', token: 'one-token' }]]);
  assert.equal(sessions.owns('two', 'b'), true);
});

test('playback capacity, idle cleanup and concurrent starts are bounded', async () => {
  let time = 0; const stopped = [];
  const sessions = createPlaybackSessions({ maximum: 1, idleMs: 100, now: () => time, stop: async active => stopped.push(active.sessionId) });
  let release;
  const pending = sessions.run('one', async state => {
    state.active = { sessionId: 'a' }; await new Promise(resolve => { release = resolve; });
  });
  await assert.rejects(sessions.run('one', () => {}), /progress/);
  await assert.rejects(sessions.run('two', () => {}), /capacity/);
  release(); await pending; time = 101; await sessions.prune();
  assert.deepEqual(stopped, ['a']);
  await sessions.run('two', state => { state.active = { sessionId: 'b' }; });
});

test('upstream error diagnostics cannot expose tokens to clients', () => {
  assert.equal(safeError(new Error('https://plex.example?X-Plex-Token=secret')), 'Request failed; please try again');
  assert.equal(safeError(new Error('Incorrect PIN')), 'Incorrect PIN');
});

test('direct Plex manifests authenticate segments but retain controlled nested playlists', () => {
  const base = 'https://tenant-a.example:32400/video/:/transcode/universal/session/abc/master.m3u8';
  const manifest = '#EXTM3U\nchild/index.m3u8\n#EXT-X-MAP:URI="init.mp4?X-Plex-Token=upstream"\nsegment.ts?offset=2&X-Plex-Token=upstream\n';
  const result = rewriteManifest(manifest, base, 'abc', 'viewer token');
  assert.match(result, /\/proxy\/video\/:\/transcode\/universal\/session\/abc\/child\/index.m3u8\?direct=1/);
  assert.match(result, /https:\/\/tenant-a.example:32400\/.*init.mp4\?X-Plex-Token=viewer\+token/);
  assert.match(result, /segment.ts\?offset=2&X-Plex-Token=viewer\+token/);
  assert.ok(!result.includes('upstream'));
  for (const uri of ['https://tenant-b.example/segment.ts', '../other/segment.ts', '/video/:/transcode/universal/session/other/segment.ts']) {
    assert.throws(() => rewriteManifest(uri, base, 'abc', 'viewer token'));
  }
  const proxied = rewriteManifest(manifest, base.replace('https:', 'http:'), 'abc', 'viewer token');
  assert.ok(!proxied.includes('viewer'));
  assert.ok(!proxied.includes('direct=1'));
  assert.ok(!rewriteManifest(manifest, base, 'abc').includes('X-Plex-Token'));
});

test('player CSP isolates tenant origins and forbids caching personalized pages', () => {
  const middleware = securityHeaders(new URL('../public', import.meta.url).pathname, {
    mediaOriginForRequest: req => req.plexOrigin,
  });
  function headersFor(plexOrigin, page = '/canvas2') {
    const headers = {};
    middleware({ path: page, plexOrigin }, { set(key, value) {
      if (typeof key === 'object') Object.assign(headers, key); else headers[key] = value;
    } }, () => {});
    return headers;
  }
  const a = headersFor('https://tenant-a.example:32400');
  const b = headersFor('https://tenant-b.example');
  assert.match(a['Content-Security-Policy'], /connect-src 'self' https:\/\/tenant-a.example:32400;/);
  assert.match(a['Content-Security-Policy'], /media-src 'self' blob: https:\/\/tenant-a.example:32400;/);
  assert.ok(!b['Content-Security-Policy'].includes('tenant-a'));
  assert.equal(a['Cache-Control'], 'private, no-store');
  assert.ok(!headersFor('https://tenant-a.example', '/browse')['Content-Security-Policy'].includes('tenant-a'));
  for (const origin of ['', 'http://insecure.example', 'https://user:password@plex.example', "https://plex.example/;connect-src *", 'https://plex.example/?token=secret']) {
    assert.match(headersFor(origin)['Content-Security-Policy'], /connect-src 'self';/);
  }
});

test('a full rate limiter drops its oldest address instead of refusing new ones', () => {
  let time = 0; let status; let allowed = 0;
  const limit = rateLimit({ maximum: 2, windowMs: 1000, now: () => time, maxKeys: 3 });
  const res = { set() {}, status(code) { status = code; return this; }, json() {} };
  const hit = ip => { status = undefined; limit({ ip }, res, () => allowed++); return status; };
  // Fill it with live addresses, then keep arriving: nobody is locked out.
  for (const [at, ip] of [[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd'], [4, 'e'], [5, 'f']]) { time = at; assert.equal(hit(ip), undefined, ip); }
  assert.equal(allowed, 6);
  // 'a' was dropped to make room, so it starts a fresh count; an address still held keeps its own.
  time = 6; assert.equal(hit('a'), undefined);
  time = 7; hit('f'); assert.equal(hit('f'), 429, 'a held address is still limited');
});

test('the rate limiter forgets expired addresses from the oldest end', () => {
  let time = 0; let status;
  const limit = rateLimit({ maximum: 1, windowMs: 100, now: () => time, maxKeys: 2 });
  const res = { set() {}, status(code) { status = code; return this; }, json() {} };
  const hit = ip => { status = undefined; limit({ ip }, res, () => {}); return status; };
  hit('a'); time = 50; hit('b');
  time = 120; assert.equal(hit('a'), undefined, 'a expired');
  assert.equal(hit('b'), 429, 'b has not');
  time = 151; assert.equal(hit('b'), undefined, 'now b has too');
});

function bodyOf(chunks, headers = {}) {
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { if (sent < chunks.length) controller.enqueue(chunks[sent++]); else controller.close(); },
    cancel() { cancelled = true; },
  });
  return { response: new Response(stream, { headers }), sent: () => sent, cancelled: () => cancelled };
}

test('a response body is read up to its limit and no further', async () => {
  const text = new TextEncoder().encode('{"ok":true}');
  assert.equal(await readBodyText(bodyOf([text]).response, 64), '{"ok":true}');
  assert.equal(await readBodyText(new Response(null, { status: 204 }), 64), '');
  // A multi-byte character split across chunks is decoded whole.
  const euro = new TextEncoder().encode('€');
  assert.equal(await readBodyText(bodyOf([euro.slice(0, 1), euro.slice(1)]).response, 64), '€');

  // Too large by its own header: refused before reading any of it.
  const declared = bodyOf([text], { 'content-length': '5000' });
  await assert.rejects(readBodyText(declared.response, 64), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(declared.sent(), 0);

  // No header, or a false one, and an endless body: reading stops past the limit and the body is cancelled.
  const endless = bodyOf(Array.from({ length: 10_000 }, () => new Uint8Array(1024)), { 'content-length': '10' });
  await assert.rejects(readBodyText(endless.response, 4096), { code: 'RESPONSE_TOO_LARGE' });
  assert.ok(endless.sent() < 20, `read ${endless.sent()} chunks of 10000`);
  assert.ok(endless.cancelled());
});

test('a GET that starts playback needs an explicit same-origin signal', () => {
  const guard = sameOriginRequests('https://app.example', new Set(['/api/start']));
  const run = (path, headers, method = 'GET') => {
    let status = 200;
    guard({ method, path, get: key => headers[key] }, { status(code) { status = code; return this; }, json() {} }, () => {});
    return status;
  };
  // A browser that sends neither Origin nor Fetch Metadata gives no sign of where the request came from.
  assert.equal(run('/api/start', {}), 403);
  assert.equal(run('/api/start', { 'sec-fetch-site': 'none' }), 403, 'typed or bookmarked');
  assert.equal(run('/api/start', { 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(run('/api/start', { 'sec-fetch-site': 'same-origin' }), 200);
  assert.equal(run('/api/start', { origin: 'https://app.example' }), 200);
  assert.equal(run('/api/start', { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }), 403);
  assert.equal(run('/api/start', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }), 403);
  // Pages and other reads are untouched.
  assert.equal(run('/canvas2', {}), 200);
  assert.equal(run('/api/library/libraries', {}), 200);
});
