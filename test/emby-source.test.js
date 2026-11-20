import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';

process.env.SESSION_SECRET ||= 'test-only-secret-with-at-least-32-characters';
const { createEmbySource, parseEmbyUrl } = await import('../emby-source.js');
const { sourceProblems } = await import('../sources.js');

const SERVER_ID = 'a'.repeat(32);
const USER_ID = 'b'.repeat(32);
const TOKEN = 'emby-token-never-seen-by-the-browser';
const PLAY = 'c'.repeat(32);
const BASE = 'http://emby.test:8096';
const calls = [];
// Media playlist requests that time out first, as when Emby waits on a drive spinning up.
let coldDriveTimeouts = 0;

// A tiny Emby: just enough of the API the source uses, recording what it was asked.
async function fakeEmby(input, init = {}) {
  const url = new URL(String(input));
  const headers = init.headers || {};
  const call = { method: init.method || 'GET', path: url.pathname, params: url.searchParams, headers, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const authorized = headers['X-Emby-Token'] === TOKEN;
  if (url.pathname === '/System/Info/Public') return json({ Id: SERVER_ID, ServerName: 'Test Emby' });
  if (url.pathname === '/Users/AuthenticateByName') {
    if (call.body.Pw !== 'right') return new Response('', { status: 401 });
    return json({ AccessToken: TOKEN, ServerId: SERVER_ID, User: { Id: USER_ID, Name: 'Sam' } });
  }
  if (url.pathname.startsWith('/Items/') && url.pathname.endsWith('/Images/Primary'))
    return authorized ? new Response('png', { headers: { 'Content-Type': 'image/png' } }) : new Response('', { status: 401 });
  if (!authorized && !url.pathname.startsWith('/videos/')) return new Response('', { status: 401 });
  if (url.pathname === `/Users/${USER_ID}/Views`) return json({ Items: [{ Id: '3', Name: 'Movies', CollectionType: 'movies' }, { Id: '9', Name: 'Music', CollectionType: 'music' }] });
  if (url.pathname === `/Users/${USER_ID}/Items`) {
    return json({ TotalRecordCount: 1, Items: [{ Id: '909', Name: 'A Movie', Type: 'Movie', ProductionYear: 2009, RunTimeTicks: 36_000_000_000, ImageTags: { Primary: 'x' }, UserData: { PlaybackPositionTicks: 600_000_000 } }] });
  }
  if (url.pathname === `/Users/${USER_ID}/Items/909`) {
    return json({
      Id: '909', Name: 'A Movie', Type: 'Movie', RunTimeTicks: 36_000_000_000, UserData: {},
      MediaSources: [{ Id: 'mediasource_909', MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 },
        { Index: 3, Type: 'Subtitle', Language: 'eng', DisplayTitle: 'English (SUBRIP)', IsTextSubtitleStream: true },
        { Index: 5, Type: 'Subtitle', Language: 'fre', DisplayTitle: 'French (PGSSUB)', IsTextSubtitleStream: false },
      ] }],
    });
  }
  if (url.pathname === '/Videos/909/mediasource_909/Subtitles/3/Stream.srt') return new Response('1\n00:01:08,777 --> 00:01:12,155\nBoy meets girl.\n');
  if (url.pathname === '/Items/909/PlaybackInfo') {
    return json({ PlaySessionId: PLAY, MediaSources: [{ Id: 'mediasource_909', TranscodingUrl: `/videos/909/master.m3u8?DeviceId=x&MediaSourceId=mediasource_909&PlaySessionId=${PLAY}&api_key=SECRET&VideoCodec=h264&SubtitleStreamIndex=2&SubtitleMethod=Encode` }] });
  }
  if (url.pathname === '/videos/909/master.m3u8') {
    return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?DeviceId=x&PlaySessionId=${PLAY}\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (url.pathname === '/videos/909/main.m3u8' && coldDriveTimeouts > 0) {
    coldDriveTimeouts -= 1;
    throw new DOMException('The operation timed out.', 'TimeoutError');
  }
  if (url.pathname === '/videos/909/main.m3u8') {
    return new Response(`#EXTM3U\n#EXTINF:3.0,\nhls1/main/0.ts?PlaySessionId=${PLAY}\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (url.pathname === '/videos/909/hls1/main/0.ts') return new Response('SEGMENT', { headers: { 'Content-Type': 'video/mp2t' } });
  if (['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped', '/Sessions/Logout', '/Videos/ActiveEncodings', `/Users/${USER_ID}/PlayedItems/909`].includes(url.pathname)) return new Response(null, { status: 204 });
  return json({}, 404);
}

const collections = new Map();
const store = { collection: name => collections.get(name) ?? collections.set(name, { get: async () => undefined, update: async () => {} }).get(name) };
const pipeUpstream = (upstream, res) => Readable.fromWeb(upstream.body).pipe(res);
const config = { plex: { productName: 'Test Player', videoBitrate: 4000 }, auth: { sessionDays: 1, secureCookies: false } };
const source = await createEmbySource({ config, store, pipeUpstream, env: { EMBY_URL: `${BASE}/`, SESSION_SECRET: process.env.SESSION_SECRET }, fetchImpl: fakeEmby, signedIn: event => signedIn.push(event) });
const signedIn = [];

// A real Express app around the source, the way server.js mounts one.
const app = express();
app.use(express.json());
app.use((req, res, next) => source.auth.loadSession(req, res, next));
source.registerRoutes(app, { rateLimit: () => (_req, _res, next) => next() });
const owned = new Set();
app.get('/api/start', async (req, res) => {
  const state = {};
  try { await source.playback.start(req, res, { itemId: req.query.key, state, stopState: async () => {} }); owned.add(state.active?.sessionId); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/proxy/*', (req, res) => source.playback.proxy(req, res, { ownsSession: id => owned.has(id) }));
const library = read => async (req, res) => { try { res.json(await read(source.library(req), req)); } catch (error) { res.status(error.message === 'Not authenticated' ? 401 : 502).json({ error: error.message }); } };
app.get('/lib/libraries', library(lib => lib.libraries()));
app.get('/lib/items/:id', library((lib, req) => lib.libraryItems(req.params.id, {})));
app.get('/lib/item/:id', library((lib, req) => lib.itemDetails(req.params.id)));
app.get('/lib/tracks/:id', library((lib, req) => lib.subtitleTracks(req.params.id)));
app.get('/lib/text/:id/:track', library(async (lib, req) => ({ text: await lib.subtitleText(req.params.id, req.params.track) })));
app.get('/thumb', (req, res) => source.sendThumbnail(req, res));
app.post('/progress', async (req, res) => { await source.watchState.reportProgress(req, req.body); res.json({ ok: true }); });
app.post('/watched/:id', async (req, res) => { await source.watchState.markWatched(req, req.params.id); res.json({ ok: true }); });
app.post('/stop', async (_req, res) => { await source.playback.stop({ sessionId: PLAY, deviceId: 'dev', accessToken: TOKEN }); res.json({ ok: true }); });
app.post('/logout', (req, res) => { source.auth.clearSession(req, res); res.json({ ok: true }); });
const server = await new Promise(resolve => { const s = createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
after(() => server.close());
const at = path => `http://127.0.0.1:${server.address().port}${path}`;

let cookie = '';
const send = (path, { method = 'GET', body } = {}) => fetch(at(path), { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
async function signIn() {
  const response = await send('/api/auth/emby/password', { method: 'POST', body: { username: 'sam', password: 'right' } });
  cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
  return response;
}

test('EMBY_URL accepts an http(s) address and rejects anything else without repeating it', () => {
  assert.equal(parseEmbyUrl('http://192.168.1.50:8096/'), 'http://192.168.1.50:8096');
  assert.equal(parseEmbyUrl('https://example.com/emby/'), 'https://example.com/emby');
  for (const bad of ['192.168.1.50:8096', 'ftp://x', 'https://user:secret@emby.example.com', 'https://x.example/?api_key=1', 'https://x.example/#a', '']) {
    assert.throws(() => parseEmbyUrl(bad), error => { assert.match(error.message, /EMBY_URL must be/); assert.ok(!error.message.includes('secret')); return true; }, bad);
  }
});

test('the source meets the source contract, with its own sign-in page', () => {
  assert.deepEqual(sourceProblems(source, { id: 'emby', type: 'emby' }), []);
  assert.equal(source.signInOptions.signInPage, '/emby-sign-in');
  assert.ok(source.auth.isPublicPath('/emby-sign-in') && source.auth.isPublicPath('/api/auth/emby/password'));
  assert.ok(!source.auth.isPublicPath('/api/library/libraries'));
  assert.ok(source.isValidId('909') && !['', 'abc', '9'.repeat(13), '../1', '1 2'].some(source.isValidId));
});

test('a wrong password is refused and a right one signs in without exposing the token', async () => {
  assert.equal((await send('/api/auth/emby/password', { method: 'POST', body: { username: 'sam', password: 'wrong' } })).status, 401);
  assert.equal((await send('/lib/libraries')).status, 401);
  const response = await signIn();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.ok(!cookie.includes(TOKEN), 'the cookie is sealed');
  const login = calls.find(call => call.path === '/Users/AuthenticateByName' && call.body.Pw === 'right');
  assert.match(login.headers['X-Emby-Authorization'], /^MediaBrowser Client="Test Player", Device="Test Player", DeviceId="[^"]+", Version="1.0"$/);
  assert.deepEqual(signedIn.at(-1), { sourceType: 'emby', userKey: `emby:${SERVER_ID}:${USER_ID}` });
  assert.equal(await source.auth.getSessionAccountKey({ headers: {} }), null);
  assert.equal((await send('/api/auth/emby/password', { method: 'POST', body: { username: '', password: 'x' } })).status, 400);
});

test('libraries and items are shaped like the other sources', async () => {
  assert.deepEqual(await (await send('/lib/libraries')).json(), [{ id: '3', title: 'Movies', type: 'movie' }]);
  const { total, items } = await (await send('/lib/items/3')).json();
  assert.equal(total, 1);
  assert.deepEqual(items[0], {
    ratingKey: '909', title: 'A Movie', year: 2009, type: 'movie', thumbnail: '/api/library/thumb?path=909%2FPrimary&width=390&height=585',
    duration: 60, durationMs: 3_600_000, viewOffset: 60_000, viewedLeafCount: 0,
  });
  const details = await (await send('/lib/item/909')).json();
  assert.equal(details.videoCodec, 'hevc');
  assert.equal(details.resolution, '3840x2160');
  const asked = calls.findLast(call => call.path === `/Users/${USER_ID}/Items`);
  assert.equal(asked.headers['X-Emby-Token'], TOKEN);
});

test('thumbnails are fetched for valid image requests only', async () => {
  const thumb = await send('/thumb?path=909%2FPrimary&width=300&height=450');
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get('vary') || '', /\bCookie\b/, 'a kept picture belongs to the session that fetched it');
  assert.equal(calls.findLast(call => call.path === '/Items/909/Images/Primary').headers['X-Emby-Token'], TOKEN);
  for (const bad of ['path=../x%2FPrimary', 'path=909%2FLogo', 'path=909%2FPrimary&width=9999']) assert.equal((await send(`/thumb?${bad}`)).status, 400, bad);
});

test('text subtitles are fetched as SubRip and returned as WebVTT; picture ones are burn tracks', async () => {
  const tracks = await (await send('/lib/tracks/909')).json();
  assert.deepEqual(tracks.map(track => [track.id, track.language, track.kind]), [['3', 'eng', 'text'], ['5', 'fra', 'burn']]);
  const { text } = await (await send('/lib/text/909/3')).json();
  assert.match(text, /^WEBVTT\n\n00:01:08\.777 --> 00:01:12\.155\nBoy meets girl\./);
  assert.equal((await (await send('/lib/text/909/5')).json()).text, null, 'a picture track has no text');
});

test('a stream asks for no subtitles, never exposes the token, and goes through the proxy', async () => {
  const response = await send('/api/start?key=909&quality=medium');
  assert.equal(response.status, 200);
  const playlist = await response.text();
  assert.ok(!playlist.includes(TOKEN) && !playlist.includes('SECRET') && !/api_?key/i.test(playlist));
  assert.match(playlist, /^\/proxy\/videos\/909\/main\.m3u8\?.*PlaySessionId=c{32}/m);
  const info = calls.findLast(call => call.path === '/Items/909/PlaybackInfo');
  assert.equal(info.params.get('SubtitleStreamIndex'), '-1', 'tells Emby not to pick a default track');
  assert.equal(info.params.get('EnableDirectPlay'), 'false');
  assert.equal(info.body.DeviceProfile.TranscodingProfiles[0].Container, 'ts');
  const master = calls.findLast(call => call.path === '/videos/909/master.m3u8');
  assert.equal(master.headers['X-Emby-Token'], TOKEN);
  assert.ok(!master.params.has('SubtitleStreamIndex') && !master.params.has('SubtitleMethod') && !master.params.has('api_key'),
    'Emby burns subtitles in whenever the playlist names an index, even -1');
  assert.equal(master.params.get('VideoBitrate'), '1000000');

  const variant = playlist.split('\n').find(line => line.startsWith('/proxy/'));
  coldDriveTimeouts = 1;
  const slow = await send(variant);
  assert.equal(slow.status, 503, 'Emby not answering in time is retried, not failed');
  assert.equal(slow.headers.get('retry-after'), '1');
  const media = await (await send(variant)).text();
  const segment = media.split('\n').find(line => line.startsWith('/proxy/'));
  assert.equal(segment.split('?')[0], '/proxy/videos/909/hls1/main/0.ts');
  const piece = await send(segment);
  assert.equal(piece.status, 200);
  assert.equal(await piece.text(), 'SEGMENT');
});

test('a picture subtitle chosen by the viewer is drawn in by Emby', async () => {
  await send('/api/start?key=909&subtitle=5');
  assert.equal(calls.findLast(call => call.path === '/Items/909/PlaybackInfo').params.get('SubtitleStreamIndex'), '5');
  const master = calls.findLast(call => call.path === '/videos/909/master.m3u8');
  assert.equal(master.params.get('SubtitleStreamIndex'), '5');
  assert.equal(master.params.get('SubtitleMethod'), 'Encode');
});

test('the proxy only serves this viewer\'s own streams and known media paths', async () => {
  owned.add(PLAY);
  for (const path of [
    '/proxy/videos/909/hls1/main/0.ts?PlaySessionId=' + 'd'.repeat(32),           // not this viewer's session
    '/proxy/videos/909/hls1/main/0.ts',                                              // no session
    `/proxy/Users/${USER_ID}/Items?PlaySessionId=${PLAY}`,                            // not a media path
    `/proxy/videos/909/hls1/main/..%2F..%2Fx.ts?PlaySessionId=${PLAY}`,               // encoded traversal
    `/proxy/videos/909/hls1/main/0.ts?PlaySessionId=${PLAY}&api_key=stolen`,          // a key from the browser
  ]) assert.equal((await send(path)).status, 403, path);
  const before = calls.length;
  cookie = '';
  assert.equal((await send(`/proxy/videos/909/hls1/main/0.ts?PlaySessionId=${PLAY}`)).status, 401);
  assert.equal(calls.length, before, 'nothing reached Emby without a session');
  await signIn();
});

test('progress carries the play session Emby needs; watched, stop and sign-out reach Emby', async () => {
  await send('/api/start?key=909');
  await send('/progress', { method: 'POST', body: { itemId: '909', timeMs: 600000, state: 'playing' } });
  let progress = calls.findLast(call => call.path === '/Sessions/Playing/Progress');
  assert.equal(progress.body.PlaySessionId, PLAY);
  assert.equal(progress.body.MediaSourceId, 'mediasource_909');
  assert.equal(progress.body.PositionTicks, 6_000_000_000);
  await send('/progress', { method: 'POST', body: { itemId: '909', timeMs: 660000, state: 'stopped' } });
  assert.equal(calls.findLast(call => call.path === '/Sessions/Playing/Stopped').body.PlaySessionId, PLAY);
  // No remembered stream (for example after a restart): still a play session ID, so Emby accepts it.
  await send('/progress', { method: 'POST', body: { itemId: '910', timeMs: 1000, state: 'playing' } });
  progress = calls.findLast(call => call.path === '/Sessions/Playing/Progress');
  assert.match(progress.body.PlaySessionId, /^[0-9a-f]{32}$/);

  await send('/watched/909', { method: 'POST' });
  assert.equal(calls.findLast(call => call.path === `/Users/${USER_ID}/PlayedItems/909`).method, 'POST');
  await send('/stop', { method: 'POST' });
  const stop = calls.findLast(call => call.path === '/Videos/ActiveEncodings');
  assert.equal(stop.method, 'DELETE');
  assert.equal(stop.params.get('PlaySessionId'), PLAY);
  await send('/logout', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call.path === '/Sessions/Logout'), 'the token is revoked at Emby');
});
