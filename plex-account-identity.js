import crypto from 'node:crypto';

// Resolve the account that authenticated, rather than its selected Home profile.
export function createPlexIdentityLookup({ fetchImpl = fetch, headers = {}, now = Date.now } = {}) {
  const cache = new Map();
  return async accountToken => {
    if (!accountToken) return null;
    const key = crypto.createHash('sha256').update(accountToken).digest('hex');
    const existing = cache.get(key);
    if (existing && existing.expires > now()) return existing.promise;
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    const promise = (async () => {
      const response = await fetchImpl('https://plex.tv/api/v2/user', {
        headers: { ...headers, Accept: 'application/json', 'X-Plex-Token': accountToken },
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel?.();
        throw new Error('Unable to verify Plex account');
      }
      const user = await response.json();
      if (!/^\d+$/.test(String(user.id || ''))) throw new Error('Invalid Plex account identity');
      const confirmedEmail = user.confirmed === true && typeof user.email === 'string'
        ? user.email.trim().toLowerCase() : null;
      const username = typeof user.username === 'string' ? user.username.trim().slice(0, 120) : '';
      return { id: String(user.id), confirmedEmail, username };
    })().catch(error => { cache.delete(key); throw error; });
    cache.set(key, { promise, expires: now() + 300000 });
    return promise;
  };
}

export function createPlexAccountLookup(options) {
  const lookup = createPlexIdentityLookup(options);
  return async token => (await lookup(token))?.id ?? null;
}
