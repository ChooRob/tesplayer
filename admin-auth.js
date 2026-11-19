import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';

const UNLOCK_MS = 15 * 60_000;
const CHALLENGE_MS = 2 * 60_000;

// The one admin, named on the player side as <backend>:<who>:
//   FREESTUFFCRAZY_ADMIN=plex:you@example.com                the Plex owner with that confirmed email
//   FREESTUFFCRAZY_ADMIN=jellyfin:<user ID>:<username>       that Jellyfin user; both must match
// Returns { type, who } with who lowercased, or null.
export function adminSpec(env = process.env) {
  const value = env.FREESTUFFCRAZY_ADMIN?.trim();
  if (!value) return null;
  const match = /^([a-z][a-z0-9-]*):(.+)$/i.exec(value);
  return match && match[2].trim() ? { type: match[1].toLowerCase(), who: match[2].trim().toLowerCase() } : null;
}

// PLEX_EMAIL: the one Plex account that may sign in when no plugin chooses
// servers (single tenant). Lowercased; null when unset or not an address.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function plexEmail(env = process.env) {
  const value = env.PLEX_EMAIL?.trim().toLowerCase();
  return value && EMAIL_PATTERN.test(value) ? value : null;
}

// Whether the admin area is set up at all, so other code can skip admin-only
// work: an admin token, and an admin -- named in FREESTUFFCRAZY_ADMIN, or by
// default the PLEX_EMAIL account or the Jellyfin server's administrators.
export function adminConfigured(env = process.env) {
  return /^[0-9a-f]{64}$/i.test(env.FREESTUFFCRAZY_ADMIN_TOKEN_SHA256?.trim() ?? '')
    && !!(adminSpec(env) || plexEmail(env) || env.JELLYFIN_URL?.trim() || env.EMBY_URL?.trim());
}

// identityFor(req) -> { id, name, sessionId } for an admin, else null. Each
// media source decides who its admins are (see getAdminIdentity in the
// sources); id is namespaced by backend, e.g. plex:123.
export function registerAdmin(app, { identityFor, rateLimit, store, appOrigin, env = process.env }) {
  const hash = env.FREESTUFFCRAZY_ADMIN_TOKEN_SHA256?.trim();
  const enabled = adminConfigured(env);
  const tokenEnabled = env.FREESTUFFCRAZY_ADMIN_ALLOW_TOKEN === 'true';
  const digest = enabled ? Buffer.from(hash, 'hex') : null;
  const rpID = appOrigin?.startsWith('https://') ? new URL(appOrigin).hostname : null;
  // credential ID -> credential. Older installs stored a plain array.
  const passkeys = store.collection('admin-passkeys', {
    migrate: raw => (Array.isArray(raw) ? Object.fromEntries(raw.filter(entry => typeof entry?.id === 'string').map(entry => [entry.id, entry])) : raw),
  });
  const tabs = new Map();
  const unlocks = new Map();
  const challenges = new Map();

  async function owner(req) {
    if (!enabled) return null;
    const identity = await identityFor(req);
    return identity?.id && identity.sessionId ? identity : null;
  }

  async function available(req) {
    return tabs.size > 0 && !!(await owner(req).catch(() => null));
  }

  // False when the admin area isn't configured or the ID is taken; plugins
  // then skip their admin routes.
  function registerTab({ id, label, file, order = 0 }) {
    if (!enabled) return false;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)
      || typeof label !== 'string' || !label.trim() || typeof file !== 'string'
      || !path.isAbsolute(file) || tabs.has(id)) return false;
    tabs.set(id, { id, label, file, order: Number.isFinite(order) ? order : 0 });
    return true;
  }

  function tokenMatches(req) {
    const token = /^Bearer ([0-9a-f]{64})$/i.exec(req.get('Authorization') ?? '')?.[1];
    return !!token && timingSafeEqual(createHash('sha256').update(token).digest(), digest);
  }

  const sessionKey = identity => identity.sessionId + ':' + identity.id;
  const unlocked = identity => (unlocks.get(sessionKey(identity)) ?? 0) > Date.now();
  // Passkeys saved before admins could come from other backends recorded the
  // bare Plex account ID; they still belong to plex:<that ID>.
  const ownerOf = entry => (/^\d+$/.test(entry.accountId ?? '') ? `plex:${entry.accountId}` : entry.accountId);
  async function ownCredentials(identity) {
    if (!enabled || !rpID) return [];
    return (await passkeys.entries()).map(([, entry]) => entry)
      .filter(entry => entry.origin === appOrigin && ownerOf(entry) === identity.id);
  }
  function prune(map) {
    for (const [key, expiry] of map) if ((expiry.expires ?? expiry) <= Date.now()) map.delete(key);
  }
  function unlock(identity) {
    prune(unlocks);
    unlocks.set(sessionKey(identity), Date.now() + UNLOCK_MS);
  }
  function setChallenge(identity, action, challenge) {
    prune(challenges);
    challenges.set(sessionKey(identity), { action, challenge, expires: Date.now() + CHALLENGE_MS });
  }
  function takeChallenge(identity, action) {
    const key = sessionKey(identity);
    const pending = challenges.get(key);
    if (!pending || pending.action !== action) return null;
    challenges.delete(key);
    return pending.expires > Date.now() ? pending.challenge : null;
  }

  function requireOwner(req, res, next) {
    res.set('Cache-Control', 'no-store');
    owner(req).then(identity => {
      if (!identity || !tabs.size) return res.status(403).json({ error: 'Admin access denied.' });
      req.adminIdentity = identity;
      next();
    }).catch(() => res.status(503).json({ error: 'Could not verify admin identity.' }));
  }
  function requireUnlock(req, res, next) {
    if (unlocked(req.adminIdentity)) return next();
    res.status(403).json({ code: 'ADMIN_LOCKED', error: tokenEnabled
      ? 'Unlock Admin with a passkey or token.' : 'Unlock Admin with your passkey.' });
  }

  app.get(['/admin', '/admin.html'], requireOwner, (_req, res) => {
    res.sendFile(path.resolve('admin.html'));
  });
  app.get('/admin-webauthn.js', requireOwner, (_req, res) => {
    res.type('application/javascript').sendFile(path.resolve('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js'));
  });
  app.use('/api/admin', rateLimit({ maximum: 60 }), requireOwner);

  app.get('/api/admin/auth/status', async (req, res, next) => {
    try {
      res.json({
        unlocked: unlocked(req.adminIdentity),
        passkeysSupported: !!rpID,
        tokenEnabled,
        hasPasskey: (await ownCredentials(req.adminIdentity)).length > 0,
      });
    } catch (error) { next(error); }
  });
  app.post('/api/admin/auth/token', (req, res) => {
    if (!tokenEnabled || !tokenMatches(req)) return res.status(403).json({ error: 'Admin token access denied.' });
    unlock(req.adminIdentity);
    res.json({ ok: true });
  });
  app.post('/api/admin/auth/lock', (req, res) => {
    const key = sessionKey(req.adminIdentity);
    unlocks.delete(key);
    challenges.delete(key);
    res.json({ ok: true });
  });

  function ceremony(action, stage, handler) {
    app.post('/api/admin/auth/passkeys/' + action + '/' + stage, async (req, res) => {
      if (!rpID) return res.status(400).json({ error: 'Passkeys require a configured HTTPS app origin.' });
      if (action === 'register' && (!tokenEnabled || !tokenMatches(req))) {
        return res.status(403).json({ error: 'Enter the admin token to add a passkey.' });
      }
      try {
        res.json(await handler(req.adminIdentity, req.body));
      } catch {
        res.status(400).json({ error: 'Could not verify the passkey. Start again and try another key if needed.' });
      }
    });
  }
  ceremony('register', 'options', async identity => {
    const options = await generateRegistrationOptions({
      rpName: 'FreeStuffCrazy Player Admin', rpID,
      // Same user handle passkeys registered for Plex admins already carry.
      userID: new TextEncoder().encode(identity.id), userName: identity.name || identity.id,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: (await ownCredentials(identity)).map(({ id, transports }) => ({ id, transports })),
    });
    setChallenge(identity, 'register', options.challenge);
    return options;
  });
  ceremony('register', 'verify', async (identity, response) => {
    const expectedChallenge = takeChallenge(identity, 'register');
    if (!expectedChallenge) throw Error('Missing registration challenge');
    const result = await verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: appOrigin, expectedRPID: rpID, requireUserVerification: true,
    });
    const credential = result.registrationInfo?.credential;
    if (!result.verified || !credential || (await ownCredentials(identity)).some(entry => entry.id === credential.id)) {
      throw Error('Invalid registration');
    }
    await passkeys.set(credential.id, {
      ...credential, origin: appOrigin, accountId: identity.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    });
    return { ok: true };
  });
  ceremony('authenticate', 'options', async identity => {
    const allowCredentials = (await ownCredentials(identity)).map(({ id, transports }) => ({ id, transports }));
    if (!allowCredentials.length) throw Error('No registered passkey');
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials });
    setChallenge(identity, 'authenticate', options.challenge);
    return options;
  });
  ceremony('authenticate', 'verify', async (identity, response) => {
    const expectedChallenge = takeChallenge(identity, 'authenticate');
    const entry = (await ownCredentials(identity)).find(value => value.id === response?.id);
    if (!expectedChallenge || !entry) throw Error('Missing authentication challenge or credential');
    const result = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: appOrigin, expectedRPID: rpID, requireUserVerification: true,
      credential: { ...entry, publicKey: Buffer.from(entry.publicKey, 'base64url') },
    });
    const counter = result.authenticationInfo?.newCounter;
    if (!result.verified || counter === undefined) throw Error('Invalid authentication');
    const current = (await ownCredentials(identity)).find(value => value.id === entry.id);
    if (!current || (counter > 0 && counter <= current.counter)) throw Error('Stale authentication');
    if (counter !== current.counter) await passkeys.update(current.id, value => (value ? { ...value, counter } : undefined));
    unlock(identity);
    return { ok: true };
  });

  app.use('/api/admin', requireUnlock);
  app.get('/api/admin/tabs', (_req, res) => {
    res.json({ tabs: [...tabs.values()].sort((a, b) => a.order - b.order).map(({ id, label }) => ({ id, label })) });
  });
  app.get('/api/admin/tabs/:tabId.js', (req, res) => {
    const tab = tabs.get(req.params.tabId);
    if (!tab) return res.status(404).end();
    res.type('application/javascript').sendFile(tab.file);
  });
  return { enabled, available, registerTab };
}
