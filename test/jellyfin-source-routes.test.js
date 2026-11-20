import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCookieSealer } from '../session-cookie.js';

// A Jellyfin-only install (no Plex) driven end to end through the real
// server: sign-in, browsing, playback through the proxy, watch state,
// limits and admin. Jellyfin is mocked; nothing leaves the process.
const temporary = mkdtempSync(path.join(tmpdir(), 'tesladash-jellyfin-test-'));
const SECRET = 'test-only-secret-with-at-least-32-characters';
const SERVER = 'a'.repeat(32);
const USER = 'b'.repeat(32);
const LIB = 'c'.repeat(32);
const SHOWS = 'd'.repeat(32);
const MOVIE = 'e'.repeat(32);
const EPISODE = 'f'.repeat(32);
const PLAY = '1'.repeat(32);
const DASHED = `${MOVIE.slice(0, 8)}-${MOVIE.slice(8, 12)}-${MOVIE.slice(12, 16)}-${MOVIE.slice(16, 20)}-${MOVIE.slice(20)}`;
const pluginPath = path.join(temporary, 'limits-plugin.js');
writeFileSync(pluginPath, `
export default {
  getQuotaStatus(key) { globalThis.__limitKeys.push(key); return { remainingSeconds: 3600 }; },
  getAccountKey(session, key) { globalThis.__sessions.push(session.sourceType); return key; },
  registerRoutes(_app, context) {
    globalThis.__accounts = context.accounts;
    context.admin.registerTab({ id: 'test', label: 'Test', file: ${JSON.stringify(pluginPath)} });
  },
};
`);
Object.assign(globalThis, { __limitKeys: [], __sessions: [] });
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: 'development', SESSION_SECRET: SECRET,
  PLEX_URL: '', EMBY_URL: '', JELLYFIN_URL: 'https://jf.example', JELLYFIN_NAME: 'Home Jellyfin',
  APP_ORIGIN: 'https://dash.example', TRUST_PROXY: '', FREESTUFFCRAZY_PLUGINS_DIR: '',
  FREESTUFFCRAZY_PLUGIN_MODULES: pathToFileURL(pluginPath).href,
  FREESTUFFCRAZY_ADMIN: `jellyfin:${USER}:Sam`,
  FREESTUFFCRAZY_ADMIN_TOKEN_SHA256: createHash('sha256').update('x'.repeat(64)).digest('hex'),
});

const KID = '9'.repeat(31) + '8';
// user: who the next sign-in is; tokenUsers maps each issued token to its user.
const jellyfin = { quickConnect: true, approved: false, administrator: false, otherServer: false, extraMasterLines: '', tokens: 0,
  user: { Id: USER, Name: 'Sam' }, tokenUsers: new Map() };
const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body });
  const json = data => Response.json(data);
  const p = url.pathname;
  const m = options.method || 'GET';
  if (url.origin !== 'https://jf.example') throw new Error(`Unexpected upstream ${url.origin}`);
  if (p === '/System/Info/Public') return json({ Id: SERVER, ServerName: 'container-name' });
  if (p === '/QuickConnect/Enabled') return json(jellyfin.quickConnect);
  if (p === '/QuickConnect/Initiate') return json({ Secret: 'qc-secret', Code: '123456' });
  if (p === '/QuickConnect/Connect') return json({ Authenticated: jellyfin.approved && url.searchParams.get('secret') === 'qc-secret' });
  const signedIn = { AccessToken: `jf-token-${++jellyfin.tokens}`, ServerId: jellyfin.otherServer ? '9'.repeat(32) : SERVER, User: jellyfin.user };
  jellyfin.tokenUsers.set(signedIn.AccessToken, jellyfin.user);
  if (p === '/Users/AuthenticateWithQuickConnect') return json(signedIn);
  if (p === '/Users/AuthenticateByName') return body.Pw === 'right' ? json(signedIn) : new Response('', { status: 401 });
  if (p === '/Users/Me') {
    const user = jellyfin.tokenUsers.get(/Token="([^"]+)"/.exec(options.headers.Authorization)?.[1]);
    return user ? json({ ...user, Policy: { IsAdministrator: jellyfin.administrator } }) : new Response('', { status: 401 });
  }
  if (p === '/UserViews') return json({ Items: [
    { Id: LIB, Name: 'Movies', CollectionType: 'movies' },
    { Id: SHOWS, Name: 'Shows', CollectionType: 'tvshows' },
    { Id: '0'.repeat(32), Name: 'Music', CollectionType: 'music' },
  ] });
  const movie = { Id: MOVIE, Name: 'Test Movie', Type: 'Movie', ProductionYear: 2020, RunTimeTicks: 60 * 60 * 1e7,
    UserData: { PlaybackPositionTicks: 90 * 1e7 }, ImageTags: { Primary: 'tag' }, BackdropImageTags: ['b'] };
  const episode = { Id: EPISODE, Name: 'Pilot', Type: 'Episode', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2,
    RunTimeTicks: 30 * 60 * 1e7, UserData: {}, ImageTags: { Primary: 'tag' } };
  if (p === '/Items' && url.searchParams.get('ParentId') === LIB) return json({ TotalRecordCount: 1, Items: [movie] });
  if (p === `/Items/${MOVIE}`) return json({ ...movie, Overview: 'About it', Genres: ['Drama'],
    MediaSources: [{ Id: MOVIE, MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 },
      { Type: 'Audio', Index: 1, Language: 'eng' },
      { Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'eng', DisplayTitle: 'English - SubRip', IsTextSubtitleStream: true, IsDefault: true },
      { Type: 'Subtitle', Index: 3, Codec: 'pgssub', Language: 'ger', DisplayTitle: 'German - PGSSUB', IsTextSubtitleStream: false },
      { Type: 'Subtitle', Index: 4, Codec: 'ass', DisplayTitle: 'Forced', IsTextSubtitleStream: true, IsForced: true }] }] });
  if (p === `/Videos/${MOVIE}/${MOVIE}/Subtitles/2/0/Stream.vtt`) return new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n', { headers: { 'Content-Type': 'text/vtt' } });
  if (p === `/Items/${MOVIE}/Images/Primary`) return new Response(new Uint8Array(20), { headers: { 'Content-Type': 'image/jpeg' } });
  if (p === '/UserItems/Resume') return json({ Items: url.searchParams.get('ParentId') === LIB ? [movie] : [] });
  if (p === '/Shows/NextUp') return json({ Items: [episode] });
  if (p === `/Items/${MOVIE}/PlaybackInfo`) return json({ PlaySessionId: PLAY, MediaSources: [{ Id: MOVIE,
    TranscodingUrl: `/videos/${DASHED}/master.m3u8?DeviceId=x&MediaSourceId=${MOVIE}&PlaySessionId=${PLAY}&ApiKey=jf-token&SubtitleStreamIndex=3&SubtitleMethod=Encode&AudioBitrate=384000&VideoBitrate=616000` }] });
  if (p === `/videos/${DASHED}/master.m3u8`) return new Response(`#EXTM3U\n${jellyfin.extraMasterLines}#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmain.m3u8?PlaySessionId=${PLAY}&api_key=jf-token&VideoCodec=h264\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (p === `/videos/${DASHED}/main.m3u8`) return new Response(`#EXTM3U\n#EXTINF:3.0,\nhls1/main/0.ts?PlaySessionId=${PLAY}&runtimeTicks=0\n#EXT-X-ENDLIST\n`, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (p === `/videos/${DASHED}/hls1/main/0.ts`) return new Response(new Uint8Array(188), { headers: { 'Content-Type': 'video/mp2t' } });
  if (['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped', '/Sessions/Logout', '/Videos/ActiveEncodings'].includes(p)) return new Response(null, { status: 204 });
  if (p === `/UserPlayedItems/${MOVIE}`) return json({ Played: m === 'POST' });
  throw new Error(`Unexpected mocked Jellyfin request: ${m} ${p}`);
};
const { app } = await import('../server.js');
after(() => { globalThis.fetch = originalFetch; rmSync(temporary, { recursive: true, force: true }); });

function request(url, { method = 'GET', body, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.encrypted = true;
    const req = new IncomingMessage(socket);
    req.url = url; req.method = method;
    const payload = body === undefined ? null : JSON.stringify(body);
    req.headers = { host: 'dash.example', origin: 'https://dash.example', cookie, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = function (chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    res.end = function (chunk) {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      const type = String(res.getHeader('content-type') || '');
      const text = /json|text|mpegurl/.test(type) ? buffer.toString() : '';
      resolve({ status: res.statusCode, headers: res.getHeaders(), bytes: buffer.length, text,
        json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null });
      res.emit('finish'); return res;
    };
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
const cookieFrom = (response, name) => [response.headers['set-cookie'] || []].flat().find(value => value.startsWith(name + '='))?.split(';')[0];
const callsTo = (pathname, method) => calls.filter(call => call.url.pathname === pathname && (!method || call.method === method));

async function signIn() {
  jellyfin.approved = true;
  const start = await request('/api/auth/jellyfin/start', { method: 'POST' });
  const poll = await request('/api/auth/jellyfin/poll', { cookie: cookieFrom(start, 'freeStuffCrazyPlayerJellyfinLogin') });
  assert.equal(poll.json.authenticated, true);
  return cookieFrom(poll, 'freeStuffCrazyPlayerSession');
}
// Sign-in is rate limited, so most tests share one session.
let shared = null;
const session = async () => (shared ??= await signIn());

test('the login page is offered only the configured backend, and nothing else is public', async () => {
  assert.deepEqual((await request('/api/auth/sources')).json, [{ id: 'jellyfin', type: 'jellyfin', name: 'Jellyfin', askServer: false, serverRequired: false }]);
  assert.equal((await request('/api/library/libraries')).status, 401);
  assert.equal((await request('/api/auth/plex/pin', { method: 'POST' })).status, 401, 'no Plex routes without Plex');
});

test('Quick Connect sign-in waits for approval, checks the server and stores the credential under Jellyfin', async () => {
  jellyfin.approved = false;
  const start = await request('/api/auth/jellyfin/start', { method: 'POST' });
  assert.deepEqual(start.json, { mode: 'quickconnect', code: '123456', serverName: 'Home Jellyfin' });
  const login = cookieFrom(start, 'freeStuffCrazyPlayerJellyfinLogin');
  assert.doesNotMatch(login, /qc-secret/, 'the secret stays encrypted');
  assert.deepEqual((await request('/api/auth/jellyfin/poll', { cookie: login })).json, { authenticated: false, pending: true });
  assert.equal((await request('/api/auth/jellyfin/poll')).status, 400, 'polling needs the login cookie');

  jellyfin.approved = true;
  jellyfin.otherServer = true;
  assert.equal((await request('/api/auth/jellyfin/poll', { cookie: login })).status, 502, 'a token for another server is refused');
  jellyfin.otherServer = false;
  const done = await request('/api/auth/jellyfin/poll', { cookie: login });
  assert.equal(done.json.authenticated, true);
  const payload = createCookieSealer(SECRET).open('session', decodeURIComponent(cookieFrom(done, 'freeStuffCrazyPlayerSession').split('=')[1]));
  assert.equal(payload.active, 'jellyfin');
  assert.equal(payload.creds.jellyfin.type, 'jellyfin');
  assert.equal(payload.creds.jellyfin.serverId, SERVER);
  assert.equal(payload.creds.jellyfin.userId, USER);
  assert.match(payload.creds.jellyfin.accessToken, /^jf-token-/);

  const me = await request('/api/auth/me', { cookie: cookieFrom(done, 'freeStuffCrazyPlayerSession') });
  assert.equal(me.json.title, 'Sam');
  assert.deepEqual(me.json.source, { id: 'jellyfin', type: 'jellyfin', name: 'Jellyfin' });
  assert.equal(me.json.profiles, false, 'no Plex Home profiles to switch between');
});

test('the password form is used when the server has Quick Connect turned off', async () => {
  jellyfin.quickConnect = false;
  try {
    const start = await request('/api/auth/jellyfin/start', { method: 'POST' });
    assert.deepEqual(start.json, { mode: 'password', serverName: 'Home Jellyfin' });
    const login = cookieFrom(start, 'freeStuffCrazyPlayerJellyfinLogin');
    assert.equal((await request('/api/auth/jellyfin/password', { method: 'POST', cookie: login, body: { username: 'sam', password: 'wrong' } })).status, 401);
    const done = await request('/api/auth/jellyfin/password', { method: 'POST', cookie: login, body: { username: 'sam', password: 'right' } });
    assert.equal(done.json.authenticated, true);
    assert.equal(callsTo('/Users/AuthenticateByName').at(-1).body.Username, 'sam');
  } finally {
    jellyfin.quickConnect = true;
  }
});

test('browsing returns the same shapes the pages already use for Plex', async () => {
  const cookie = await session();
  assert.deepEqual((await request('/api/library/libraries', { cookie })).json,
    [{ id: LIB, title: 'Movies', type: 'movie' }, { id: SHOWS, title: 'Shows', type: 'show' }]);
  const { items } = (await request(`/api/library/library/${LIB}?sort=titleSort`, { cookie })).json;
  // A source without playlists, similar artists or lyrics answers with none, not an error.
  assert.deepEqual((await request('/api/library/playlists', { cookie })).json, []);
  assert.deepEqual((await request(`/api/library/similar/${MOVIE}`, { cookie })).json, { sections: [] });
  assert.deepEqual((await request(`/api/library/lyrics/${MOVIE}`, { cookie })).json, { tracks: [] });
  assert.deepEqual((await request(`/api/library/popular/${MOVIE}`, { cookie })).json, []);
  assert.deepEqual((await request(`/api/library/similar-tracks/${MOVIE}`, { cookie })).json, []);
  // A source that cannot list by view or in pages answers as before, and junk in those fields is ignored.
  for (const extra of ['&view=albums&start=0&size=500', '&view=%3Cscript%3E&start=-1&size=abc', '&size=99999']) {
    const same = await request(`/api/library/library/${LIB}?sort=titleSort${extra}`, { cookie });
    assert.equal(same.status, 200, extra);
    assert.deepEqual(same.json.items.map(item => item.ratingKey), items.map(item => item.ratingKey), extra);
  }
  assert.equal(items[0].ratingKey, MOVIE);
  assert.equal(items[0].viewOffset, 90_000);
  assert.equal(items[0].durationMs, 3_600_000);
  assert.equal(items[0].duration, 60);
  assert.equal(new URLSearchParams(items[0].thumbnail.split('?')[1]).get('path'), `${MOVIE}/Primary`);
  assert.equal(callsTo('/Items').at(-1).url.searchParams.get('SortBy'), 'SortName');

  const thumb = await request(items[0].thumbnail, { cookie });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers['content-type'], 'image/jpeg');
  assert.match(thumb.headers.vary, /\bCookie\b/, 'a kept picture belongs to the session that fetched it');
  assert.equal((await request('/api/library/thumb?path=../../etc/Primary', { cookie })).status, 400);

  const details = (await request(`/api/library/item/${MOVIE}`, { cookie })).json;
  assert.equal(details.summary, 'About it');
  assert.equal(details.resolution, '3840x2160');
  assert.match(details.backdrop, /Backdrop/);
  assert.equal((await request('/api/library/item/12345', { cookie })).status, 400, 'Plex-style IDs are not Jellyfin IDs');

  const continueWatching = (await request('/api/library/ondeck', { cookie })).json;
  assert.deepEqual(continueWatching.map(item => [item.ratingKey, item.librarySectionId]), [[MOVIE, LIB], [EPISODE, SHOWS]]);
  assert.equal(continueWatching[1].showTitle, 'Show');
});

test('playback goes through the proxy with the token kept on the server', async () => {
  const cookie = await session();
  const started = await request(`/api/start?key=${MOVIE}&quality=low&playbackId=test-play`, { cookie });
  assert.equal(started.status, 200, started.text);
  assert.doesNotMatch(started.text, /jf-token|api_?key/i);
  const variant = started.text.split('\n').find(line => line.startsWith('/proxy/'));
  assert.match(variant, new RegExp(`^/proxy/videos/${DASHED}/main\\.m3u8\\?`));

  // The transcode asked Jellyfin for what the MCU2 can decode.
  const info = callsTo(`/Items/${MOVIE}/PlaybackInfo`).at(-1);
  const transcode = info.body.DeviceProfile.TranscodingProfiles[0];
  assert.deepEqual([transcode.VideoCodec, transcode.AudioCodec, transcode.Container, transcode.Protocol], ['h264', 'aac', 'ts', 'hls']);
  assert.match(info.headers.Authorization, /Token="jf-token-/);
  const master = callsTo(`/videos/${DASHED}/master.m3u8`).at(-1).url.searchParams;
  assert.equal(master.get('ApiKey'), null, 'the token goes in the header, not the URL');
  assert.equal(master.get('SubtitleStreamIndex'), '-1');
  assert.equal(master.get('SubtitleMethod'), null);
  assert.equal(master.get('AudioBitrate'), '128000');

  const media = await request(variant, { cookie });
  const segment = media.text.split('\n').find(line => line.startsWith('/proxy/'));
  assert.match(segment, new RegExp(`/hls1/main/0\\.ts\\?PlaySessionId=${PLAY}`));
  const bytes = await request(segment, { cookie });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.bytes, 188);

  const otherSession = segment.replace(PLAY, '2'.repeat(32));
  assert.equal((await request(otherSession, { cookie })).status, 403, 'another play session is refused');
  assert.equal((await request(`${segment}&api_key=jf-token`, { cookie })).status, 403, 'a token in the URL is refused');
  assert.equal((await request(`/proxy/Users/${USER}?PlaySessionId=${PLAY}`, { cookie })).status, 403, 'only media paths are proxied');

  // Watch state, in Jellyfin ticks.
  await request('/api/library/progress', { method: 'POST', cookie, body: { ratingKey: MOVIE, timeMs: 30000, state: 'paused' } });
  const progress = callsTo('/Sessions/Playing/Progress').at(-1).body;
  assert.deepEqual([progress.ItemId, progress.PositionTicks, progress.IsPaused], [MOVIE, 300_000_000, true]);
  await request('/api/library/progress', { method: 'POST', cookie, body: { ratingKey: MOVIE, timeMs: 60000, state: 'stopped' } });
  assert.equal(callsTo('/Sessions/Playing/Stopped').at(-1).body.PositionTicks, 600_000_000);
  assert.equal((await request(`/api/library/watched/${MOVIE}`, { method: 'POST', cookie })).status, 200);
  assert.equal(callsTo(`/UserPlayedItems/${MOVIE}`, 'POST').length, 1);
  assert.equal((await request(`/api/library/unwatched/${MOVIE}`, { method: 'POST', cookie })).status, 200);
  assert.equal(callsTo(`/UserPlayedItems/${MOVIE}`, 'DELETE').length, 1);

  // Signing out stops the transcode and revokes the token.
  await request('/api/auth/logout', { method: 'POST', cookie });
  const stop = callsTo('/Videos/ActiveEncodings', 'DELETE').at(-1).url.searchParams;
  assert.equal(stop.get('playSessionId'), PLAY);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(callsTo('/Sessions/Logout', 'POST').length >= 1);
});

test('an item lists its subtitle tracks, text ones separately from picture ones', async () => {
  const cookie = await session();
  const listed = await request(`/api/library/subtitles/${MOVIE}`, { cookie });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.tracks, [
    { id: '2', label: 'English - SubRip', language: 'eng', kind: 'text', forced: false, default: true },
    { id: '4', label: 'Forced', language: null, kind: 'text', forced: true, default: false },
    { id: '3', label: 'German - PGSSUB', language: 'deu', kind: 'burn', forced: false, default: false },
  ]);
  assert.doesNotMatch(listed.text, /jf-token|api_?key/i);
  assert.equal((await request('/api/library/subtitles/not-an-id', { cookie })).status, 400);
});

test('a text track is fetched from Jellyfin as WebVTT, and only that item\'s own text tracks', async () => {
  const cookie = await session();
  const vtt = await request(`/api/library/subtitle/${MOVIE}/2`, { cookie });
  assert.equal(vtt.status, 200, vtt.text);
  assert.match(vtt.headers['content-type'], /^text\/vtt/);
  assert.match(vtt.text, /^WEBVTT\n\n00:00:01\.000 --> 00:00:02\.000\nHello/);
  const upstream = callsTo(`/Videos/${MOVIE}/${MOVIE}/Subtitles/2/0/Stream.vtt`).at(-1);
  assert.match(upstream.headers.Authorization, /Token="jf-token-/, 'the token goes in the header');
  assert.equal((await request(`/api/library/subtitle/${MOVIE}/3`, { cookie })).status, 404, 'a picture subtitle is not text');
  assert.equal((await request(`/api/library/subtitle/${MOVIE}/9`, { cookie })).status, 404);
  assert.equal((await request(`/api/library/subtitle/${MOVIE}/x`, { cookie })).status, 400);
  assert.equal((await request(`/api/library/subtitle/${MOVIE}/2`)).status, 401);
});

test('a chosen subtitle track is burned into the stream, and without one nothing is', async () => {
  const cookie = await session();
  const started = await request(`/api/start?key=${MOVIE}&quality=low&playbackId=cc-burn&subtitle=3`, { cookie });
  assert.equal(started.status, 200, started.text);
  const info = callsTo(`/Items/${MOVIE}/PlaybackInfo`).at(-1);
  assert.equal(info.url.searchParams.get('subtitleStreamIndex'), '3');
  const master = callsTo(`/videos/${DASHED}/master.m3u8`).at(-1).url.searchParams;
  assert.equal(master.get('SubtitleStreamIndex'), '3');
  assert.equal(master.get('SubtitleMethod'), 'Encode');
  const junk = await request(`/api/start?key=${MOVIE}&quality=low&playbackId=cc-junk&subtitle=3%26x%3D1`, { cookie });
  assert.equal(junk.status, 200, junk.text);
  assert.equal(callsTo(`/Items/${MOVIE}/PlaybackInfo`).at(-1).url.searchParams.get('subtitleStreamIndex'), null);
  assert.equal(callsTo(`/videos/${DASHED}/master.m3u8`).at(-1).url.searchParams.get('SubtitleStreamIndex'), '-1');
});

test('limits group the whole server under one key, and the server is a searchable account', async () => {
  globalThis.__limitKeys.length = 0;
  const cookie = await session();
  const me = await request('/api/auth/me', { cookie });
  assert.deepEqual(me.json.quota, { remainingSeconds: 3600, resetAt: null, breakdown: [] });
  assert.deepEqual(globalThis.__limitKeys, [`jellyfin:${SERVER}`]);
  assert.match(me.json.accountId, /^FSC-/, 'the viewer is shown a public code, not the server ID');
  assert.ok(!me.json.accountId.includes(SERVER));
  assert.equal(globalThis.__sessions.at(-1), 'jellyfin');

  const account = { key: `jellyfin:${SERVER}`, label: 'Home Jellyfin', detail: 'Jellyfin server', source: 'Jellyfin' };
  assert.deepEqual(await globalThis.__accounts.search('home'), [account]);
  assert.deepEqual(await globalThis.__accounts.search(` ${me.json.accountId.toLowerCase().replaceAll('-', ' ')} `), [{ ...account, exact: true }],
    'the code shown to the viewer finds the server, however it is typed');
  assert.deepEqual(await globalThis.__accounts.search('plex'), []);
  assert.deepEqual(await globalThis.__accounts.describe(`jellyfin:${SERVER}`), account);
  assert.equal(await globalThis.__accounts.describe(`jellyfin:${'9'.repeat(32)}`), null);
});

test('the one admin is the Jellyfin user named by both ID and username, whatever their Jellyfin role', async () => {
  // Sam is named in FREESTUFFCRAZY_ADMIN and isn't a Jellyfin administrator.
  jellyfin.administrator = false;
  const cookie = await session();
  assert.equal((await request('/api/admin/auth/status', { cookie })).status, 200);
  assert.equal((await request('/api/auth/me', { cookie })).json.adminAvailable, true);

  // Not the admin: an unnamed Jellyfin administrator, someone else called
  // Sam, and the right user ID under a different name.
  jellyfin.administrator = true;
  try {
    for (const user of [{ Id: KID, Name: 'Kid' }, { Id: KID, Name: 'Sam' }, { Id: USER, Name: 'Samuel' }]) {
      jellyfin.user = user;
      const other = await signIn();
      assert.equal((await request('/api/admin/auth/status', { cookie: other })).status, 403, JSON.stringify(user));
      assert.equal((await request('/api/auth/me', { cookie: other })).json.adminAvailable, false);
    }
  } finally {
    jellyfin.user = { Id: USER, Name: 'Sam' };
    jellyfin.administrator = false;
  }
});

test('a master playlist that lists Trickplay thumbnails still plays, and anything else unknown in it is still refused', async () => {
  const cookie = await session();
  const trickplay = `#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=12345,RESOLUTION=320x180,CODECS="jpeg",URI="Trickplay/320/tiles.m3u8?MediaSourceId=${MOVIE}&ApiKey=jf-token"\n`;
  const quiet = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    jellyfin.extraMasterLines = trickplay;
    const started = await request(`/api/start?key=${MOVIE}&quality=low&playbackId=trickplay-play`, { cookie });
    assert.equal(started.status, 200, started.text);
    assert.doesNotMatch(started.text, /Trickplay|IMAGE-STREAM|jf-token|api_?key/i, 'the thumbnail playlist is left out, with its token');
    assert.match(started.text, /^\/proxy\/videos\/.*main\.m3u8\?/m, 'and the video is still there');

    // Only that tag is dropped: another entry that is not a media path is still refused, and says which.
    jellyfin.extraMasterLines = `#EXT-X-MEDIA:TYPE=SUBTITLES,URI="Subtitles/1/stream.vtt?MediaSourceId=${MOVIE}&ApiKey=jf-token"\n`;
    const refused = await request(`/api/start?key=${MOVIE}&quality=low&playbackId=other-play`, { cookie });
    assert.notEqual(refused.status, 200);
    assert.ok(logged.some(line => /playlist entry refused/.test(line) && /Subtitles\/1\/stream\.vtt/.test(line)), logged.join('\n'));
    assert.ok(!logged.some(line => /jf-token/.test(line)), 'the log never carries the token');
  } finally { console.error = quiet; jellyfin.extraMasterLines = ''; }
});

test('signing out everywhere rejects this user’s other cookies', async () => {
  const first = await signIn();
  const second = await signIn();
  assert.equal((await request('/api/auth/logout-everywhere', { method: 'POST', cookie: first })).status, 200);
  assert.equal((await request('/api/library/libraries', { cookie: second })).status, 401);
});
