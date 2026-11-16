// The server's own Plex credential: the owner's account token and the Plex
// server it reaches. It comes from PLEX_TOKEN when that is set. Otherwise it
// is saved the first time the PLEX_EMAIL account signs in, and reused on every
// later start, so a new install needs no token copied by hand.

import { plexDeviceHeaders, resolvePlexUrl } from './plex-connection.js';
import { safeError } from './security.js';

const RETRY_MS = 30_000;

export function createOwnerLink({
  env, collection, clientId, productName, onLinked,
  resolve = resolvePlexUrl, verifyOwner, retryMs = RETRY_MS, log = console,
}) {
  // Filled in by connect(); `url` stays null until the server is reachable.
  const owner = { token: null, url: null, machineIdentifier: null };
  const fromEnv = !!env.PLEX_TOKEN;
  let retryTimer = null;

  async function identify(url, token) {
    const res = await fetch(`${url}/identity`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('Unable to verify Plex identity');
    const id = (await res.json())?.MediaContainer?.machineIdentifier;
    if (typeof id !== 'string' || !id) throw new Error('Invalid Plex identity');
    return id;
  }

  // Only the account that owns the server can be the server's credential. A
  // PLEX_URL that answers is not proof of that, so ask plex.tv.
  async function ownsServer(token, machineIdentifier) {
    if (verifyOwner) return verifyOwner(token, machineIdentifier);
    const res = await fetch('https://plex.tv/api/v2/resources?includeHttps=1', {
      headers: { Accept: 'application/json', 'X-Plex-Token': token, 'X-Plex-Client-Identifier': clientId, ...plexDeviceHeaders(productName) },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { await res.body?.cancel(); return false; }
    const resources = await res.json();
    return Array.isArray(resources)
      && resources.some(r => r.clientIdentifier === machineIdentifier && r.owned && (r.provides || '').includes('server'));
  }

  function stopRetrying() {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = null;
  }

  // Find the owner's server with this token. `remember` saves the token for the
  // next start (used for a sign-in, not for a token that is already saved).
  async function connect(token, { remember = false } = {}) {
    const url = await resolve({ token, clientId, productName, preferredUrl: env.PLEX_URL });
    const machineIdentifier = await identify(url, token);
    // A token from PLEX_TOKEN has always been trusted as given; one learned from
    // a sign-in or read back from storage must belong to the server's owner.
    if (!fromEnv && !(await ownsServer(token, machineIdentifier))) throw new Error('This Plex account does not own that server');
    Object.assign(owner, { token, url, machineIdentifier });
    if (remember) await collection.set('owner', { token, savedAt: Date.now() });
    stopRetrying();
    await onLinked?.(owner);
  }

  // The owner signed in again: keep the saved token current. The server itself
  // does not change, so nothing is looked up again.
  async function refresh(token) {
    if (fromEnv || !owner.url || token === owner.token) return;
    owner.token = token;
    await collection.set('owner', { token, savedAt: Date.now() });
  }

  function retryLater(token) {
    if (retryTimer) return;
    retryTimer = setInterval(() => { connect(token).catch(() => {}); }, retryMs);
    retryTimer.unref?.();
  }

  // At startup. A PLEX_TOKEN that cannot reach Plex stops the server, as it
  // always has. A saved token that cannot is retried in the background: the
  // server may simply be down, and the owner can sign in again either way.
  async function restore() {
    if (fromEnv) return connect(env.PLEX_TOKEN);
    const saved = await collection.get('owner');
    if (typeof saved?.token !== 'string' || !saved.token) {
      log.log('Plex is not linked yet. Sign in with the PLEX_EMAIL account to finish setting it up.');
      return undefined;
    }
    try {
      return await connect(saved.token);
    } catch (error) {
      log.warn(`Could not reach Plex with the saved owner sign-in (${safeError(error)}); trying again every ${Math.round(retryMs / 1000)} seconds. The owner can also sign in again.`);
      retryLater(saved.token);
      return undefined;
    }
  }

  return { owner, connect, refresh, restore, stopRetrying };
}
