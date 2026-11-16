// Authenticate through Plex’s PIN flow and verify server access when required.

import crypto from 'node:crypto';
import { createPlexIdentityLookup } from './plex-account-identity.js';
import { plexDeviceHeaders } from './plex-connection.js';
import qrcode from 'qrcode-generator';
import { dataDir } from './private-storage.js';
import { parseCookies } from './security.js';
import { createCookieSealer, packSession, unpackSession, SESSION_COOKIE_NAME } from './session-cookie.js';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { firstPluginWith } from './plugins.js';

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must contain at least 32 characters');
  process.exit(1);
}

const COOKIE_NAME = SESSION_COOKIE_NAME;
const LOGIN_COOKIE_NAME = 'freeStuffCrazyPlayerLogin';
const PLEX_TV = 'https://plex.tv';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

// Sessions live entirely in an encrypted HttpOnly cookie: the server stores
// no Plex tokens and no session list. Changing SESSION_SECRET signs everyone out.
const sealer = createCookieSealer(SESSION_SECRET);

// Earlier versions kept every session's Plex tokens in this file. Remove it
// so no tokens remain on disk; those sessions simply sign in again.
rmSync(path.join(dataDir, '.sessions.json'), { force: true });

// Only the login page, its assets and explicit authentication endpoints are public.
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/safe-navigation.js', '/api/auth/plex/pin', '/api/auth/plex/poll', '/api/auth/plex/select-user', '/api/auth/plex/avatar']);

// Parse the flat attribute-only XML returned by Plex Home endpoints when needed.
function decodeXmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseXmlTags(xml, tagName) {
  const tagRegex = new RegExp(`<${tagName}\\b([^>]*?)/?>`, 'g');
  const attrRegex = /([a-zA-Z0-9_:]+)="([^"]*)"/g;
  const results = [];
  let tagMatch;
  while ((tagMatch = tagRegex.exec(xml))) {
    const attrs = {};
    let attrMatch;
    attrRegex.lastIndex = 0;
    while ((attrMatch = attrRegex.exec(tagMatch[1]))) {
      attrs[attrMatch[1]] = decodeXmlEntities(attrMatch[2]);
    }
    results.push(attrs);
  }
  return results;
}

// `owner` is the server's own Plex credential (see plex-owner-link.js). Its url,
// token and machineIdentifier are read when needed, because with no PLEX_TOKEN
// they only exist once the owner has signed in.
export function createPlexAuth({ owner, clientId, productName, plugins = [], store, sourceId = 'plex', onAccount = null, signedIn = null }) {
  // "Sign out everywhere" bumps an account's number here; cookies carrying an
  // older number are rejected. Only Plex account IDs and counters, no secrets.
  const signoutGenerations = store.collection('signout-generations'); // accountId -> number
  async function generationFor(accountId) {
    if (!accountId) return 0;
    const value = await signoutGenerations.get(String(accountId));
    return Number.isSafeInteger(value) ? value : 0;
  }
  async function bumpGeneration(accountId) {
    await signoutGenerations.update(String(accountId), value => (Number.isSafeInteger(value) ? value : 0) + 1);
  }

  function plexTvHeaders(extra = {}) {
    return {
      Accept: 'application/json',
      'X-Plex-Client-Identifier': clientId,
      ...plexDeviceHeaders(productName),
      ...extra,
    };
  }

  // This server's own identity on plex.tv -- what we compare the signed-in
  // user's accessible-resources list against.
  async function getMachineIdentifier() {
    if (!owner.machineIdentifier) throw new Error('Plex is not linked yet');
    return owner.machineIdentifier;
  }

  const cookieOptions = (res) => ({ httpOnly: true, sameSite: 'lax', secure: config.auth.secureCookies || !!res.req?.secure, path: '/' });

  // The sign-in in progress lives in an encrypted cookie bound to its PIN.
  // Completed PINs are remembered in memory only to refuse an immediate
  // replay on this server; correctness never depends on it.
  const completedPins = new Map(); // pinId -> expiresAt
  function setLoginCookie(res, state) {
    const { exp: _exp, ...payload } = state;
    res.cookie(LOGIN_COOKIE_NAME, sealer.seal('login', payload, LOGIN_TTL_MS), { ...cookieOptions(res), maxAge: LOGIN_TTL_MS });
  }
  async function withLogin(req, res, pinId, operation) {
    for (const [key, expires] of completedPins) if (expires <= Date.now()) completedPins.delete(key);
    const state = sealer.open('login', parseCookies(req.headers.cookie)[LOGIN_COOKIE_NAME]);
    if (!state || state.pinId !== String(pinId) || completedPins.has(state.pinId)) throw new Error('Sign-in session expired or invalid');
    const login = {
      accountToken: typeof state.accountToken === 'string' ? state.accountToken : null,
      // Keep the account token for the profile picker, inside the encrypted cookie.
      remember(accountToken) { setLoginCookie(res, { pinId: state.pinId, accountToken }); },
    };
    return operation(() => {
      if (completedPins.size < 10000) completedPins.set(state.pinId, Date.now() + LOGIN_TTL_MS);
      res.clearCookie(LOGIN_COOKIE_NAME, cookieOptions(res));
    }, login);
  }

  async function createPin(req, response) {
    // strong:false gives the short, human-typable code plex.tv/link expects
    // (strong:true is for embedding in an auth URL, not for typing by hand).
    const res = await fetch(`${PLEX_TV}/api/v2/pins`, {
      method: 'POST',
      headers: plexTvHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ strong: 'false' }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Plex pin request failed: ${res.status}`);
    const data = await res.json();
    const linkUrl = new URL('/link/', PLEX_TV);
    linkUrl.searchParams.set('pin', data.code);
    const qr = qrcode(0, 'M');
    qr.addData(linkUrl.href);
    qr.make();

    setLoginCookie(response, { pinId: String(data.id) });
    return { id: data.id, code: data.code, clientId, productName, qrCode: qr.createDataURL(6) };
  }

  // Poll for the token after the user completes Plex sign-in.
  async function checkPin(pinId) {
    const res = await fetch(`${PLEX_TV}/api/v2/pins/${encodeURIComponent(pinId)}`, {
      headers: plexTvHeaders(),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Plex pin check failed: ${res.status}`);
    }
    const data = await res.json();
    return data.authToken || null;
  }

  // List Home profiles for selection; protected profiles require a PIN.
  // Accept JSON and normalize the XML fallback to the same shape.
  async function listHomeUsers(accountToken) {
    const res = await fetch(`${PLEX_TV}/api/v2/home/users`, {
      headers: plexTvHeaders({ 'X-Plex-Token': accountToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Plex home users lookup failed: ${res.status}`);
    }
    const body = await res.text();
    const contentType = res.headers.get('content-type') || '';
    const rawUsers = contentType.includes('json')
      ? (JSON.parse(body).users || [])
      : parseXmlTags(body, 'user');
    return rawUsers.map((u) => ({
      id: String(u.id),
      title: u.title || u.username || u.friendlyName,
      // Proxy avatars through a restricted same-origin endpoint.
      thumb: u.thumb ? `/api/auth/plex/avatar?url=${encodeURIComponent(u.thumb)}` : null,
      admin: u.admin === true || u.admin === '1',
      guest: u.guest === true || u.guest === '1',
      protected: u.protected === true || u.protected === '1',
    }));
  }

  // Switch to a Home profile and return its token for profile-scoped Plex requests.
  // switchClientId must match whatever every later request for this same
  // profile sends (see server.js's clientIdForRequest) -- confirmed by
  // direct testing that Plex Media Server's own hub personalization
  // resolves a Home profile's data by which device was registered at
  // switch time, not by token alone: a verified-correct token still
  // returned the server owner's Continue Watching when the request's
  // client identifier didn't match the one this switch used. Falls back
  // to the base clientId only for callers that don't yet have one
  // (there are none left -- every switchHomeUser call site passes it now).
  async function switchHomeUser(accountToken, userId, pin, switchClientId = clientId) {
    const params = pin ? `?${new URLSearchParams({ pin })}` : '';
    const res = await fetch(`${PLEX_TV}/api/home/users/${encodeURIComponent(userId)}/switch${params}`, {
      method: 'POST',
      headers: plexTvHeaders({ 'X-Plex-Token': accountToken, 'X-Plex-Client-Identifier': switchClientId }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(res.status === 401 ? 'Incorrect PIN' : `Plex user switch failed: ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || '';
    let newToken = null;
    if (contentType.includes('json')) {
      const data = JSON.parse(body);
      newToken = data.authToken || data.authenticationToken || null;
    } else {
      const match = body.match(/authenticationToken="([^"]*)"/) || body.match(/authToken="([^"]*)"/);
      newToken = match ? decodeXmlEntities(match[1]) : null;
    }
    if (!newToken) throw new Error('Plex did not return a token for the selected user');
    return newToken;
  }

  // Plex.tv issues a separate, per-server accessToken for each resource a
  // Home profile can reach -- distinct from the account-level token
  // returned by switchHomeUser. Confirmed by direct testing: the
  // account-level token reliably proves identity (whoami, etc.) but the
  // local PMS does not personalize hub reads (Continue Watching, OnDeck)
  // correctly against it for non-owner Home profiles. Plex Web always
  // resolves and uses this resource-specific accessToken instead; we must
  // too, for every non-owner session.
  async function findServerResource(userToken) {
    const machineIdentifier = await getMachineIdentifier();
    const res = await fetch(`${PLEX_TV}/api/v2/resources?includeHttps=1`, {
      headers: plexTvHeaders({ 'X-Plex-Token': userToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const resources = await res.json();
    // Owner-only: a shared/invited Plex account can appear in this same
    // resources list with access to the server, but only the account that
    // owns the server may sign in.
    return resources.find((r) => r.clientIdentifier === machineIdentifier && r.owned && (r.provides || '').includes('server')) || null;
  }

  async function userHasServerAccess(userToken) {
    if (!config.auth.requireServerAccess) return true;
    return !!(await findServerResource(userToken));
  }

  // Allow a trusted plugin to select the login server; otherwise use the configured server.
  async function defaultResolveServer(userToken) {
    const resource = await findServerResource(userToken);
    if (resource) {
      return { ok: true, plexUrl: owner.url, machineIdentifier: await getMachineIdentifier(), accessToken: resource.accessToken || userToken };
    }
    if (!config.auth.requireServerAccess) {
      return { ok: true, plexUrl: owner.url, machineIdentifier: await getMachineIdentifier(), accessToken: userToken };
    }
    return { ok: false, error: 'This Plex account does not have access to this server' };
  }
  async function resolveServer(userToken, options) {
    const owner = firstPluginWith(plugins, 'resolveServer');
    return owner ? owner.resolveServer(userToken, options) : defaultResolveServer(userToken);
  }

  // A session lasts this long after its last renewal; activity renews it daily.
  const SESSION_MAX_AGE_MS = config.auth.sessionDays * 24 * 60 * 60 * 1000;

  function writeSessionCookie(res, { sid, credential }) {
    const payload = packSession({ sid, sourceId, credential, renewedAt: Date.now() });
    res.cookie(COOKIE_NAME, sealer.seal('session', payload, SESSION_MAX_AGE_MS), {
      ...cookieOptions(res),
      maxAge: SESSION_MAX_AGE_MS,
    });
  }

  // Keep the account token for Home switching and the active profile token
  // for media access -- both only inside the encrypted cookie.
  // `signIn` is false when an already signed-in viewer only switches profile.
  async function setSession(res, { accountToken, userToken, title, thumb, profileId, admin, plexUrl: sessionPlexUrl, machineIdentifier: sessionMachineIdentifier, signIn = true }) {
    // The account ID ties the cookie to "sign out everywhere". If plex.tv
    // can't confirm it right now the session still works, but only expiry ends it.
    const accountId = (await identityForToken(accountToken).catch(() => null))?.id ?? null;
    writeSessionCookie(res, { sid: crypto.randomBytes(16).toString('hex'), credential: {
      type: 'plex',
      accountId,
      generation: await generationFor(accountId),
      accountToken,
      userToken: userToken || accountToken,
      title: title || null,
      thumb: thumb || null,
      profileId: profileId != null ? String(profileId) : null,
      admin: !!admin,
      plexUrl: sessionPlexUrl || owner.url, // which Plex server userToken is valid against
      // Identifies that same server independent of which connection URI
      // was used to reach it -- a resolveServer plugin can legitimately
      // pick a different (but equally valid) URI per login than the one
      // this install was configured/booted with, so callers that need to
      // know "is this literally my own configured server" (e.g. owner-only
      // account lookups) must compare this, not plexUrl, against it.
      machineIdentifier: sessionMachineIdentifier || null,
      iat: Date.now(),
    } });
    if (signIn && accountId) signedIn?.({ sourceType: 'plex', userKey: `plex:${accountId}` });
  }

  // Opened once per request by the loadSession middleware (it needs an async
  // revocation check); everything else reads the result synchronously.
  // The session object is this source's credential plus the cookie's sid.
  const openedSessions = new WeakMap();
  async function loadSession(req, _res, next) {
    // Until the owner has linked the server there is nothing a session could
    // reach, so everyone is signed out and the login page does the linking.
    if (!owner.url) { openedSessions.set(req, null); return next(); }
    try {
      const opened = unpackSession(sealer.open('session', parseCookies(req.headers.cookie)[COOKIE_NAME]),
        { legacySourceId: sourceId, legacyType: 'plex' });
      const credential = opened?.sourceId === sourceId && opened.credential.type === 'plex' ? opened.credential : null;
      const valid = !!credential && typeof credential.userToken === 'string'
        && (credential.generation ?? 0) === await generationFor(credential.accountId);
      openedSessions.set(req, valid ? { ...credential, sessionId: opened.sid, renewedAt: opened.renewedAt, credential } : null);
      next();
    } catch (error) {
      next(error);
    }
  }
  function getSession(req) {
    return openedSessions.get(req) ?? null;
  }

  function clearSession(_req, res) {
    res.clearCookie(COOKIE_NAME, cookieOptions(res));
  }

  // Invalidate every cookie issued to this Plex account, on every device.
  async function signOutEverywhere(req, res) {
    const session = getSession(req);
    if (!session) throw new Error('Not authenticated');
    if (!session.accountId) throw new Error('Plex could not confirm this account when you signed in. Sign out and sign in again, then try again.');
    await bumpGeneration(session.accountId);
    clearSession(req, res);
  }

  function isAuthenticated(req) {
    return !!getSession(req);
  }

  // For the "who's logged in" badge -- null if there's no valid session.
  function getSessionUser(req) {
    const session = getSession(req);
    return session ? { title: session.title, thumb: session.thumb } : null;
  }

  // Use the active profile token for library, playback and watch-state requests.
  function getSessionPlexToken(req) {
    const session = getSession(req);
    return session ? session.userToken : null;
  }

  // Return the active Home profile ID, or null when unavailable.
  function getSessionProfileId(req) {
    const session = getSession(req);
    return session?.profileId || null;
  }

  // Return whether the current profile is the server owner.
  function getSessionIsAdmin(req) {
    const session = getSession(req);
    return !!session?.admin;
  }

  function getSessionPlexUrl(req) {
    const session = getSession(req);
    return session?.plexUrl || owner.url;
  }

  function getSessionMachineIdentifier(req) {
    const session = getSession(req);
    return session?.machineIdentifier || null;
  }

  // Opaque per-account grouping key for quota and stream limits:
  // plex:<plex.tv account ID>, or a hash of the account token when plex.tv
  // couldn't confirm the account at sign-in. Every Home profile of one
  // account shares it.
  async function getSessionAccountKey(req) {
    const session = getSession(req);
    if (!session) return null;
    const accountId = await getSessionAccountId(req);
    if (accountId) return `plex:${accountId}`;
    return session.accountToken ? crypto.createHash('sha256').update(session.accountToken).digest('hex') : null;
  }

  const lookupIdentity = createPlexIdentityLookup({ headers: plexTvHeaders() });
  // onAccount records accounts for the admin account search; plugins that
  // predate it may still observe them through observePlexAccount.
  const accountObserver = firstPluginWith(plugins, 'observePlexAccount');
  async function identityForToken(token) {
    const identity = await lookupIdentity(token);
    if (identity) {
      for (const observe of [onAccount, accountObserver && (value => accountObserver.observePlexAccount(value))]) {
        if (!observe) continue;
        try { await observe(identity); }
        catch { console.error('Plex account observation failed'); }
      }
    }
    return identity;
  }
  function getSessionIdentity(req) {
    return identityForToken(getSession(req)?.accountToken);
  }
  async function getSessionAccountId(req) {
    const session = getSession(req);
    if (!session) return null;
    // Confirmed with plex.tv at sign-in and carried in the authenticated cookie.
    return session.accountId ?? (await getSessionIdentity(req))?.id ?? null;
  }

  // Reuse the cookie's account token to list profiles without another login.
  async function listHomeUsersForSession(req) {
    const session = getSession(req);
    if (!session) throw new Error('Not authenticated');
    return listHomeUsers(session.accountToken);
  }

  async function switchUserForSession(req, res, userId, pin) {
    const session = getSession(req);
    if (!session) throw new Error('Not authenticated');
    const users = await listHomeUsers(session.accountToken);
    const picked = users.find((u) => u.id === String(userId));
    if (!picked) throw new Error('Invalid profile');
    const switchedToken = await switchHomeUser(session.accountToken, userId, pin, `${clientId}-${picked.id}`);
    const resolved = await resolveServer(switchedToken, { preferredPlexUrl: session.plexUrl, machineIdentifier: session.machineIdentifier });
    if (!resolved.ok) throw new Error(resolved.error || 'This Plex user does not have access to this server');
    // resolved.accessToken, not switchedToken -- see select-user's comment
    // in server.js and findServerResource above.
    await setSession(res, { accountToken: session.accountToken, userToken: resolved.accessToken || switchedToken,
      title: picked.title, thumb: picked.thumb, profileId: picked.id, admin: picked.admin,
      plexUrl: resolved.plexUrl, machineIdentifier: resolved.machineIdentifier, signIn: false });
  }

  async function getVerifiedProfile(req) {
    const session = getSession(req);
    if (!session?.profileId) return null;
    const users = await listHomeUsers(session.accountToken);
    return users.find(user => user.id === session.profileId) || null;
  }

  function requireAuth(req, res, next) {
    if (!config.auth.enabled) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();
    const session = getSession(req);
    if (session) {
      // Slide the expiry forward at most once a day while the player is in use.
      if (!(Date.now() - session.renewedAt < RENEW_AFTER_MS)) writeSessionCookie(res, { sid: session.sessionId, credential: session.credential });
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    res.redirect(`/login?return=${encodeURIComponent(req.originalUrl)}`);
  }

  return {
    withLogin, getVerifiedProfile, getSessionId: req => getSession(req)?.sessionId || null,
    isPublicPath: path => PUBLIC_PATHS.has(path),
    // The signed-in Plex credential (tokens included) for trusted server code only.
    getSessionCredential: req => getSession(req)?.credential ?? null,
    createPin, checkPin, userHasServerAccess, resolveServer, setSession, clearSession, signOutEverywhere, loadSession, requireAuth,
    listHomeUsers, switchHomeUser, getSessionUser, getSessionPlexToken,
    listHomeUsersForSession, switchUserForSession, getSessionProfileId, getSessionIsAdmin,
    getSessionPlexUrl, getSessionAccountKey, getSessionAccountId, getSessionIdentity, getSessionMachineIdentifier, getMachineIdentifier,
    identityForToken,
  };
}
