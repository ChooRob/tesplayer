// Which Plex server this install belongs to. The first sign-in by the PLEX_EMAIL
// account finds the server and saves only its address and ID; no token is kept.
// Every session carries its own account token (and only the owner's account can
// sign in), so nothing else needs one stored.

import { plexDeviceHeaders, resolvePlexUrl } from './plex-connection.js';
import { safeError } from './security.js';

const RETRY_MS = 30_000;

export function createOwnerLink({
  env, collection, clientId, productName, onLinked, onOwnerToken,
  resolve = resolvePlexUrl, verifyOwner, retryMs = RETRY_MS, log = console,
}) {
  // Filled in by connect() or restore(); `url` stays null until the server is known.
  const owner = { url: null, machineIdentifier: null };
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

  // Find the owner's server with this token and save its address and ID (never the token).
  async function connect(token) {
    const url = await resolve({ token, clientId, productName, preferredUrl: env.PLEX_URL });
    const machineIdentifier = await identify(url, token);
    // A token learned from a sign-in or read back from storage must belong to the server's owner.
    if (!(await ownsServer(token, machineIdentifier))) throw new Error('This Plex account does not own that server');
    Object.assign(owner, { url, machineIdentifier });
    await save();
    stopRetrying();
    await onLinked?.(owner);
    await onOwnerToken?.(owner, token);
  }

  async function save() {
    await collection.set('owner', { url: owner.url, machineIdentifier: owner.machineIdentifier, savedAt: Date.now() });
  }

  // The owner signed in again. Their token is not kept, but it can show where the
  // server is now: if its address changed, remember the new one.
  async function refresh(token) {
    if (!owner.url) return;
    try {
      const url = await resolve({ token, clientId, productName, preferredUrl: env.PLEX_URL });
      if (url !== owner.url && await identify(url, token) === owner.machineIdentifier) {
        owner.url = url;
        await save();
      }
    } catch { /* the server may be down; the saved address stays */ }
    await onOwnerToken?.(owner, token);
  }

  function retryLater(token) {
    if (retryTimer) return;
    retryTimer = setInterval(() => { connect(token).catch(() => {}); }, retryMs);
    retryTimer.unref?.();
  }

  // At startup. A server saved by an earlier sign-in needs no network and no token.
  // An install that saved the owner's token before now uses it once to find the server,
  // after which only the address and ID are kept; if Plex is unreachable it keeps
  // trying, and the owner can also just sign in again.
  async function restore() {
    const saved = await collection.get('owner');
    if (typeof saved?.token === 'string' && saved.token) {
      try {
        return await connect(saved.token);
      } catch (error) {
        log.warn(`Could not reach Plex with the saved owner sign-in (${safeError(error)}); trying again every ${Math.round(retryMs / 1000)} seconds. The owner can also sign in again.`);
        retryLater(saved.token);
        return undefined;
      }
    }
    if (typeof saved?.url === 'string' && saved.url && typeof saved.machineIdentifier === 'string' && saved.machineIdentifier) {
      Object.assign(owner, { url: saved.url, machineIdentifier: saved.machineIdentifier });
      await onLinked?.(owner);
      return undefined;
    }
    log.log('Plex is not linked yet. Sign in with the PLEX_EMAIL account to finish setting it up.');
    return undefined;
  }

  return { owner, connect, refresh, restore, stopRetrying };
}
