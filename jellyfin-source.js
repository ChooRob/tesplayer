// Jellyfin as a media source: Quick Connect (or password) sign-in, library
// browsing, HLS playback through Jellyfin's transcoder, and watch state.
// It produces the same item shapes as the Plex source, so the pages don't
// care which backend they're showing.

import crypto from 'node:crypto';
import { QUALITY_TIERS, QUALITY_LEVELS, normalizeQuality, qualityTiers } from './public/engine/quality-tiers.js';
import { parseCookies, safeError, readBodyText } from './security.js';
import { createCookieSealer, packSession, unpackSession, SESSION_COOKIE_NAME } from './session-cookie.js';
import { adminSpec, adminConfigured } from './admin-auth.js';
import { describeTrack, orderTracks, toWebVtt, readSubtitleText, TRACK_ID } from './subtitles.js';
import { isTimeout, sendMediaServerSlow } from './media-server-wait.js';

const LOGIN_COOKIE_NAME = 'freeStuffCrazyPlayerJellyfinLogin';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
const TICKS_PER_MS = 10_000;
// The most read from a media server's reply: a sign-in step (anyone can start one, and the
// server may be one a visitor typed), a library answer, and a playlist.
const SIGN_IN_JSON_LIMIT = 256 * 1024;
const API_JSON_LIMIT = 32 * 1024 * 1024;
const PLAYLIST_LIMIT = 4 * 1024 * 1024;
const AUDIO_BITRATE = 128_000;
// Music is transcoded at a higher rate than the sound of a film.
const MUSIC_BITRATE = 256_000;
// The older car screen's sound output needs 48 kHz; see `rate` below.
const MUSIC_SAMPLE_RATE = '48000';
const ID = /^[0-9a-f]{32}$/;
// Media paths a viewer may fetch through /proxy/, relative to the server.
// The thumbnails shown when scrubbing (Trickplay) are listed in the master playlist as image streams. The player has
// no use for them, they are not media this proxy serves, and their playlists carry no play session, so they are
// dropped rather than let through: everything else in a playlist must still be one of the media paths below.
const TRICKPLAY_TAG = /^#EXT-X-IMAGE-STREAM-INF\b/;
const MEDIA_PATH = /^(?:videos|audio)\/[0-9a-f-]{32,36}\/(?:master\.m3u8|main\.m3u8|hls1\/[A-Za-z0-9_-]{1,64}\/\d{1,7}\.(?:ts|mp4|m4s|aac))$/i;
const IMAGE_TYPES = new Set(['Primary', 'Backdrop', 'Thumb']);
const THUMBNAIL_PRESETS = {
  landscape: { width: 600, height: 338 },
  poster: { width: 390, height: 585 },
  backdrop: { width: 1280, height: 720 },
  // Music artwork is square.
  square: { width: 400, height: 400 },
  cover: { width: 640, height: 640 },
  tiny: { width: 160, height: 160 },
};
const PUBLIC_PATHS = new Set(['/api/auth/jellyfin/start', '/api/auth/jellyfin/poll', '/api/auth/jellyfin/password']);

const quote = value => String(value).replace(/["\\\r\n]/g, '');
const ms = ticks => (Number.isFinite(ticks) ? Math.round(ticks / TICKS_PER_MS) : null);
const minutes = ticks => (Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 600_000_000) : null);

// Scheme, host and path, without a trailing slash. Not url.origin: a
// jellyfinServers plugin may name servers with its own scheme (whose origin
// is the opaque "null"), and only its fetch knows how to reach them.
const normalizeServerUrl = value => {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
};

// JELLYFIN_URL is the server's address: http(s), a host, an optional port and
// path prefix, and nothing else. The message never repeats the value, which
// may be shown on the login page and could hold credentials.
export const JELLYFIN_URL_FORMAT = 'JELLYFIN_URL must be the Jellyfin server\'s address, such as http://192.168.1.50:8096 or https://jellyfin.example.com.';
export function parseJellyfinUrl(value) {
  let url = null;
  try { url = new URL(String(value).trim()); } catch { /* reported below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname
    || url.username || url.password || url.search || url.hash) throw new Error(JELLYFIN_URL_FORMAT);
  return normalizeServerUrl(url);
}

// A jellyfinServers plugin's wording for the server question on the login
// page: short plain strings only, or null to keep the page's own.
// A link the login page offers when the typed address does not work, such as to a
// plugin that connects servers that are not on the internet. Plain https only.
function promptHelp(help) {
  if (!help || typeof help !== 'object') return undefined;
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
  let url;
  try {
    const parsed = new URL(String(help.url ?? ''));
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.href.length <= 300) url = parsed.href;
  } catch { /* not an address */ }
  const result = { text: text(help.text, 200), label: text(help.label, 60), url };
  return result.text && result.label && result.url ? result : undefined;
}

export function serverPrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
  const result = { hint: text(prompt.hint, 200), label: text(prompt.label, 40), placeholder: text(prompt.placeholder, 60), help: promptHelp(prompt.help) };
  return Object.values(result).some(Boolean) ? result : null;
}

// The plugin that lets users sign in to their own Jellyfin servers, if any.
export const tenantServersOf = plugins => plugins.find(plugin => typeof plugin.jellyfinServers?.resolve === 'function'
  && typeof plugin.jellyfinServers?.fetch === 'function')?.jellyfinServers || null;

// The configured JELLYFIN_URL is the only server core talks to. A plugin may
// export `jellyfinServers` to let users sign in to servers they choose:
// resolve(address) -> the server URL to use, or throws with
// a message for the user; fetch(url, init) makes every request to such a
// server, so the plugin decides which addresses may be reached. When fetch
// fails for a reason the user can fix (an untrusted certificate, say), it may
// set error.userMessage, which the login page shows (up to 200 characters);
// other failures show a generic message. An optional maxBitrate(url) returns
// a kbps cap for a server's streams, or null; an optional displayAddress(url)
// returns what to type to sign in to that server, when the URL itself isn't it.
// With that plugin JELLYFIN_URL is
// optional; without one, every user must give theirs.
export async function createJellyfinSource({ id = 'jellyfin', config, plugins = [], store, pipeUpstream, env = process.env, fetchImpl = (...args) => fetch(...args), signedIn = null }) {
  const tenantServers = tenantServersOf(plugins);
  if (!env.JELLYFIN_URL && !tenantServers) throw new Error('Missing JELLYFIN_URL in environment');
  let baseUrl = null;
  if (env.JELLYFIN_URL) baseUrl = parseJellyfinUrl(env.JELLYFIN_URL);
  // home: the configured server, if there is one. Others are users' own
  // servers, reached only through the jellyfinServers plugin.
  const HOME = baseUrl ? { url: baseUrl, fetch: fetchImpl, home: true } : null;
  function serverAt(url) {
    if (!url || url === baseUrl) return HOME;
    if (!tenantServers) return null;
    // The plugin may cap a server's stream bitrate (kbps), for one it
    // reaches over a slow link.
    const cap = Number(tenantServers.maxBitrate?.(url));
    return { url, fetch: (...args) => tenantServers.fetch(...args), home: false, maxBitrateKbps: Number.isFinite(cap) && cap > 0 ? cap : null };
  }
  const serverOf = credential => serverAt(credential.serverUrl);
  const PRODUCT_NAME = config.plex.productName || 'FreeStuffCrazy Player';
  const SESSION_MAX_AGE_MS = config.auth.sessionDays * 24 * 60 * 60 * 1000;
  const sealer = createCookieSealer(env.SESSION_SECRET);
  // FREESTUFFCRAZY_ADMIN=jellyfin:<user ID>:<username> names the one Jellyfin admin.
  // Both must match: the ID makes it unique, the name keeps it readable.
  const spec = adminSpec(env);
  let ADMIN_USER = null;
  if (spec?.type === 'jellyfin') {
    const match = /^([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/.exec(spec.who);
    if (match) ADMIN_USER = { id: match[1].replaceAll('-', ''), name: match[2].trim() };
    else console.warn('FREESTUFFCRAZY_ADMIN for Jellyfin must be jellyfin:<user ID>:<username>; no Jellyfin admin is set.');
  }
  const signoutGenerations = store.collection('signout-generations');

  // ---- Talking to Jellyfin ----------------------------------------------

  // Jellyfin identifies the client in one Authorization header; the device
  // ID is fixed per sign-in, so each signed-in browser is its own device.
  function authorization({ deviceId, token } = {}) {
    let value = `MediaBrowser Client="${quote(PRODUCT_NAME)}", Device="${quote(PRODUCT_NAME)}", DeviceId="${quote(deviceId || 'freestuffcrazy-player-server')}", Version="1.0"`;
    if (token) value += `, Token="${quote(token)}"`;
    return value;
  }

  async function request(path, { credential, server, method = 'GET', body, timeoutMs = 10000, deviceId } = {}) {
    const target = server ?? (credential ? serverOf(credential) : HOME);
    if (!target) throw new Error('Jellyfin server is not available');
    const response = await target.fetch(`${target.url}${path}`, {
      method,
      headers: {
        Authorization: authorization({ deviceId: credential?.deviceId ?? deviceId, token: credential?.accessToken }),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  async function api(path, options) {
    const response = await request(path, options);
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Jellyfin API ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    // Without a credential this is a sign-in step, open to anyone and possibly aimed at a
    // server the visitor typed, so it gets a small limit; the answers are a few kilobytes.
    const text = await readBodyText(response, options?.credential ? API_JSON_LIMIT : SIGN_IN_JSON_LIMIT);
    return text ? JSON.parse(text) : null;
  }

  // A server's own ID and name. The configured server's is fetched lazily
  // and kept, so a Jellyfin server that is briefly down doesn't stop
  // the player from starting.
  async function readServerInfo(server) {
    const info = await api('/System/Info/Public', { server });
    if (!ID.test(info?.Id || '')) throw new Error('That address is not a Jellyfin server');
    const name = typeof info.ServerName === 'string' && info.ServerName.trim() ? info.ServerName.trim().slice(0, 80) : 'Jellyfin';
    return { id: info.Id, name: server.home ? (env.JELLYFIN_NAME || name) : name };
  }
  let serverInfoPromise = null;
  // The configured server's name once known, for showing who's signed in where.
  let homeServerName = null;

  // Which server a session is on, as shown to its user: its name, and what to
  // type to sign in to it again (none for the configured server, which needs
  // nothing typed). Older sessions without the typed address fall back to an
  // https address.
  function serverSummary(credential) {
    const name = credential.serverName || (credential.serverUrl ? null : homeServerName) || null;
    const address = credential.serverAddress || (/^https:\/\//.test(credential.serverUrl || '') ? credential.serverUrl : null);
    return { name, address: credential.serverUrl ? address : null };
  }
  function serverInfo() {
    if (!HOME) return Promise.reject(new Error('No Jellyfin server is configured'));
    serverInfoPromise ??= readServerInfo(HOME).then(info => { homeServerName = info.name; return info; }, error => { serverInfoPromise = null; throw error; });
    return serverInfoPromise;
  }
  if (!HOME) {
    console.log('Jellyfin: no server configured; users sign in to their own servers');
  } else {
    try {
      const info = await serverInfo();
      console.log(`Using Jellyfin server at ${baseUrl} (${info.name})`);
    } catch (error) {
      console.warn(`Jellyfin server at ${baseUrl} is not reachable yet: ${safeError(error)}`);
    }
  }

  // ---- Sessions -----------------------------------------------------------

  const cookieOptions = res => ({ httpOnly: true, sameSite: 'lax', secure: config.auth.secureCookies || !!res.req?.secure, path: '/' });
  // Quota and stream limits are shared by everyone on one Jellyfin server:
  // jellyfin:<server ID> for the configured server. A user's own server
  // reports its own ID, so one could pose as another; those are keyed by
  // address too: jellyfin:<server ID>@<host and path>.
  function accountKeyOf(credential) {
    if (!credential.serverUrl) return `jellyfin:${credential.serverId}`;
    const url = new URL(credential.serverUrl);
    return `jellyfin:${credential.serverId}@${url.host}${url.pathname.replace(/\/$/, '')}`;
  }
  // "Sign out everywhere" is per Jellyfin user on that server.
  const generationKey = credential => `${accountKeyOf(credential)}:${credential.userId}`;
  // Users' own servers that have signed in, so admin pages can find them.
  const tenantDirectory = tenantServers && adminConfigured(env) ? store.collection('jellyfin-servers') : null;
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
      const credential = opened?.sourceId === id && opened.credential.type === 'jellyfin' ? opened.credential : null;
      // A session on a user's own server stops working if that plugin is removed.
      const valid = !!credential && typeof credential.accessToken === 'string' && ID.test(credential.userId || '')
        && ID.test(credential.serverId || '') && typeof credential.deviceId === 'string'
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

  // Tell Jellyfin to forget this token. Best effort: the cookie is cleared regardless.
  function revoke(credential) {
    if (!credential) return;
    request('/Sessions/Logout', { credential, method: 'POST', timeoutMs: 5000 })
      .then(response => response.body?.cancel(), () => {});
  }

  async function startSession(res, result, { deviceId, server, info, address }) {
    // The token must belong to the server the sign-in started on.
    if (result?.ServerId !== info.id || !ID.test(result?.User?.Id || '') || typeof result.AccessToken !== 'string') {
      throw new Error('This Jellyfin sign-in is for a different server');
    }
    const credential = {
      type: 'jellyfin',
      serverId: info.id,
      serverName: info.name,
      ...(server.home ? {} : { serverUrl: server.url, ...(address ? { serverAddress: address } : {}) }),
      userId: result.User.Id,
      name: typeof result.User.Name === 'string' ? result.User.Name.slice(0, 120) : 'Jellyfin user',
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
    signedIn?.({ sourceType: 'jellyfin', userKey: `jellyfin:${info.id}:${credential.userId}` });
  }

  // The sign-in in progress (Quick Connect secret and device ID) lives in its
  // own encrypted cookie, like Plex's PIN.
  function setLoginCookie(res, state) {
    res.cookie(LOGIN_COOKIE_NAME, sealer.seal('jellyfin-login', state, LOGIN_TTL_MS), { ...cookieOptions(res), maxAge: LOGIN_TTL_MS });
  }
  const loginState = req => sealer.open('jellyfin-login', parseCookies(req.headers.cookie)[LOGIN_COOKIE_NAME]);

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
    // Which server the session is on, to show its user. A server plugin may
    // name it (displayAddress), e.g. when the stored URL isn't typeable; that
    // also covers sessions from before the typed address was kept.
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
    // The admin is the Jellyfin user named in FREESTUFFCRAZY_ADMIN
    // (jellyfin:<user ID>:<username>), or, when FREESTUFFCRAZY_ADMIN is unset,
    // any administrator of the configured server. Either way they unlock the
    // admin area like anyone else, and Jellyfin is asked, not the cookie.
    async getAdminIdentity(req) {
      const credential = getSession(req)?.credential;
      // Only on the configured server: a user's own server could claim any user ID.
      if (!credential || !HOME || credential.serverUrl || (spec && !ADMIN_USER)) return null;
      const key = crypto.createHash('sha256').update(credential.accessToken).digest('hex');
      let entry = adminChecks.get(key);
      if (!entry || entry.expires <= Date.now()) {
        const me = await api('/Users/Me', { credential });
        const allowed = ADMIN_USER
          ? String(me?.Id).toLowerCase() === ADMIN_USER.id && String(me?.Name).toLowerCase() === ADMIN_USER.name
          : me?.Policy?.IsAdministrator === true;
        entry = { admin: me?.Id === credential.userId && allowed, expires: Date.now() + 60_000 };
        if (adminChecks.size >= 1000) adminChecks.delete(adminChecks.keys().next().value);
        adminChecks.set(key, entry);
      }
      return entry.admin ? { id: `jellyfin:${credential.serverId}:${credential.userId}`, name: credential.name } : null;
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

  function registerRoutes(app, { rateLimit }) {
    app.use(['/api/auth/jellyfin/start', '/api/auth/jellyfin/password'], rateLimit({ maximum: 10, windowMs: 600000 }));

    // The server a sign-in is for: the configured one, or (with the
    // jellyfinServers plugin) the address the user typed, as the plugin allows.
    async function signInServer(address) {
      if (!address || !tenantServers) {
        if (!HOME) throw Object.assign(new Error("Enter your Jellyfin server's https:// address."), { status: 400 });
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
        // The plugin's fetch may explain a failure it can diagnose (such as an
        // untrusted certificate) in error.userMessage, written for the user.
        const message = typeof error?.userMessage === 'string' ? error.userMessage.slice(0, 200) : 'Could not reach a Jellyfin server at that address.';
        throw Object.assign(new Error(message), { status: 400 });
      }
    }
    // The sign-in in progress, from its cookie; null if expired or its server is gone.
    function pendingSignIn(req) {
      const state = loginState(req);
      const server = state && serverAt(state.serverUrl);
      if (!state || !server || !ID.test(state.serverId || '')) return null;
      return { state, server, info: { id: state.serverId, name: state.serverName } };
    }

    // Quick Connect when the server allows it, otherwise the password form.
    app.post('/api/auth/jellyfin/start', async (req, res) => {
      try {
        const address = typeof req.body?.server === 'string' ? req.body.server.trim().slice(0, 2048) : '';
        const { server, info } = await signInServer(address);
        const deviceId = crypto.randomUUID();
        // What they typed (an address, or a name a server plugin understands),
        // kept to show and share later: the stored URL may not be typeable.
        const state = { deviceId, serverId: info.id, serverName: info.name, ...(server.home ? {} : { serverUrl: server.url, serverAddress: address.slice(0, 200) }) };
        const enabled = await api('/QuickConnect/Enabled', { server }).catch(() => false);
        if (enabled !== true) {
          setLoginCookie(res, state);
          return res.json({ mode: 'password', serverName: info.name });
        }
        const started = await api('/QuickConnect/Initiate', { server, method: 'POST', deviceId });
        if (typeof started?.Secret !== 'string' || typeof started.Code !== 'string') throw new Error('Jellyfin did not return a Quick Connect code');
        setLoginCookie(res, { ...state, secret: started.Secret });
        res.json({ mode: 'quickconnect', code: started.Code, serverName: info.name });
      } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        res.status(502).json({ error: 'Could not reach the Jellyfin server.' });
      }
    });

    app.get('/api/auth/jellyfin/poll', async (req, res) => {
      const pending = pendingSignIn(req);
      if (!pending?.state.secret) return res.status(400).json({ error: 'Sign-in expired; start again.' });
      const { state, server, info } = pending;
      try {
        const status = await api(`/QuickConnect/Connect?${new URLSearchParams({ secret: state.secret })}`, { server, deviceId: state.deviceId });
        if (status?.Authenticated !== true) return res.json({ authenticated: false, pending: true });
        const result = await api('/Users/AuthenticateWithQuickConnect', { server, method: 'POST', deviceId: state.deviceId, body: { Secret: state.secret } });
        await startSession(res, result, { deviceId: state.deviceId, server, info, address: state.serverAddress });
        res.json({ authenticated: true });
      } catch (err) {
        // An expired or unknown secret means the code is no longer valid.
        if (err.status === 404 || err.status === 401) return res.status(400).json({ error: 'That code expired; start again.' });
        res.status(502).json({ error: safeError(err) });
      }
    });

    app.post('/api/auth/jellyfin/password', async (req, res) => {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || username.length > 256 || typeof password !== 'string' || password.length > 1024) {
        return res.status(400).json({ error: 'Enter your Jellyfin username and password.' });
      }
      try {
        // The server chosen when sign-in started, or the configured one.
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
        res.status(502).json({ error: safeError(err) });
      }
    });
  }

  // ---- Library ------------------------------------------------------------

  const userQuery = (credential, values = {}) => new URLSearchParams({ userId: credential.userId, ...values });
  const ITEM_FIELDS = 'ProductionYear,Overview,Genres,ChildCount,RecursiveItemCount,ParentId,PrimaryImageAspectRatio';

  function thumbnailUrl(item, imageType, preset) {
    const itemId = imageType === 'Backdrop' && !item.BackdropImageTags?.length ? item.ParentBackdropItemId : item.Id;
    const hasImage = imageType === 'Backdrop' ? !!itemId : item.ImageTags?.[imageType];
    if (!hasImage || !ID.test(itemId || '')) return null;
    const { width, height } = THUMBNAIL_PRESETS[preset];
    return `/api/library/thumb?${new URLSearchParams({ path: `${itemId}/${imageType}`, width: String(width), height: String(height) })}`;
  }

  // The libraries listed, by the server's type for them. Home videos and music videos are plain video files: films with
  // little or no metadata, so they are "video" libraries, which is where Play and Shuffle are offered.
  const LIBRARY_TYPES = { movies: 'movie', tvshows: 'show', homevideos: 'video', musicvideos: 'video', music: 'music' };
  // A music library can be listed by artist, by album or straight to every track.
  const MUSIC_VIEWS = [{ id: 'artists', label: 'Artists' }, { id: 'albums', label: 'Albums' }, { id: 'tracks', label: 'Tracks' }];
  const MUSIC_TYPES = new Set(['artist', 'album', 'track']);
  // A home video or a music video is a film as far as the pages go: a video, played from its start or where it was left.
  const TYPES = { Movie: 'movie', Video: 'movie', MusicVideo: 'movie', Series: 'show', Season: 'season', Episode: 'episode', MusicArtist: 'artist', MusicAlbum: 'album', Audio: 'track' };
  const typeOf = item => TYPES[item.Type] || String(item.Type || '').toLowerCase();
  const viewOffset = item => ms(item.UserData?.PlaybackPositionTicks) || 0;
  function episodeCounts(item) {
    const leafCount = item.RecursiveItemCount ?? item.ChildCount;
    if (!Number.isFinite(leafCount)) return {};
    const unplayed = item.UserData?.UnplayedItemCount;
    return { leafCount, viewedLeafCount: Number.isFinite(unplayed) ? Math.max(0, leafCount - unplayed) : 0 };
  }

  // A track's picture is its album's, the same for every track of it; with none, the track's own.
  function trackArt(item, preset) {
    if (item.AlbumPrimaryImageTag && ID.test(item.AlbumId || '')) {
      const { width, height } = THUMBNAIL_PRESETS[preset];
      return `/api/library/thumb?${new URLSearchParams({ path: `${item.AlbumId}/Primary`, width: String(width), height: String(height) })}`;
    }
    return thumbnailUrl(item, 'Primary', preset);
  }
  // An artist's picture, for a track or album with none of its own (or none that loads). It is only said to be there:
  // a picture that is not is replaced by the page.
  function artistArt(item, preset) {
    const artist = item.ArtistItems?.[0]?.Id || item.AlbumArtists?.[0]?.Id;
    if (!ID.test(artist || '')) return null;
    const { width, height } = THUMBNAIL_PRESETS[preset];
    return `/api/library/thumb?${new URLSearchParams({ path: `${artist}/Primary`, width: String(width), height: String(height) })}`;
  }
  const artistName = item => item.Artists?.[0] || item.AlbumArtist || null;
  function mapTrack(item, preset = 'tiny') {
    return {
      ratingKey: item.Id,
      type: 'track',
      title: item.Name,
      episode: item.IndexNumber,
      season: item.ParentIndexNumber,
      artist: artistName(item),
      album: item.Album || null,
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      thumbnail: trackArt(item, preset) || artistArt(item, preset),
      audioCodec: item.MediaSources?.[0]?.MediaStreams?.find(stream => stream.Type === 'Audio')?.Codec,
    };
  }
  // The pictures of music are square.
  const presetFor = (type, fallback) => (MUSIC_TYPES.has(type) ? 'square' : fallback);

  function mapListItem(item) {
    const type = typeOf(item);
    if (type === 'track') return mapTrack(item);
    return {
      ratingKey: item.Id,
      title: item.Name,
      ...(MUSIC_TYPES.has(type) ? { sortTitle: item.SortName || item.Name } : {}),
      year: item.ProductionYear,
      type,
      thumbnail: thumbnailUrl(item, 'Primary', presetFor(type, 'poster')) || (type === 'album' ? artistArt(item, 'square') : null),
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      childCount: item.ChildCount,
      // An album listed on its own still belongs to an artist, which it opens under.
      ...(type === 'album' ? { showRatingKey: item.AlbumArtists?.[0]?.Id, showTitle: item.AlbumArtist } : {}),
      ...(type === 'artist' ? { leafCount: item.SongCount ?? item.RecursiveItemCount } : {}),
      ...(type === 'show' ? episodeCounts(item) : { viewedLeafCount: 0 }),
    };
  }

  function mapHubItem(item, librarySectionId = null) {
    const type = typeOf(item);
    const episode = type === 'episode';
    return {
      ratingKey: item.Id,
      type,
      librarySectionId,
      title: item.Name,
      year: item.ProductionYear,
      season: episode ? item.ParentIndexNumber : undefined,
      episode: episode ? item.IndexNumber : undefined,
      showTitle: episode || type === 'season' ? item.SeriesName : undefined,
      showRatingKey: type === 'season' ? item.SeriesId : undefined,
      thumbnail: episode ? thumbnailUrl(item, 'Primary', 'landscape') : thumbnailUrl(item, 'Primary', presetFor(type, 'poster')),
      ...(type === 'album' ? { showRatingKey: item.AlbumArtists?.[0]?.Id, showTitle: item.AlbumArtist } : {}),
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      ...episodeCounts(item),
    };
  }

  function mapEpisode(item) {
    return {
      ratingKey: item.Id,
      title: item.Name,
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      duration: minutes(item.RunTimeTicks),
      durationMs: ms(item.RunTimeTicks),
      viewOffset: viewOffset(item),
      thumbnail: thumbnailUrl(item, 'Primary', 'landscape'),
    };
  }

  // Plex-style sort values from the pages, mapped to Jellyfin's.
  function sortParams(sort) {
    const [field, direction] = String(sort || 'addedAt:desc').split(':');
    const by = { titleSort: 'SortName', addedAt: 'DateCreated', year: 'ProductionYear', title: 'SortName' }[field] || 'SortName';
    return { SortBy: by, SortOrder: direction === 'desc' ? 'Descending' : 'Ascending' };
  }

  // How each way of listing a music library is ordered: by artist, then album, then track, as Plex Web lists them.
  const MUSIC_ORDER = { artists: 'SortName', albums: 'AlbumArtist,SortName', tracks: 'AlbumArtist,Album,ParentIndexNumber,IndexNumber' };

  async function libraries(credential) {
    const views = await api(`/UserViews?${userQuery(credential)}`, { credential });
    return (views.Items || [])
      .filter(view => LIBRARY_TYPES[view.CollectionType])
      .map(view => ({ id: view.Id, title: view.Name, type: LIBRARY_TYPES[view.CollectionType], ...(view.CollectionType === 'music' ? { views: MUSIC_VIEWS } : {}) }));
  }

  // An item's subtitle streams and the media source they belong to.
  async function subtitleStreams(credential, itemId) {
    const item = await api(`/Items/${itemId}?${userQuery(credential)}`, { credential });
    const source = item?.MediaSources?.[0];
    return {
      sourceId: String(source?.Id || ''),
      streams: (source?.MediaStreams || []).filter(stream => stream.Type === 'Subtitle' && Number.isInteger(stream.Index) && TRACK_ID.test(String(stream.Index))),
    };
  }

  // Which ids are music artists, so an artist is not looked up again each time its page is opened.
  const kindOfId = new Map();

  function library(req) {
    const credential = credentialFor(req);
    const items = query => api(`/Items?${userQuery(credential, query)}`, { credential });
    // Whether an id is a music artist (its children are albums) rather than a show.
    const isArtist = async id => {
      const cached = kindOfId.get(id);
      if (cached !== undefined) return cached;
      const artist = typeOf(await api(`/Items/${id}?${userQuery(credential)}`, { credential })) === 'artist';
      if (kindOfId.size >= 500) kindOfId.delete(kindOfId.keys().next().value);
      kindOfId.set(id, artist);
      return artist;
    };
    // An artist's tracks: those it is credited on, and every track of its albums (a track can carry another name for
    // the artist, or none), without a track twice.
    const artistTracks = async artistId => {
      const albums = (await items({ AlbumArtistIds: artistId, Recursive: 'true', IncludeItemTypes: 'MusicAlbum', Fields: ITEM_FIELDS })).Items || [];
      const lists = await Promise.all([
        items({ ArtistIds: artistId, Recursive: 'true', IncludeItemTypes: 'Audio', Fields: ITEM_FIELDS }),
        ...albums.slice(0, 100).map(album => items({ ParentId: album.Id, IncludeItemTypes: 'Audio', Fields: ITEM_FIELDS })),
      ]);
      const seen = new Set();
      return lists.flatMap(list => list.Items || []).filter(track => !seen.has(track.Id) && seen.add(track.Id));
    };
    async function fetchLyrics(trackId) {
      try {
        const data = await api(`/Audio/${trackId}/Lyrics?${userQuery(credential)}`, { credential });
        const lines = (data?.Lyrics || []).map(line => ({ startMs: Number.isFinite(line.Start) ? ms(line.Start) : null, text: String(line.Text ?? '') }));
        const timed = lines.length > 0 && lines.every(line => line.startMs !== null);
        return { timed, lines: timed ? lines : lines.map(line => ({ startMs: null, text: line.text })) };
      } catch { return { timed: false, lines: [] }; }
    }
    return {
      libraries: () => libraries(credential),
      async libraryItems(libraryId, { sort, view, start, size } = {}) {
        // A music library: its artists, albums or tracks, in pages.
        if (MUSIC_ORDER[view]) {
          const paging = { ...(Number.isInteger(start) ? { StartIndex: String(start) } : {}), ...(size ? { Limit: String(size) } : {}) };
          const order = { SortBy: MUSIC_ORDER[view], SortOrder: 'Ascending' };
          const data = view === 'artists'
            ? await api(`/Artists/AlbumArtists?${userQuery(credential, { ParentId: libraryId, Fields: ITEM_FIELDS, ...order, ...paging })}`, { credential })
            : await items({ ParentId: libraryId, Recursive: 'true', IncludeItemTypes: view === 'albums' ? 'MusicAlbum' : 'Audio', Fields: ITEM_FIELDS, ...order, ...paging });
          return { total: data.TotalRecordCount, items: (data.Items || []).map(mapListItem) };
        }
        const data = await items({ ParentId: libraryId, Recursive: 'true', IncludeItemTypes: 'Movie,Series,Video,MusicVideo', Fields: ITEM_FIELDS, ...sortParams(sort) });
        return { total: data.TotalRecordCount, items: (data.Items || []).map(mapListItem) };
      },
      async recentlyAdded(libraryId) {
        // A music library's new arrivals are albums (not each of their tracks).
        const music = (await libraries(credential)).find(view => view.id === libraryId)?.type === 'music';
        const latest = await api(`/Items/Latest?${userQuery(credential, { ParentId: libraryId, Limit: '12', Fields: ITEM_FIELDS, GroupItems: 'true', ...(music ? { IncludeItemTypes: 'MusicAlbum' } : {}) })}`, { credential });
        return (Array.isArray(latest) ? latest : []).map(item => mapHubItem(item, libraryId));
      },
      async showSeasons(showId) {
        // An artist's children are its albums.
        if (await isArtist(showId)) {
          const data = await items({ AlbumArtistIds: showId, Recursive: 'true', IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName', Fields: ITEM_FIELDS });
          return (data.Items || []).map(album => ({
            ratingKey: album.Id, type: 'album', title: album.Name, index: album.IndexNumber, year: album.ProductionYear,
            showRatingKey: album.AlbumArtists?.[0]?.Id || showId, showTitle: album.AlbumArtist,
            thumbnail: thumbnailUrl(album, 'Primary', 'square') || artistArt(album, 'square'),
            leafCount: album.ChildCount ?? album.SongCount, viewedLeafCount: 0,
          }));
        }
        const data = await api(`/Shows/${showId}/Seasons?${userQuery(credential, { Fields: ITEM_FIELDS })}`, { credential });
        return (data.Items || []).map(season => ({
          ratingKey: season.Id,
          type: 'season',
          title: season.Name,
          index: season.IndexNumber,
          showRatingKey: season.SeriesId,
          showTitle: season.SeriesName,
          thumbnail: thumbnailUrl(season, 'Primary', 'poster'),
          ...episodeCounts(season),
        }));
      },
      async showEpisodes(showId) {
        // Every track of an artist, album by album.
        if (await isArtist(showId)) {
          const tracks = await artistTracks(showId);
          const text = value => String(value ?? '');
          tracks.sort((a, b) => text(a.Album).localeCompare(text(b.Album)) || (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
          return tracks.map(track => mapTrack(track));
        }
        const data = await api(`/Shows/${showId}/Episodes?${userQuery(credential, { Fields: ITEM_FIELDS })}`, { credential });
        return (data.Items || []).map(mapEpisode);
      },
      // A season's episodes, or an album's tracks.
      async seasonEpisodes(seasonId) {
        const data = await items({ ParentId: seasonId, IncludeItemTypes: 'Episode,Audio', SortBy: 'ParentIndexNumber,IndexNumber', Fields: ITEM_FIELDS });
        return (data.Items || []).map(item => (item.Type === 'Audio' ? mapTrack(item) : mapEpisode(item)));
      },
      async itemDetails(itemId) {
        const item = await api(`/Items/${itemId}?${userQuery(credential)}`, { credential });
        const video = item.MediaSources?.[0]?.MediaStreams?.find(stream => stream.Type === 'Video');
        const type = typeOf(item);
        const track = type === 'track';
        return {
          ratingKey: item.Id,
          type,
          librarySectionId: null,
          title: item.Name,
          showTitle: item.SeriesName || (type === 'album' ? item.AlbumArtist : null) || null,
          // A track belongs to its album, which belongs to its artist.
          parentKey: (track ? item.AlbumId : item.SeasonId) || null,
          grandparentKey: (track ? item.AlbumArtists?.[0]?.Id || item.ArtistItems?.[0]?.Id : item.SeriesId) || null,
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
          // A track's cover is its album's, large because the player shows it that way.
          thumbnail: track ? trackArt(item, 'cover') || artistArt(item, 'cover') : thumbnailUrl(item, 'Primary', presetFor(type, 'poster')),
          ...(track && trackArt(item, 'cover') && artistArt(item, 'cover') ? { fallbackThumbnail: artistArt(item, 'cover') } : {}),
          backdrop: thumbnailUrl(item, 'Backdrop', 'backdrop'),
          ...(track ? { artist: artistName(item), album: item.Album || null } : {}),
          videoCodec: video?.Codec,
          resolution: video ? `${video.Width}x${video.Height}` : null,
        };
      },
      // An artist's most played tracks.
      async popularTracks(artistId) {
        const tracks = await artistTracks(artistId);
        const plays = track => track.UserData?.PlayCount ?? 0;
        return tracks.sort((x, y) => plays(y) - plays(x)).slice(0, 10).map(track => mapTrack(track));
      },
      // Artists that sound like an artist, as one row.
      async similarArtists(artistId) {
        const data = await api(`/Artists/${artistId}/Similar?${userQuery(credential, { Limit: '12', Fields: ITEM_FIELDS })}`, { credential }).catch(() => null);
        const artists = (data?.Items || []).filter(item => typeOf(item) === 'artist').map(mapListItem);
        return artists.length ? [{ title: 'Similar artists', items: artists }] : [];
      },
      // Tracks that sound like a track (an instant mix from it), nearest first.
      async similarTracks(trackId) {
        const data = await api(`/Items/${trackId}/InstantMix?${userQuery(credential, { Limit: '30', Fields: ITEM_FIELDS })}`, { credential }).catch(() => null);
        return (data?.Items || []).filter(item => item.Id !== trackId && typeOf(item) === 'track').map(track => mapTrack(track));
      },
      // The playlists: what is in the server's Playlists folder, of the type Playlist. One may hold music, videos or both.
      async playlists() {
        const views = await api(`/UserViews?${userQuery(credential)}`, { credential });
        const folder = (views.Items || []).find(view => view.CollectionType === 'playlists');
        if (!folder) return [];
        const data = await items({ ParentId: folder.Id, IncludeItemTypes: 'Playlist', SortBy: 'SortName', Fields: 'ChildCount,MediaType' });
        return (data.Items || []).filter(playlist => playlist.Type === 'Playlist').map(playlist => ({
          ratingKey: playlist.Id, type: 'playlist', title: playlist.Name, thumbnail: thumbnailUrl(playlist, 'Primary', 'square'),
          leafCount: playlist.ChildCount ?? playlist.RecursiveItemCount,
        }));
      },
      async playlistItems(playlistId) {
        const data = await api(`/Playlists/${playlistId}/Items?${userQuery(credential, { Fields: 'PrimaryImageAspectRatio' })}`, { credential });
        // Tracks and videos, in the playlist's order; tracks are numbered by their place in it, not by their number on their
        // album. (Anything else a playlist can hold, such as a photo, is not played here.)
        return (data.Items || []).flatMap((item, index) => {
          const type = typeOf(item);
          if (type === 'track') return [{ ...mapTrack(item), episode: index + 1, season: undefined }];
          if (type === 'episode') return [mapHubItem(item)];
          return type === 'movie' ? [mapListItem(item)] : [];
        });
      },
      // A track's lyrics: Jellyfin keeps one set, timed when its lines carry a start.
      async lyricTracks(trackId) {
        const lyrics = await fetchLyrics(trackId);
        return lyrics.lines.length ? [{ id: '0', label: 'Lyrics', timed: lyrics.timed }] : [];
      },
      async lyricText(trackId, id) {
        if (id !== '0') return null;
        const lyrics = await fetchLyrics(trackId);
        return lyrics.lines.length ? lyrics : null;
      },
      // The item's subtitle streams: ones Jellyfin can convert to text are `text`, the
      // rest (picture subtitles such as PGS) can only be drawn into the video.
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
      // One of those text tracks as WebVTT, converted by Jellyfin.
      async subtitleText(itemId, trackId) {
        const { streams, sourceId } = await subtitleStreams(credential, itemId);
        const stream = streams.find(candidate => String(candidate.Index) === String(trackId));
        if (!stream?.IsTextSubtitleStream || !ID.test(sourceId)) return null;
        const response = await request(`/Videos/${itemId}/${sourceId}/Subtitles/${Number(stream.Index)}/0/Stream.vtt`, { credential, timeoutMs: 15000 });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Jellyfin subtitle ${response.status}`); }
        return toWebVtt(await readSubtitleText(response));
      },
      async search(query) {
        const data = await items({ searchTerm: query, Recursive: 'true', IncludeItemTypes: 'Movie,Series,Video,MusicVideo,Episode', Limit: '30', Fields: ITEM_FIELDS });
        return (data.Items || []).map(item => ({
          ratingKey: item.Id, title: item.Name, year: item.ProductionYear, type: typeOf(item),
          thumbnail: thumbnailUrl(item, 'Primary', 'poster'),
        }));
      },
      // Per library, so the page can show each library's own row:
      // in-progress items first, then the next episode of shows being watched.
      async continueWatching() {
        const results = [];
        const seen = new Set();
        for (const view of await libraries(credential)) {
          if (view.type === 'music') continue;
          try {
            const [resume, nextUp] = await Promise.all([
              api(`/UserItems/Resume?${userQuery(credential, { ParentId: view.id, Limit: '12', MediaTypes: 'Video', Fields: ITEM_FIELDS })}`, { credential }),
              view.type === 'show'
                ? api(`/Shows/NextUp?${userQuery(credential, { ParentId: view.id, Limit: '12', Fields: ITEM_FIELDS })}`, { credential })
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
    if (!ID.test(itemId || '') || !IMAGE_TYPES.has(imageType)
      || ![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 2048)) return res.status(400).end();
    try {
      const server = serverOf(credentialFor(req));
      const params = new URLSearchParams({ maxWidth: String(width), maxHeight: String(height), quality: '85' });
      const upstream = await server.fetch(`${server.url}/Items/${itemId}/Images/${imageType}?${params}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
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

  // What the MCU2 (and Ultra) can decode: 8-bit H.264 within
  // the tier's size and frame rate, stereo AAC, in TS segments.
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

  // Music: stereo AAC in TS segments, with no video at all.
  function musicProfile(maxBitrate) {
    return {
      Name: PRODUCT_NAME,
      MaxStreamingBitrate: maxBitrate,
      MaxStaticBitrate: maxBitrate,
      DirectPlayProfiles: [],
      TranscodingProfiles: [{
        Container: 'ts', Type: 'Audio', AudioCodec: 'aac', Protocol: 'hls',
        Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: false,
      }],
      CodecProfiles: [],
      SubtitleProfiles: [],
    };
  }

  // Rewrite a Jellyfin playlist so every URI goes through /proxy/ and no
  // token ever reaches the browser.
  function rewritePlaylist(text, playlistUrl, playSessionId, server) {
    const serverUrl = new URL(server.url);
    const rewrite = value => {
      const url = new URL(value, playlistUrl);
      const path = url.pathname.slice(serverUrl.pathname.replace(/\/$/, '').length).replace(/^\//, '');
      // Same scheme and host as the server. Not origin: for a plugin's own
      // scheme every origin is "null", so comparing origins would let any host through.
      if (url.protocol !== serverUrl.protocol || url.host !== serverUrl.host || !url.pathname.startsWith(serverUrl.pathname.replace(/\/$/, ''))
        || !MEDIA_PATH.test(path) || url.searchParams.get('PlaySessionId') !== playSessionId) {
        // Say which entry, so a new kind in Jellyfin's playlists can be told apart (the path only: no query, so no token).
        console.error('Jellyfin playlist entry refused:', JSON.stringify(path.slice(0, 120)));
        throw new Error('Unexpected Jellyfin media URI');
      }
      for (const key of [...url.searchParams.keys()]) if (/^api_?key$/i.test(key)) url.searchParams.delete(key);
      return `/proxy/${path}?${url.searchParams}`;
    };
    return text.split('\n').filter(line => !TRICKPLAY_TAG.test(line)).map(line => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewrite(uri)}"`);
      return rewrite(line.trim());
    }).join('\n');
  }

  async function startStream(req, res, { itemId, state, stopState }) {
    const credential = credentialFor(req);
    const server = serverOf(credential);
    // A capped server never streams Ultra (1080p, 60 fps), so it stays at 720p
    // or below, with video and audio together under the cap.
    const capKbps = server.maxBitrateKbps;
    // A track is played as music: sound only, at its own rate.
    // (If the server will not say, it is a video, as before.)
    const music = typeOf(await api(`/Items/${itemId}?${userQuery(credential)}`, { credential }).catch(() => null) || {}) === 'track';
    const asked = QUALITY_LEVELS.includes(req.query.quality) ? req.query.quality : 'high';
    const quality = capKbps && asked === 'ultra' ? 'high' : normalizeQuality(asked);
    const tier = { ...qualityTiers(config.plex.videoBitrate)[quality] };
    if (capKbps) tier.videoBitrate = Math.max(300, Math.min(tier.videoBitrate, capKbps - AUDIO_BITRATE / 1000));
    const videoBitrate = tier.videoBitrate * 1000;
    const musicBitrate = capKbps ? Math.min(MUSIC_BITRATE, Math.max(64_000, capKbps * 1000)) : MUSIC_BITRATE;
    // A chosen subtitle track is drawn into the picture; with none chosen nothing is.
    const subtitle = typeof req.query.subtitle === 'string' && TRACK_ID.test(req.query.subtitle) ? req.query.subtitle : null;
    const params = userQuery(credential, {
      maxStreamingBitrate: String(music ? musicBitrate : videoBitrate + AUDIO_BITRATE), enableDirectPlay: 'false', enableDirectStream: 'false',
      enableTranscoding: 'true', autoOpenLiveStream: 'false', mediaSourceId: itemId, startTimeTicks: '0',
      ...(subtitle ? { subtitleStreamIndex: subtitle } : {}),
    });
    const info = await api(`/Items/${itemId}/PlaybackInfo?${params}`, {
      credential, method: 'POST', timeoutMs: 15000,
      body: { DeviceProfile: music ? musicProfile(musicBitrate) : deviceProfile(quality, tier, videoBitrate + AUDIO_BITRATE) },
    });
    const source = info?.MediaSources?.[0];
    const playSessionId = info?.PlaySessionId;
    if (!source?.TranscodingUrl || !ID.test(playSessionId || '')) {
      res.status(502).send('This item cannot be streamed');
      return;
    }

    // Jellyfin gives a path from its root ("/videos/..."). Keep the server
    // address's own path, such as https://host/jellyfin, rather than letting
    // the leading slash replace it.
    const serverPath = new URL(server.url).pathname.replace(/^\/+|\/+$/g, '');
    let transcodingPath = source.TranscodingUrl.replace(/^\/+/, '');
    if (serverPath && transcodingPath.startsWith(`${serverPath}/`)) transcodingPath = transcodingPath.slice(serverPath.length + 1);
    const master = new URL(transcodingPath, `${server.url}/`);
    for (const key of [...master.searchParams.keys()]) if (/^api_?key$/i.test(key)) master.searchParams.delete(key);
    master.searchParams.set('DeviceId', credential.deviceId);
    if (music) {
      master.searchParams.set('AudioBitrate', String(musicBitrate));
      // The older car screen plays only 48 kHz; the newer one asks (rate=source) for the track's own.
      if (req.query.rate === 'source') master.searchParams.delete('AudioSampleRate');
      else master.searchParams.set('AudioSampleRate', MUSIC_SAMPLE_RATE);
    } else {
      master.searchParams.set('VideoBitrate', String(videoBitrate));
      master.searchParams.set('AudioBitrate', String(AUDIO_BITRATE));
    }
    // Subtitles are only drawn into the picture when the viewer chose a track that
    // can't be shown as text, because that costs transcoding.
    if (music) {
      master.searchParams.delete('SubtitleStreamIndex');
      master.searchParams.delete('SubtitleMethod');
    } else if (subtitle) {
      master.searchParams.set('SubtitleStreamIndex', subtitle);
      master.searchParams.set('SubtitleMethod', 'Encode');
    } else {
      master.searchParams.set('SubtitleStreamIndex', '-1');
      master.searchParams.delete('SubtitleMethod');
    }

    const active = { source: id, sessionId: playSessionId, itemId, accessToken: credential.accessToken, deviceId: credential.deviceId, serverUrl: credential.serverUrl, ...(music ? { kind: 'music' } : {}) };
    state.active = active;
    // Shows up as "now playing" in Jellyfin; progress reports follow from the player.
    request('/Sessions/Playing', { credential, method: 'POST', body: { ItemId: itemId, MediaSourceId: source.Id, PlaySessionId: playSessionId, PlayMethod: 'Transcode', CanSeek: true } })
      .then(response => response.body?.cancel(), () => {});

    const upstream = await server.fetch(master, {
      headers: { Authorization: authorization({ deviceId: credential.deviceId, token: credential.accessToken }) },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      console.error('Jellyfin master playlist failed', upstream.status);
      await stopState(state);
      res.status(upstream.status).send('Jellyfin playback request failed');
      return;
    }
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewritePlaylist(await readBodyText(upstream, PLAYLIST_LIMIT), master, playSessionId, server));
  }

  async function proxyMedia(req, res, { ownsSession }) {
    try {
      const credential = credentialFor(req);
      const path = req.params[0];
      const query = new URL(req.originalUrl, 'http://local').searchParams;
      const playSessionId = query.get('PlaySessionId');
      if (!MEDIA_PATH.test(path) || /[%\\]/.test(path) || ![...query.keys()].every(key => !/^api_?key$/i.test(key))
        || !ID.test(playSessionId || '') || !ownsSession(playSessionId)) return res.status(403).end();
      query.set('DeviceId', credential.deviceId);
      const server = serverOf(credential);
      const upstreamUrl = `${server.url}/${path}?${query}`;
      const upstream = await server.fetch(upstreamUrl, {
        headers: { Authorization: authorization({ deviceId: credential.deviceId, token: credential.accessToken }) },
        redirect: 'error',
        // Jellyfin answers once the segment is encoded; a seek can take a few seconds.
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
      console.error('Jellyfin request failed');
      if (res.headersSent) return;
      if (isTimeout(err)) return sendMediaServerSlow(res);
      res.status(err.message === 'Not authenticated' ? 401 : 502).end();
    }
  }

  async function stopStream(active) {
    if (!active?.sessionId) return;
    const params = new URLSearchParams({ deviceId: active.deviceId, playSessionId: active.sessionId });
    try {
      const response = await request(`/Videos/ActiveEncodings?${params}`, {
        credential: { accessToken: active.accessToken, deviceId: active.deviceId, serverUrl: active.serverUrl }, method: 'DELETE', timeoutMs: 5000,
      });
      await response.body?.cancel();
    } catch {
      console.error('Failed to stop Jellyfin transcode');
    }
  }

  // ---- Watch state --------------------------------------------------------

  async function reportProgress(req, { itemId, timeMs, state }) {
    const credential = credentialFor(req);
    const body = { ItemId: itemId, PositionTicks: Math.floor(timeMs) * TICKS_PER_MS, PlayMethod: 'Transcode' };
    // Jellyfin marks the item played on stop when it's past its threshold.
    if (state === 'stopped') await api('/Sessions/Playing/Stopped', { credential, method: 'POST', body });
    else await api('/Sessions/Playing/Progress', { credential, method: 'POST', body: { ...body, IsPaused: state === 'paused' } });
  }

  const watchState = {
    reportProgress,
    async markWatched(req, itemId) {
      const credential = credentialFor(req);
      await api(`/UserPlayedItems/${itemId}?${userQuery(credential)}`, { credential, method: 'POST' });
    },
    async markUnwatched(req, itemId) {
      const credential = credentialFor(req);
      await api(`/UserPlayedItems/${itemId}?${userQuery(credential)}`, { credential, method: 'DELETE' });
    },
  };

  // ---- Accounts -----------------------------------------------------------

  // Each server is one account for limits, named after the server: the
  // configured one, plus users' own servers that have signed in.
  async function serverAccounts() {
    const accounts = [];
    try {
      const info = await serverInfo();
      accounts.push({ key: `jellyfin:${info.id}`, label: info.name, detail: 'Jellyfin server' });
    } catch { /* the configured server is unreachable; others are still listed */ }
    for (const [key, entry] of tenantDirectory ? await tenantDirectory.entries() : []) {
      accounts.push({ key, label: entry.name, detail: `Jellyfin server at ${entry.address}` });
    }
    return accounts;
  }
  const accounts = {
    list: serverAccounts,
    async search(query) {
      const value = query.trim().toLowerCase();
      return (await serverAccounts()).filter(account => [account.label, account.key, account.detail, 'jellyfin']
        .some(text => text.toLowerCase().includes(value)));
    },
    async describe(key) {
      if (!key.startsWith('jellyfin:')) return null;
      return (await serverAccounts()).find(account => account.key === key) || null;
    },
  };

  return {
    id,
    type: 'jellyfin',
    name: 'Jellyfin',
    isValidId: value => typeof value === 'string' && ID.test(value),
    // With a jellyfinServers plugin, sign-in asks for the user's server address.
    // The plugin may word that question itself (prompt: { hint, label,
    // placeholder }), for example when it accepts more than addresses.
    signInOptions: {
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
    legacyPluginContext: {},
  };
}
