// Emby as a media source: password sign-in, library browsing, HLS playback
// through Emby's transcoder, captions and watch state. One configured server
// (EMBY_URL), plus, with an embyServers plugin, servers users type in. Emby's API is close to Jellyfin's (Jellyfin began as a fork), but
// not the same: item IDs are numbers, there is no Quick Connect, the token goes in
// X-Emby-Token, and a transcode must be asked for with no subtitle index at all to
// leave subtitles out. It produces the same item shapes as the other sources.

import crypto from 'node:crypto';
import { QUALITY_TIERS, QUALITY_LEVELS, normalizeQuality, qualityTiers } from './public/engine/quality-tiers.js';
import { parseCookies, safeError, readBodyText } from './security.js';
import { createCookieSealer, packSession, unpackSession, SESSION_COOKIE_NAME } from './session-cookie.js';
import { adminSpec, adminConfigured } from './admin-auth.js';
import { serverPrompt } from './jellyfin-source.js';
import { describeTrack, orderTracks, toWebVtt, readSubtitleText, TRACK_ID } from './subtitles.js';
import { isTimeout, sendMediaServerSlow } from './media-server-wait.js';

const LOGIN_COOKIE_NAME = 'freeStuffCrazyPlayerEmbyLogin';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
const TICKS_PER_MS = 10_000;
// The most read from a media server's reply: a sign-in step (anyone can start one, and the
// server may be one a visitor typed), a library answer, and a playlist.
const SIGN_IN_JSON_LIMIT = 256 * 1024;
const API_JSON_LIMIT = 32 * 1024 * 1024;
const PLAYLIST_LIMIT = 4 * 1024 * 1024;
const AUDIO_BITRATE = 128_000;
const ITEM_ID = /^\d{1,12}$/;
const HEX_ID = /^[0-9a-f]{32}$/;
// Media paths a viewer may fetch through /proxy/, relative to the server.
const MEDIA_PATH = /^videos\/\d{1,12}\/(?:master\.m3u8|main\.m3u8|hls1\/[A-Za-z0-9_-]{1,64}\/\d{1,7}\.(?:ts|mp4|m4s))$/i;
const IMAGE_TYPES = new Set(['Primary', 'Backdrop', 'Thumb']);
const THUMBNAIL_PRESETS = {
  landscape: { width: 600, height: 338 },
  poster: { width: 390, height: 585 },
  backdrop: { width: 1280, height: 720 },
};
const PUBLIC_PATHS = new Set(['/api/auth/emby/start', '/api/auth/emby/password', '/emby-sign-in', '/emby-sign-in.html', '/emby-sign-in.js']);

const quote = value => String(value).replace(/["\\\r\n]/g, '');
const ms = ticks => (Number.isFinite(ticks) ? Math.round(ticks / TICKS_PER_MS) : null);
const minutes = ticks => (Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 600_000_000) : null);

export const EMBY_URL_FORMAT = 'EMBY_URL must be the Emby server\'s address, such as http://192.168.1.50:8096 or https://emby.example.com.';

// EMBY_URL is the server's address: http(s), a host, an optional port and path
// prefix, and nothing else. The message never repeats the value, which could hold
// credentials.
export function parseEmbyUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error(EMBY_URL_FORMAT); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error(EMBY_URL_FORMAT);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

// The plugin that lets users sign in to their own Emby servers, if any. It exports
// `embyServers`: resolve(address) -> the server URL to use, or throws a message for the
// user; fetch(url, init) makes every request to such a server, so the plugin decides
// which addresses may be reached (and may explain a failure the user can fix in
// error.userMessage). Optional: maxBitrate(url) -> kbps cap, displayAddress(url) ->
// what to type to sign in again, prompt -> { hint, label, placeholder } wording for
// the address question. Without EMBY_URL every user must give an address.
export const embyServersOf = plugins => plugins.find(plugin => typeof plugin.embyServers?.resolve === 'function'
  && typeof plugin.embyServers?.fetch === 'function')?.embyServers || null;

// Scheme, host and path, without a trailing slash. Not url.origin: a plugin may name
// servers with its own scheme, and only its fetch knows how to reach them.
const normalizeServerUrl = value => {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
};

export async function createEmbySource({ id = 'emby', config, plugins = [], store, pipeUpstream, env = process.env, fetchImpl = (...args) => fetch(...args), signedIn = null }) {
  const tenantServers = embyServersOf(plugins);
  if (!env.EMBY_URL && !tenantServers) throw new Error('Missing EMBY_URL in environment');
  const baseUrl = env.EMBY_URL ? parseEmbyUrl(env.EMBY_URL) : null;
  // home: the configured server, if there is one. Others are users' own servers,
  // reached only through the embyServers plugin.
  const HOME = baseUrl ? { url: baseUrl, fetch: fetchImpl, home: true } : null;
  function serverAt(url) {
    if (!url || url === baseUrl) return HOME;
    if (!tenantServers) return null;
    // The plugin may cap a server's stream bitrate (kbps), for one it reaches over a slow link.
    const cap = Number(tenantServers.maxBitrate?.(url));
    return { url, fetch: (...args) => tenantServers.fetch(...args), home: false, maxBitrateKbps: Number.isFinite(cap) && cap > 0 ? cap : null };
  }
  const serverOf = credential => serverAt(credential.serverUrl);
  const PRODUCT_NAME = config.plex.productName || 'FreeStuffCrazy Player';
  const SESSION_MAX_AGE_MS = config.auth.sessionDays * 24 * 60 * 60 * 1000;
  const sealer = createCookieSealer(env.SESSION_SECRET);
  // FREESTUFFCRAZY_ADMIN=emby:<user ID>:<username> names the one Emby admin; unset, any
  // administrator of the server is one. Emby is asked, not the cookie.
  const spec = adminSpec(env);
  let ADMIN_USER = null;
  if (spec?.type === 'emby') {
    const match = /^([0-9a-f]{32}):(.+)$/.exec(spec.who);
    if (match) ADMIN_USER = { id: match[1], name: match[2].trim() };
    else console.warn('FREESTUFFCRAZY_ADMIN for Emby must be emby:<user ID>:<username>; no Emby admin is set.');
  }
  const signoutGenerations = store.collection('signout-generations');

  // ---- Talking to Emby ----------------------------------------------------

  // The client is named in X-Emby-Authorization; the token travels in X-Emby-Token. The
  // device ID is fixed per sign-in, so each signed-in browser is its own device.
  function headers({ deviceId, token } = {}) {
    return {
      'X-Emby-Authorization': `MediaBrowser Client="${quote(PRODUCT_NAME)}", Device="${quote(PRODUCT_NAME)}", DeviceId="${quote(deviceId || 'freestuffcrazy-player-server')}", Version="1.0"`,
      ...(token ? { 'X-Emby-Token': token } : {}),
    };
  }

  async function request(path, { credential, server, method = 'GET', body, timeoutMs = 10000, deviceId } = {}) {
    const target = server ?? (credential ? serverOf(credential) : HOME);
    if (!target) throw new Error('Emby server is not available');
    return target.fetch(`${target.url}${path}`, {
      method,
      headers: {
        ...headers({ deviceId: credential?.deviceId ?? deviceId, token: credential?.accessToken }),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function api(path, options) {
    const response = await request(path, options);
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Emby API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    // Without a credential this is a sign-in step, open to anyone and possibly aimed at a
    // server the visitor typed, so it gets a small limit; the answers are a few kilobytes.
    const text = await readBodyText(response, options?.credential ? API_JSON_LIMIT : SIGN_IN_JSON_LIMIT);
    return text ? JSON.parse(text) : null;
  }

  // The server's own ID and name, fetched lazily and kept, so an Emby server that is
  // briefly down doesn't stop the player from starting.
  async function readServerInfo(server) {
    const info = await api('/System/Info/Public', { server });
    if (!HEX_ID.test(info?.Id || '')) throw new Error('That address is not an Emby server');
    const name = typeof info.ServerName === 'string' && info.ServerName.trim() ? info.ServerName.trim().slice(0, 80) : 'Emby';
    return { id: info.Id, name: server.home ? (env.EMBY_NAME || name) : name };
  }
  let serverInfoPromise = null;
  // The configured server's name once known, for showing who's signed in where.
  let homeServerName = null;
  function serverInfo() {
    if (!HOME) return Promise.reject(new Error('No Emby server is configured'));
    serverInfoPromise ??= readServerInfo(HOME).then(info => { homeServerName = info.name; return info; }, error => { serverInfoPromise = null; throw error; });
    return serverInfoPromise;
  }
  // Which server a session is on, as shown to its user: its name, and what to type to
  // sign in to it again (none for the configured server). An https address is shown as is.
  function serverSummary(credential) {
    const name = credential.serverName || (credential.serverUrl ? null : homeServerName) || null;
    const address = credential.serverAddress || (/^https:\/\//.test(credential.serverUrl || '') ? credential.serverUrl : null);
    return { name, address: credential.serverUrl ? address : null };
  }
  if (!HOME) {
    console.log('Emby: no server configured; users sign in to their own servers');
  } else {
    try {
      const info = await serverInfo();
      console.log(`Using Emby server at ${baseUrl} (${info.name})`);
    } catch (error) {
      console.warn(`Emby server at ${baseUrl} is not reachable yet: ${safeError(error)}`);
    }
  }

  // ---- Sessions -----------------------------------------------------------

  const cookieOptions = res => ({ httpOnly: true, sameSite: 'lax', secure: config.auth.secureCookies || !!res.req?.secure, path: '/' });
  // Quota and stream limits are shared by everyone on one Emby server: emby:<server ID> for
  // the configured server. A user's own server reports its own ID, so one could pose as
  // another; those are keyed by address too: emby:<server ID>@<host and path>.
  function accountKeyOf(credential) {
    if (!credential.serverUrl) return `emby:${credential.serverId}`;
    const url = new URL(credential.serverUrl);
    return `emby:${credential.serverId}@${url.host}${url.pathname.replace(/\/$/, '')}`;
  }
  // "Sign out everywhere" is per Emby user.
  const generationKey = credential => `${accountKeyOf(credential)}:${credential.userId}`;
  // Users' own servers that have signed in, so admin pages can find them.
  const tenantDirectory = tenantServers && adminConfigured(env) ? store.collection('emby-servers') : null;
  async function generationFor(credential) {
    const value = await signoutGenerations.get(generationKey(credential));
    return Number.isSafeInteger(value) ? value : 0;
  }

  function writeSessionCookie(res, { sid, credential }) {
    res.cookie(SESSION_COOKIE_NAME, sealer.seal('session', packSession({ sid, sourceId: id, credential, renewedAt: Date.now() }), SESSION_MAX_AGE_MS), {
      ...cookieOptions(res), maxAge: SESSION_MAX_AGE_MS,
    });
  }

  const openedSessions = new WeakMap();
  const adminChecks = new Map(); // token hash -> { admin, expires }
  async function loadSession(req, _res, next) {
    try {
      const opened = unpackSession(sealer.open('session', parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]),
        { legacySourceId: 'plex', legacyType: 'plex' });
      const credential = opened?.sourceId === id && opened.credential.type === 'emby' ? opened.credential : null;
      const valid = !!credential && typeof credential.accessToken === 'string' && HEX_ID.test(credential.userId || '')
        && HEX_ID.test(credential.serverId || '') && typeof credential.deviceId === 'string'
        && (credential.serverUrl === undefined ? !!HOME : typeof credential.serverUrl === 'string' && !!serverOf(credential))
        && (credential.generation ?? 0) === await generationFor(credential);
      openedSessions.set(req, valid ? { sessionId: opened.sid, renewedAt: opened.renewedAt, credential } : null);
      next();
    } catch (error) {
      next(error);
    }
  }
  const getSession = req => openedSessions.get(req) ?? null;
  function credentialFor(req) {
    const credential = getSession(req)?.credential;
    if (!credential) throw new Error('Not authenticated');
    return credential;
  }

  // Tell Emby to forget this token. Best effort: the cookie is cleared regardless.
  function revoke(credential) {
    if (!credential) return;
    request('/Sessions/Logout', { credential, method: 'POST', timeoutMs: 5000 })
      .then(response => response.body?.cancel(), () => {});
  }

  async function startSession(res, result, { deviceId, server, info, address }) {
    // The token must belong to the server the sign-in started on.
    if (result?.ServerId !== info.id || !HEX_ID.test(result?.User?.Id || '') || typeof result.AccessToken !== 'string') {
      throw new Error('This Emby sign-in is for a different server');
    }
    const credential = {
      type: 'emby',
      serverId: info.id,
      serverName: info.name,
      ...(server.home ? {} : { serverUrl: server.url, ...(address ? { serverAddress: address } : {}) }),
      userId: result.User.Id,
      name: typeof result.User.Name === 'string' ? result.User.Name.slice(0, 120) : 'Emby user',
      accessToken: result.AccessToken,
      deviceId,
      iat: Date.now(),
    };
    credential.generation = await generationFor(credential);
    if (tenantDirectory && !server.home) {
      await tenantDirectory.set(accountKeyOf(credential), { name: info.name, address: server.url }).catch(() => {});
    }
    writeSessionCookie(res, { sid: crypto.randomBytes(16).toString('hex'), credential });
    res.clearCookie(LOGIN_COOKIE_NAME, cookieOptions(res));
    signedIn?.({ sourceType: 'emby', userKey: `emby:${info.id}:${credential.userId}` });
  }

  // The sign-in in progress (the server chosen and the device ID) lives in its own
  // encrypted cookie.
  function setLoginCookie(res, state) {
    res.cookie(LOGIN_COOKIE_NAME, sealer.seal('emby-login', state, LOGIN_TTL_MS), { ...cookieOptions(res), maxAge: LOGIN_TTL_MS });
  }
  const loginState = req => sealer.open('emby-login', parseCookies(req.headers.cookie)[LOGIN_COOKIE_NAME]);

  const auth = {
    loadSession,
    isPublicPath: path => PUBLIC_PATHS.has(path),
    requireAuth(req, res, next) {
      const session = getSession(req);
      if (session && !(Date.now() - session.renewedAt < RENEW_AFTER_MS)) writeSessionCookie(res, { sid: session.sessionId, credential: session.credential });
      next();
    },
    getSessionId: req => getSession(req)?.sessionId || null,
    getSessionCredential: req => getSession(req)?.credential ?? null,
    getSessionUser: req => {
      const credential = getSession(req)?.credential;
      return credential ? { title: credential.name, thumb: null } : null;
    },
    // Which server the session is on, to show its user. A server plugin may name it
    // (displayAddress), e.g. when the stored URL isn't typeable.
    getSessionServer: async req => {
      const credential = getSession(req)?.credential;
      if (!credential) return null;
      const summary = serverSummary(credential);
      if (credential.serverUrl && typeof tenantServers?.displayAddress === 'function') {
        const named = await Promise.resolve(tenantServers.displayAddress(credential.serverUrl)).catch(() => null);
        if (typeof named === 'string' && named.trim()) summary.address = named.trim().slice(0, 200);
      }
      return summary;
    },
    getSessionProfileId: req => getSession(req)?.credential.userId || null,
    // No plex.tv-style account; Plex-specific plugins see no account ID.
    getSessionAccountId: async () => null,
    getSessionIdentity: async () => null,
    getSessionIsAdmin: () => false,
    async getAdminIdentity(req) {
      const credential = getSession(req)?.credential;
      // Only on the configured server: a user's own server could claim any user ID.
      if (!credential || !HOME || credential.serverUrl || (spec && !ADMIN_USER)) return null;
      const key = crypto.createHash('sha256').update(credential.accessToken).digest('hex');
      let entry = adminChecks.get(key);
      if (!entry || entry.expires <= Date.now()) {
        const me = await api(`/Users/${credential.userId}`, { credential });
        const allowed = ADMIN_USER
          ? String(me?.Id).toLowerCase() === ADMIN_USER.id && String(me?.Name).toLowerCase() === ADMIN_USER.name
          : me?.Policy?.IsAdministrator === true;
        entry = { admin: me?.Id === credential.userId && allowed, expires: Date.now() + 60_000 };
        if (adminChecks.size >= 1000) adminChecks.delete(adminChecks.keys().next().value);
        adminChecks.set(key, entry);
      }
      return entry.admin ? { id: `emby:${credential.serverId}:${credential.userId}`, name: credential.name } : null;
    },
    getSessionAccountKey: async req => {
      const credential = getSession(req)?.credential;
      return credential ? accountKeyOf(credential) : null;
    },
    clearSession(req, res) {
      revoke(getSession(req)?.credential);
      res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(res));
    },
    async signOutEverywhere(req, res) {
      const credential = credentialFor(req);
      await signoutGenerations.update(generationKey(credential), value => (Number.isSafeInteger(value) ? value : 0) + 1);
      auth.clearSession(req, res);
    },
  };

  // ---- Sign-in routes -----------------------------------------------------

  // The sign-in page itself is public/emby-sign-in.html, linked from the login page.
  function registerRoutes(app, { rateLimit }) {
    app.use(['/api/auth/emby/start', '/api/auth/emby/password'], rateLimit({ maximum: 10, windowMs: 600000 }));

    // The server a sign-in is for: the configured one, or (with the embyServers plugin)
    // the address the user typed, as the plugin allows.
    async function signInServer(address) {
      if (!address || !tenantServers) {
        if (!HOME) throw Object.assign(new Error("Enter your Emby server's https:// address."), { status: 400 });
        return { server: HOME, info: await serverInfo() };
      }
      let url;
      try {
        url = normalizeServerUrl(await tenantServers.resolve(address));
      } catch (error) {
        throw Object.assign(new Error(typeof error?.message === 'string' ? error.message.slice(0, 200) : 'That server address is not allowed.'), { status: 400 });
      }
      const server = serverAt(url);
      if (server.home) return { server, info: await serverInfo() };
      try {
        return { server, info: await readServerInfo(server) };
      } catch (error) {
        // The plugin's fetch may explain a failure it can diagnose (such as an untrusted
        // certificate) in error.userMessage, written for the user.
        const message = typeof error?.userMessage === 'string' ? error.userMessage.slice(0, 200) : 'Could not reach an Emby server at that address.';
        throw Object.assign(new Error(message), { status: 400 });
      }
    }
    // The sign-in in progress, from its cookie; null if expired or its server is gone.
    function pendingSignIn(req) {
      const state = loginState(req);
      const server = state && serverAt(state.serverUrl);
      if (!state || !server || !HEX_ID.test(state.serverId || '')) return null;
      return { state, server, info: { id: state.serverId, name: state.serverName } };
    }

    // Step one: which server. With none typed, the configured server.
    app.post('/api/auth/emby/start', async (req, res) => {
      try {
        const address = typeof req.body?.server === 'string' ? req.body.server.trim().slice(0, 2048) : '';
        const { server, info } = await signInServer(address);
        // What they typed is kept to show and share later: the stored URL may not be typeable.
        setLoginCookie(res, { deviceId: crypto.randomUUID(), serverId: info.id, serverName: info.name, ...(server.home ? {} : { serverUrl: server.url, serverAddress: address.slice(0, 200) }) });
        res.json({ serverName: info.name });
      } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        res.status(502).json({ error: 'Could not reach the Emby server.' });
      }
    });

    app.post('/api/auth/emby/password', async (req, res) => {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || username.length > 256 || typeof password !== 'string' || password.length > 1024) {
        return res.status(400).json({ error: 'Enter your Emby username and password.' });
      }
      try {
        // The server chosen in step one, or the configured one.
        // Without a cookie for the server chosen in step one, only an install that has no way to reach other servers
        // may assume its own: a user's password must never go to a server they did not choose.
        const pending = pendingSignIn(req) ?? (HOME && !tenantServers ? { state: { deviceId: crypto.randomUUID() }, server: HOME, info: await serverInfo() } : null);
        if (!pending) return res.status(400).json({ error: 'Sign-in expired; start again.' });
        const { state, server, info } = pending;
        const result = await api('/Users/AuthenticateByName', { server, method: 'POST', deviceId: state.deviceId, body: { Username: username.trim(), Pw: password } });
        await startSession(res, result, { deviceId: state.deviceId, server, info, address: state.serverAddress });
        res.json({ authenticated: true });
      } catch (err) {
        if (err.status === 401) return res.status(401).json({ error: 'Incorrect username or password.' });
        res.status(502).json({ error: 'Could not sign in to the Emby server.' });
      }
    });
  }

  // ---- Library ------------------------------------------------------------

  const ITEM_FIELDS = 'ProductionYear,Overview,Genres,ChildCount,RecursiveItemCount,ParentId,PrimaryImageAspectRatio';

  function thumbnailUrl(item, imageType, preset) {
    const itemId = imageType === 'Backdrop' && !item.BackdropImageTags?.length ? item.ParentBackdropItemId : item.Id;
    const hasImage = imageType === 'Backdrop' ? !!itemId : item.ImageTags?.[imageType];
    if (!hasImage || !ITEM_ID.test(String(itemId ?? ''))) return null;
    const { width, height } = THUMBNAIL_PRESETS[preset];
    return `/api/library/thumb?${new URLSearchParams({ path: `${itemId}/${imageType}`, width: String(width), height: String(height) })}`;
  }

  const TYPES = { Movie: 'movie', Series: 'show', Season: 'season', Episode: 'episode' };
  const typeOf = item => TYPES[item.Type] || String(item.Type || '').toLowerCase();
  const viewOffset = item => ms(item.UserData?.PlaybackPositionTicks) || 0;
  // Plex's field: times watched, 0 for unwatched. Played is what marking watched sets.
  const viewCount = item => (item.UserData?.Played ? Math.max(1, item.UserData.PlayCount || 0) : 0);
  function episodeCounts(item) {
    const leafCount = item.RecursiveItemCount ?? item.ChildCount;
    if (!Number.isFinite(leafCount)) return {};
    const unplayed = item.UserData?.UnplayedItemCount;
    return { leafCount, viewedLeafCount: Number.isFinite(unplayed) ? Math.max(0, leafCount - unplayed) : 0 };
  }

  function mapListItem(item) {
    const type = typeOf(item);
    return {
      ratingKey: String(item.Id),
      title: item.Name,
      year: item.ProductionYear,
      type,
      thumbnail: thumbnailUrl(item, 'Primary', 'poster'),
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      childCount: item.ChildCount,
      ...(type === 'show' ? episodeCounts(item) : { viewedLeafCount: 0 }),
    };
  }

  function mapHubItem(item, librarySectionId = null) {
    const type = typeOf(item);
    const episode = type === 'episode';
    return {
      ratingKey: String(item.Id),
      type,
      librarySectionId,
      title: item.Name,
      year: item.ProductionYear,
      season: episode ? item.ParentIndexNumber : undefined,
      episode: episode ? item.IndexNumber : undefined,
      showTitle: episode || type === 'season' ? item.SeriesName : undefined,
      showRatingKey: type === 'season' ? String(item.SeriesId) : undefined,
      thumbnail: episode ? thumbnailUrl(item, 'Primary', 'landscape') : thumbnailUrl(item, 'Primary', 'poster'),
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      ...episodeCounts(item),
    };
  }

  function mapEpisode(item) {
    return {
      ratingKey: String(item.Id),
      title: item.Name,
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      viewCount: viewCount(item),
      thumbnail: thumbnailUrl(item, 'Primary', 'landscape'),
    };
  }

  // Plex-style sort values from the pages, mapped to Emby's.
  function sortParams(sort) {
    const [field, direction] = String(sort || 'addedAt:desc').split(':');
    const by = { titleSort: 'SortName', addedAt: 'DateCreated', year: 'ProductionYear', title: 'SortName' }[field] || 'SortName';
    return { SortBy: by, SortOrder: direction === 'desc' ? 'Descending' : 'Ascending' };
  }

  const query = values => new URLSearchParams(values).toString();

  async function libraries(credential) {
    const views = await api(`/Users/${credential.userId}/Views`, { credential });
    return (views.Items || [])
      .filter(view => view.CollectionType === 'movies' || view.CollectionType === 'tvshows')
      .map(view => ({ id: String(view.Id), title: view.Name, type: view.CollectionType === 'movies' ? 'movie' : 'show' }));
  }

  // An item's subtitle streams and the media source they belong to.
  async function subtitleStreams(credential, itemId) {
    const item = await api(`/Users/${credential.userId}/Items/${itemId}`, { credential });
    const source = item?.MediaSources?.[0];
    return {
      sourceId: String(source?.Id || ''),
      streams: (source?.MediaStreams || []).filter(stream => stream.Type === 'Subtitle' && Number.isInteger(stream.Index) && TRACK_ID.test(String(stream.Index))),
    };
  }

  function library(req) {
    const credential = credentialFor(req);
    const userItems = values => api(`/Users/${credential.userId}/Items?${query(values)}`, { credential });
    return {
      libraries: () => libraries(credential),
      async libraryItems(libraryId, { sort } = {}) {
        const data = await userItems({ ParentId: libraryId, Recursive: 'true', IncludeItemTypes: 'Movie,Series', Fields: ITEM_FIELDS, ...sortParams(sort) });
        return { total: data.TotalRecordCount, items: (data.Items || []).map(mapListItem) };
      },
      async recentlyAdded(libraryId) {
        const latest = await api(`/Users/${credential.userId}/Items/Latest?${query({ ParentId: libraryId, Limit: '12', Fields: ITEM_FIELDS, GroupItems: 'true' })}`, { credential });
        return (Array.isArray(latest) ? latest : []).map(item => mapHubItem(item, libraryId));
      },
      async showSeasons(showId) {
        const data = await api(`/Shows/${showId}/Seasons?${query({ UserId: credential.userId, Fields: ITEM_FIELDS })}`, { credential });
        return (data.Items || []).map(season => ({
          ratingKey: String(season.Id),
          type: 'season',
          title: season.Name,
          index: season.IndexNumber,
          showRatingKey: String(season.SeriesId),
          showTitle: season.SeriesName,
          thumbnail: thumbnailUrl(season, 'Primary', 'poster'),
          ...episodeCounts(season),
        }));
      },
      async showEpisodes(showId) {
        const data = await api(`/Shows/${showId}/Episodes?${query({ UserId: credential.userId, Fields: ITEM_FIELDS })}`, { credential });
        return (data.Items || []).map(mapEpisode);
      },
      async seasonEpisodes(seasonId) {
        const data = await userItems({ ParentId: seasonId, IncludeItemTypes: 'Episode', SortBy: 'ParentIndexNumber,IndexNumber', Fields: ITEM_FIELDS });
        return (data.Items || []).map(mapEpisode);
      },
      async itemDetails(itemId) {
        const item = await api(`/Users/${credential.userId}/Items/${itemId}`, { credential });
        const video = item.MediaSources?.[0]?.MediaStreams?.find(stream => stream.Type === 'Video');
        return {
          ratingKey: String(item.Id),
          type: typeOf(item),
          librarySectionId: null,
          title: item.Name,
          showTitle: item.SeriesName || null,
          parentKey: item.SeasonId ? String(item.SeasonId) : null,
          grandparentKey: item.SeriesId ? String(item.SeriesId) : null,
          season: item.ParentIndexNumber,
          episode: item.IndexNumber,
          year: item.ProductionYear,
          summary: item.Overview || '',
          contentRating: item.OfficialRating || null,
          audienceRating: item.CommunityRating ?? null,
          genres: item.Genres || [],
          duration: minutes(item.RunTimeTicks),
          durationMs: ms(item.RunTimeTicks),
          viewOffset: viewOffset(item),
          thumbnail: thumbnailUrl(item, 'Primary', 'poster'),
          backdrop: thumbnailUrl(item, 'Backdrop', 'backdrop'),
          videoCodec: video?.Codec,
          resolution: video ? `${video.Width}x${video.Height}` : null,
        };
      },
      // The item's subtitle streams: text ones Emby can convert are `text`, the rest
      // (picture subtitles such as PGS) can only be drawn into the video.
      async subtitleTracks(itemId) {
        return orderTracks((await subtitleStreams(credential, itemId)).streams.map(stream => describeTrack({
          id: stream.Index,
          label: stream.DisplayTitle || stream.Title || stream.Language,
          language: stream.Language,
          kind: stream.IsTextSubtitleStream ? 'text' : 'burn',
          forced: stream.IsForced,
          isDefault: stream.IsDefault,
        })));
      },
      // One of those text tracks as WebVTT. Emby extracts it from the file on first use,
      // which can take a while for a large file; it is quick afterwards.
      async subtitleText(itemId, trackId) {
        const { streams, sourceId } = await subtitleStreams(credential, itemId);
        const stream = streams.find(candidate => String(candidate.Index) === String(trackId));
        if (!stream?.IsTextSubtitleStream || !/^[A-Za-z0-9_-]{1,64}$/.test(sourceId)) return null;
        const response = await request(`/Videos/${itemId}/${sourceId}/Subtitles/${Number(stream.Index)}/Stream.srt`, { credential, timeoutMs: 120000 });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Emby subtitle ${response.status}`); }
        return toWebVtt(await readSubtitleText(response));
      },
      async search(text) {
        const data = await userItems({ SearchTerm: text, Recursive: 'true', IncludeItemTypes: 'Movie,Series,Episode', Limit: '30', Fields: ITEM_FIELDS });
        return (data.Items || []).map(item => ({
          ratingKey: String(item.Id), title: item.Name, year: item.ProductionYear, type: typeOf(item),
          thumbnail: thumbnailUrl(item, 'Primary', 'poster'),
        }));
      },
      // Per library, so the page can show each library's own row: in-progress items
      // first, then the next episode of shows being watched.
      async continueWatching() {
        const results = [];
        const seen = new Set();
        for (const view of await libraries(credential)) {
          try {
            const [resume, nextUp] = await Promise.all([
              api(`/Users/${credential.userId}/Items/Resume?${query({ ParentId: view.id, Limit: '12', MediaTypes: 'Video', Fields: ITEM_FIELDS })}`, { credential }),
              view.type === 'show'
                ? api(`/Shows/NextUp?${query({ UserId: credential.userId, ParentId: view.id, Limit: '12', Fields: ITEM_FIELDS })}`, { credential })
                : { Items: [] },
            ]);
            for (const item of [...(resume.Items || []), ...(nextUp.Items || [])]) {
              if (seen.has(item.Id)) continue;
              seen.add(item.Id);
              results.push(mapHubItem(item, view.id));
            }
          } catch {
            // One library failing shouldn't hide the others.
          }
        }
        return results;
      },
    };
  }

  async function sendThumbnail(req, res) {
    const [itemId, imageType] = String(req.query.path || '').split('/');
    const width = Number(req.query.width || 300);
    const height = Number(req.query.height || 450);
    if (!ITEM_ID.test(itemId || '') || !IMAGE_TYPES.has(imageType)
      || ![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2048)) return res.status(400).end();
    try {
      const credential = credentialFor(req);
      const server = serverOf(credential);
      const params = new URLSearchParams({ maxWidth: String(width), maxHeight: String(height), quality: '85' });
      const upstream = await server.fetch(`${server.url}/Items/${itemId}/Images/${imageType}?${params}`, {
        headers: headers({ deviceId: credential.deviceId, token: credential.accessToken }),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      const type = upstream.headers.get('content-type')?.split(';')[0];
      if (!upstream.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(type)) {
        await upstream.body?.cancel();
        return res.status(upstream.ok ? 502 : upstream.status).end();
      }
      res.status(200);
      res.set('Content-Type', type);
      res.set('Cache-Control', 'private, max-age=3600');
      // The address does not say whose picture it is, so the browser keeps one copy per session cookie: signing in as
      // someone else in the same browser asks again instead of being handed the last person's.
      res.vary('Cookie');
      if (upstream.body) pipeUpstream(upstream, res);
      else res.end();
    } catch {
      res.status(502).end();
    }
  }

  // ---- Playback -----------------------------------------------------------

  // What the MCU2 (and Ultra) can decode: 8-bit H.264 within the tier's size and
  // frame rate, stereo AAC, in TS segments.
  function deviceProfile(quality, tier, maxBitrate) {
    const settings = QUALITY_TIERS[quality];
    const [width, height] = tier.videoResolution.split('x');
    return {
      Name: PRODUCT_NAME,
      MaxStreamingBitrate: maxBitrate,
      MaxStaticBitrate: maxBitrate,
      DirectPlayProfiles: [],
      TranscodingProfiles: [{
        Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls',
        Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: false,
      }],
      CodecProfiles: [{
        Type: 'Video', Codec: 'h264', Conditions: [
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8' },
          { Condition: 'LessThanEqual', Property: 'VideoFramerate', Value: String(settings.fps) },
          { Condition: 'LessThanEqual', Property: 'Width', Value: width },
          { Condition: 'LessThanEqual', Property: 'Height', Value: height },
        ],
      }],
      SubtitleProfiles: [],
    };
  }

  // Rewrite an Emby playlist so every URI goes through /proxy/ and no token ever
  // reaches the browser. Emby's playlists use relative URIs.
  function rewritePlaylist(text, playlistUrl, playSessionId, server) {
    const serverUrl = new URL(server.url);
    const serverPath = serverUrl.pathname.replace(/\/$/, '');
    const rewrite = value => {
      const url = new URL(value, playlistUrl);
      const path = url.pathname.slice(serverPath.length).replace(/^\//, '');
      if (url.protocol !== serverUrl.protocol || url.host !== serverUrl.host || !url.pathname.startsWith(serverPath)
        || !MEDIA_PATH.test(path) || url.searchParams.get('PlaySessionId') !== playSessionId) {
        throw new Error('Unexpected Emby media URI');
      }
      for (const key of [...url.searchParams.keys()]) if (/^api_?key$/i.test(key)) url.searchParams.delete(key);
      return `/proxy/${path}?${url.searchParams}`;
    };
    return text.split('\n').map(line => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
      return rewrite(line.trim());
    }).join('\n');
  }

  // Emby needs the play session ID on every progress report, but the page only sends the
  // item. Remember the session each viewer's stream for an item was started with.
  const plays = new Map(); // one entry per viewer session, server, user and item
  const playKey = (req, credential, itemId) => JSON.stringify([getSession(req)?.sessionId, accountKeyOf(credential), credential.userId, itemId]);
  function rememberPlay(req, credential, itemId, play) {
    const key = playKey(req, credential, itemId);
    plays.delete(key);
    plays.set(key, play);
    if (plays.size > 500) plays.delete(plays.keys().next().value);
  }

  async function startStream(req, res, { itemId, state, stopState }) {
    const credential = credentialFor(req);
    const server = serverOf(credential);
    // A capped server never streams Ultra (1080p, 60 fps), so it stays at 720p or below,
    // with video and audio together under the cap.
    const capKbps = server.maxBitrateKbps;
    const asked = QUALITY_LEVELS.includes(req.query.quality) ? req.query.quality : 'high';
    const quality = capKbps && asked === 'ultra' ? 'high' : normalizeQuality(asked);
    const tier = { ...qualityTiers(config.plex.videoBitrate)[quality] };
    if (capKbps && capKbps < 300 + AUDIO_BITRATE / 1000) throw new Error('Emby server bitrate cap is too low for playback');
    if (capKbps) tier.videoBitrate = Math.max(300, Math.min(tier.videoBitrate, capKbps - AUDIO_BITRATE / 1000));
    const videoBitrate = tier.videoBitrate * 1000;
    // A chosen subtitle track is drawn into the picture; with none chosen nothing is.
    const subtitle = typeof req.query.subtitle === 'string' && TRACK_ID.test(req.query.subtitle) ? req.query.subtitle : null;
    // Asking for index -1 here keeps Emby from picking a default track to burn in.
    const params = query({
      UserId: credential.userId, MaxStreamingBitrate: String(videoBitrate + AUDIO_BITRATE), EnableDirectPlay: 'false',
      EnableDirectStream: 'false', EnableTranscoding: 'true', AutoOpenLiveStream: 'false', StartTimeTicks: '0',
      SubtitleStreamIndex: subtitle ?? '-1',
    });
    const info = await api(`/Items/${itemId}/PlaybackInfo?${params}`, {
      credential, method: 'POST', timeoutMs: 15000,
      body: { DeviceProfile: deviceProfile(quality, tier, videoBitrate + AUDIO_BITRATE) },
    });
    const source = info?.MediaSources?.[0];
    const playSessionId = info?.PlaySessionId;
    if (!source?.TranscodingUrl || !HEX_ID.test(playSessionId || '')) {
      res.status(502).send('This item cannot be streamed');
      return;
    }

    // Emby gives a path from its root ("/videos/..."). Keep the server address's own
    // path, rather than letting the leading slash replace it.
    const serverPath = new URL(server.url).pathname.replace(/^\/+|\/+$/g, '');
    let transcodingPath = source.TranscodingUrl.replace(/^\/+/, '');
    if (serverPath && transcodingPath.startsWith(`${serverPath}/`)) transcodingPath = transcodingPath.slice(serverPath.length + 1);
    const master = new URL(transcodingPath, `${server.url}/`);
    for (const key of [...master.searchParams.keys()]) if (/^api_?key$/i.test(key)) master.searchParams.delete(key);
    master.searchParams.set('DeviceId', credential.deviceId);
    master.searchParams.set('VideoBitrate', String(videoBitrate));
    master.searchParams.set('AudioBitrate', String(AUDIO_BITRATE));
    // Emby burns subtitles in whenever the playlist asks for any subtitle index, even
    // -1, so only a chosen track that cannot be shown as text names one.
    master.searchParams.delete('SubtitleStreamIndex');
    master.searchParams.delete('SubtitleMethod');
    if (subtitle) {
      master.searchParams.set('SubtitleStreamIndex', subtitle);
      master.searchParams.set('SubtitleMethod', 'Encode');
    }

    state.active = { source: id, sessionId: playSessionId, itemId, accessToken: credential.accessToken, deviceId: credential.deviceId, serverUrl: credential.serverUrl };
    rememberPlay(req, credential, itemId, { playSessionId, mediaSourceId: String(source.Id || '') });
    // Shows up as "now playing" in Emby; progress reports follow from the player.
    request('/Sessions/Playing', { credential, method: 'POST', body: { ItemId: itemId, MediaSourceId: source.Id, PlaySessionId: playSessionId, PlayMethod: 'Transcode', CanSeek: true } })
      .then(response => response.body?.cancel(), () => {});

    const upstream = await server.fetch(master, {
      headers: headers({ deviceId: credential.deviceId, token: credential.accessToken }),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      console.error('Emby master playlist failed', upstream.status);
      await stopState(state);
      res.status(upstream.status).send('Emby playback request failed');
      return;
    }
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewritePlaylist(await readBodyText(upstream, PLAYLIST_LIMIT), master, playSessionId, server));
  }

  async function proxyMedia(req, res, { ownsSession }) {
    try {
      const credential = credentialFor(req);
      const path = req.params[0];
      const params = new URL(req.originalUrl, 'http://local').searchParams;
      const playSessionId = params.get('PlaySessionId');
      if (!MEDIA_PATH.test(path) || /[%\\]/.test(path) || ![...params.keys()].every(key => !/^api_?key$/i.test(key))
        || !HEX_ID.test(playSessionId || '') || !ownsSession(playSessionId)) return res.status(403).end();
      params.set('DeviceId', credential.deviceId);
      const server = serverOf(credential);
      const upstreamUrl = `${server.url}/${path}?${params}`;
      const upstream = await server.fetch(upstreamUrl, {
        headers: headers({ deviceId: credential.deviceId, token: credential.accessToken }),
        redirect: 'error',
        // Emby answers once the segment is encoded; a seek can take a few seconds.
        signal: AbortSignal.timeout(30000),
      });
      const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
      if (!upstream.ok) { await upstream.body?.cancel(); return res.status(upstream.status).end(); }
      if (!/^(video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|octet-stream))/.test(contentType)) { await upstream.body?.cancel(); return res.status(502).end(); }
      if (contentType.includes('mpegurl')) {
        res.set('Content-Type', contentType);
        res.send(rewritePlaylist(await readBodyText(upstream, PLAYLIST_LIMIT), new URL(upstreamUrl), playSessionId, server));
        return;
      }
      res.status(200);
      res.set('Content-Type', contentType);
      if (upstream.body) pipeUpstream(upstream, res);
      else res.end();
    } catch (err) {
      console.error('Emby request failed');
      if (res.headersSent) return;
      if (isTimeout(err)) return sendMediaServerSlow(res);
      res.status(err.message === 'Not authenticated' ? 401 : 502).end();
    }
  }

  async function stopStream(active) {
    if (!active?.sessionId) return;
    const params = new URLSearchParams({ DeviceId: active.deviceId, PlaySessionId: active.sessionId });
    try {
      const response = await request(`/Videos/ActiveEncodings?${params}`, {
        credential: { accessToken: active.accessToken, deviceId: active.deviceId, serverUrl: active.serverUrl }, method: 'DELETE', timeoutMs: 5000,
      });
      await response.body?.cancel();
    } catch {
      console.error('Failed to stop Emby transcode');
    }
  }

  // ---- Watch state --------------------------------------------------------

  async function reportProgress(req, { itemId, timeMs, state }) {
    const credential = credentialFor(req);
    // After a restart there is no remembered session; Emby accepts any ID, as long as there is one.
    const play = plays.get(playKey(req, credential, itemId)) ?? { playSessionId: crypto.randomBytes(16).toString('hex'), mediaSourceId: '' };
    const body = {
      ItemId: itemId, PositionTicks: Math.floor(timeMs) * TICKS_PER_MS, PlayMethod: 'Transcode', PlaySessionId: play.playSessionId,
      ...(play.mediaSourceId ? { MediaSourceId: play.mediaSourceId } : {}),
    };
    // Emby marks the item played on stop when it's past its threshold.
    if (state === 'stopped') await api('/Sessions/Playing/Stopped', { credential, method: 'POST', body });
    else await api('/Sessions/Playing/Progress', { credential, method: 'POST', body: { ...body, IsPaused: state === 'paused' } });
  }

  const watchState = {
    reportProgress,
    async markWatched(req, itemId) {
      const credential = credentialFor(req);
      await api(`/Users/${credential.userId}/PlayedItems/${itemId}`, { credential, method: 'POST' });
    },
    async markUnwatched(req, itemId) {
      const credential = credentialFor(req);
      await api(`/Users/${credential.userId}/PlayedItems/${itemId}`, { credential, method: 'DELETE' });
    },
  };

  // ---- Accounts -----------------------------------------------------------

  // Each server is one account for limits, named after the server: the configured one,
  // plus users' own servers that have signed in.
  async function serverAccounts() {
    const accounts = [];
    try {
      const info = await serverInfo();
      accounts.push({ key: `emby:${info.id}`, label: info.name, detail: 'Emby server' });
    } catch { /* the configured server is unreachable; others are still listed */ }
    for (const [key, entry] of tenantDirectory ? await tenantDirectory.entries() : []) {
      accounts.push({ key, label: entry.name, detail: `Emby server at ${entry.address}` });
    }
    return accounts;
  }
  const accounts = {
    list: serverAccounts,
    async search(text) {
      const value = text.trim().toLowerCase();
      return (await serverAccounts()).filter(account => [account.label, account.key, account.detail, 'emby']
        .some(field => field.toLowerCase().includes(value)));
    },
    async describe(key) {
      if (!key.startsWith('emby:')) return null;
      return (await serverAccounts()).find(account => account.key === key) || null;
    },
  };

  return {
    id,
    type: 'emby',
    name: 'Emby',
    isValidId: value => typeof value === 'string' && ITEM_ID.test(value),
    // The login page links to this page (served from public/) to sign in.
    // With an embyServers plugin the sign-in page first asks which server; the plugin may
    // word that question (prompt: { hint, label, placeholder }).
    signInOptions: {
      signInPage: '/emby-sign-in', signInLabel: 'Sign in with Emby',
      askServer: !!tenantServers, serverRequired: !HOME,
      ...(serverPrompt(tenantServers?.prompt) ? { serverPrompt: serverPrompt(tenantServers.prompt) } : {}),
    },
    auth,
    accounts,
    registerRoutes,
    library,
    sendThumbnail,
    watchState,
    playback: {
      start: startStream,
      proxy: proxyMedia,
      stop: stopStream,
      directCapable: () => false,
      mediaOrigin: () => '',
    },
  };
}
